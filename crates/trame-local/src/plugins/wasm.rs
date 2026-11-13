// WebAssembly plugins: components implementing wit/plugin.wit, loaded at boot from
// <root>/plugins/wasm/<id>/plugin.wasm, so a plugin ships without rebuilding Trame.
use super::api::{self, CliCommand, CliFuture, CliReply, RouteFuture, Write};
use crate::{db::Db, routes::Native};
use anyhow::{Context, Result, anyhow, bail};
use axum::{
    body::Body,
    http::{HeaderName, HeaderValue, Request},
    response::Response,
};
use serde_json::{Value, json};
use std::{
    hash::{Hash, Hasher},
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use wasmtime::{
    Config, Engine, ResourceLimiter, Store,
    component::{Component, Linker, ResourceTable},
};
use wasmtime_wasi::{WasiCtx, WasiCtxView, WasiView};

mod bindings {
    wasmtime::component::bindgen!({
        path: "wit",
        world: "plugin",
        imports: { default: async },
        exports: { default: async },
    });
}
use bindings::trame::plugin::{host, types};

const EPOCH_TICK: Duration = Duration::from_millis(100);
/// A whole call (instantiation, guest code, host imports) past this is dropped.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// Below [`CALL_TIMEOUT`], so a slow host reads as a fetch error, not a plugin timeout.
const FETCH_TIMEOUT: Duration = Duration::from_secs(25);
/// All of an instance's memories and tables together.
const MEMORY_BUDGET: usize = 256 << 20;
const BODY_LIMIT: usize = 32 << 20;
const PACKAGE_LIMIT: u64 = 64 << 20;
/// Calls of one plugin running at once; the rest wait.
const CONCURRENT_CALLS: usize = 4;
// headers a guest neither sees nor sets: the app's own credentials and framing
const HIDDEN_REQUEST_HEADERS: [&str; 4] =
    ["host", "cookie", "authorization", "proxy-authorization"];
const HOST_SET_RESPONSE_HEADERS: [&str; 3] = ["content-length", "transfer-encoding", "connection"];

/// The installed packages' folder.
pub fn dir(root: &Path) -> PathBuf {
    root.join("plugins/wasm")
}

fn cache_dir(root: &Path) -> PathBuf {
    root.join("plugins/wasm-cache")
}

fn call_timeout() -> Duration {
    // tests shorten it
    #[cfg(debug_assertions)]
    if let Some(ms) = std::env::var("TRAME_WASM_CALL_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse().ok())
    {
        return Duration::from_millis(ms);
    }
    CALL_TIMEOUT
}

fn engine() -> &'static Engine {
    static ENGINE: OnceLock<Engine> = OnceLock::new();
    ENGINE.get_or_init(|| {
        let mut config = Config::new();
        config.epoch_interruption(true);
        let engine = Engine::new(&config).expect("wasmtime config is valid");
        let ticker = engine.weak();
        std::thread::spawn(move || {
            while let Some(engine) = ticker.upgrade() {
                engine.increment_epoch();
                drop(engine);
                std::thread::sleep(EPOCH_TICK);
            }
        });
        engine
    })
}

/// Caps the instance's memories and tables together, not each one.
struct Budget {
    used: usize,
}

impl Budget {
    fn grow(&mut self, current: usize, desired: usize) -> bool {
        let next = self.used - current.min(self.used) + desired;
        if next > MEMORY_BUDGET {
            return false;
        }
        self.used = next;
        true
    }
}

impl ResourceLimiter for Budget {
    fn memory_growing(
        &mut self,
        current: usize,
        desired: usize,
        _max: Option<usize>,
    ) -> wasmtime::Result<bool> {
        Ok(self.grow(current, desired))
    }
    fn table_growing(
        &mut self,
        current: usize,
        desired: usize,
        _max: Option<usize>,
    ) -> wasmtime::Result<bool> {
        // a table slot is a pointer
        let slot = size_of::<usize>();
        Ok(self.grow(current * slot, desired * slot))
    }
    fn instances(&self) -> usize {
        64
    }
    fn tables(&self) -> usize {
        64
    }
    fn memories(&self) -> usize {
        8
    }
}

/// A manifest `hosts` entry: `name` (default port only) or `name:port`.
#[derive(Debug, Clone, PartialEq)]
struct Allowed {
    host: String,
    port: Option<u16>,
}

impl Allowed {
    fn parse(entry: &str) -> Self {
        let entry = entry.to_ascii_lowercase();
        match entry
            .rsplit_once(':')
            .and_then(|(h, p)| Some((h.to_owned(), p.parse().ok()?)))
        {
            Some((host, port)) => Self {
                host,
                port: Some(port),
            },
            None => Self {
                host: entry,
                port: None,
            },
        }
    }
}

/// Only public addresses: never this machine, its LAN, or a cloud metadata endpoint.
fn public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_documentation()
                // shared address space (CGNAT)
                || a == 100 && b & 0xc0 == 64)
        }
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => public(IpAddr::V4(v4)),
            None => {
                !(v6.is_loopback()
                    || v6.is_unspecified()
                    || v6.is_unique_local()
                    || v6.is_unicast_link_local())
            }
        },
    }
}

/// `url` may be fetched: http(s), a listed host and port, not a private address or `localhost`.
fn allowed(hosts: &[Allowed], url: &reqwest::Url) -> bool {
    if !matches!(url.scheme(), "https" | "http") {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let name = host.trim_matches(['[', ']']).to_ascii_lowercase();
    let local = match name.parse::<IpAddr>() {
        Ok(ip) => !public(ip),
        Err(_) => name == "localhost" || name.ends_with(".localhost"),
    };
    !local
        && hosts.iter().any(|a| {
            a.host.trim_matches(['[', ']']) == name
                && match a.port {
                    Some(port) => url.port_or_known_default() == Some(port),
                    None => url.port().is_none(),
                }
        })
}

/// Resolves names to public addresses only, so a listed name cannot be pointed at this machine.
struct PublicDns;

impl reqwest::dns::Resolve for PublicDns {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0))
                .await?
                .filter(|a| public(a.ip()))
                .collect();
            if addrs.is_empty() {
                return Err(format!("{host} has no public address").into());
            }
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// What a call's host imports reach: the plugin's own settings slice, its hosts, the db.
struct Scope {
    id: &'static str,
    hosts: Arc<[Allowed]>,
    native: Option<Native>,
    /// Set once the call ends or is dropped (timeout, client gone): a write not yet started is skipped.
    cancelled: Arc<AtomicBool>,
}

struct State {
    wasi: WasiCtx,
    table: ResourceTable,
    budget: Budget,
    scope: Arc<Scope>,
}

impl WasiView for State {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

impl State {
    fn native(&self) -> Result<Native, String> {
        self.scope
            .native
            .clone()
            .ok_or_else(|| "not available here".to_owned())
    }
}

/// `work` on a db connection, off the runtime; skipped if the call was dropped before it got the
/// db. Takes owned values, not the state (not `Sync`).
async fn with_db<T: Send + 'static>(
    native: Result<Native, String>,
    cancelled: Arc<AtomicBool>,
    work: impl FnOnce(&mut Db) -> Result<T> + Send + 'static,
) -> Result<T, String> {
    let native = native?;
    crate::blocking::spawn(move || {
        let mut db = Db::connect(
            &native.root.join("socket"),
            &native.origin,
            Some(native.settings.clone()),
        )?;
        db.exclusive(|db| {
            if cancelled.load(Ordering::SeqCst) {
                bail!("call cancelled before its write");
            }
            work(db)
        })
    })
    .await
    .map_err(|_| "db task failed".to_owned())?
    .map_err(|e| format!("{e:#}"))
}

impl types::Host for State {}

impl host::Host for State {
    async fn settings(&mut self) -> String {
        let (Ok(native), id) = (self.native(), self.scope.id) else {
            return "{}".to_owned();
        };
        // a file read: off the runtime
        crate::blocking::spawn(move || crate::settings::plugin(&native.settings, id).to_string())
            .await
            .unwrap_or_else(|_| "{}".to_owned())
    }

    async fn fetch(&mut self, req: types::HttpRequest) -> Result<types::HttpResponse, String> {
        let url = reqwest::Url::parse(&req.url).map_err(|e| format!("bad url: {e}"))?;
        if !allowed(&self.scope.hosts, &url) {
            return Err(format!("{url} is not in the plugin's hosts"));
        }
        fetch(self.scope.hosts.clone(), url, req)
            .await
            .map_err(|e| format!("{e:#}"))
    }

    async fn apply(&mut self, plan: String) -> Result<String, String> {
        let plan: Vec<Write> = serde_json::from_str(&plan).map_err(|e| format!("bad plan: {e}"))?;
        with_db(self.native(), self.scope.cancelled.clone(), move |db| {
            api::apply(db, &plan)
        })
        .await
        .map(|out| Value::Array(out).to_string())
    }

    async fn get_page(&mut self, id: String) -> Result<String, String> {
        with_db(self.native(), self.scope.cancelled.clone(), move |db| {
            crate::pages::get(db, &id)
        })
        .await
        .map(|page| page.to_string())
    }

    async fn read_database(&mut self, id: String) -> Result<String, String> {
        let read = with_db(self.native(), self.scope.cancelled.clone(), move |db| {
            crate::udb::read(db, &id)
        });
        match read.await? {
            (200, value) => Ok(value.to_string()),
            (_, value) => Err(value["error"].as_str().unwrap_or("not found").to_owned()),
        }
    }

    #[allow(
        clippy::unused_async_trait_impl,
        reason = "the bindings make every import async"
    )]
    async fn log(&mut self, message: String) {
        eprintln!("plugin {}: {message}", self.scope.id);
    }
}

async fn fetch(
    hosts: Arc<[Allowed]>,
    url: reqwest::Url,
    req: types::HttpRequest,
) -> Result<types::HttpResponse> {
    // a redirect must not leave the allowlist either
    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= 5 || !allowed(&hosts, attempt.url()) {
            attempt.stop()
        } else {
            attempt.follow()
        }
    });
    let client = reqwest::Client::builder()
        .redirect(policy)
        .dns_resolver(Arc::new(PublicDns))
        .no_proxy()
        .timeout(FETCH_TIMEOUT)
        .build()?;
    let method = reqwest::Method::from_bytes(req.method.as_bytes())?;
    let mut builder = client.request(method, url);
    for h in req.headers {
        if !HIDDEN_REQUEST_HEADERS.contains(&h.name.to_ascii_lowercase().as_str()) {
            builder = builder.header(h.name, h.value);
        }
    }
    let mut res = builder.body(req.body).send().await?;
    let status = res.status().as_u16();
    let headers = res
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            Some(types::Header {
                name: name.as_str().to_owned(),
                value: value.to_str().ok()?.to_owned(),
            })
        })
        .collect();
    let mut body = Vec::new();
    while let Some(chunk) = res.chunk().await? {
        if body.len() + chunk.len() > BODY_LIMIT {
            bail!("response over {BODY_LIMIT} bytes");
        }
        body.extend_from_slice(&chunk);
    }
    Ok(types::HttpResponse {
        status,
        headers,
        body,
    })
}

/// One export call; [`run`] instantiates, calls and answers with the matching [`Out`].
enum Call {
    Manifest,
    Sanitize(String, String),
    SettingsView(String),
    Route(types::HttpRequest),
    Command(String, Vec<String>),
    Tick,
}

enum Out {
    Manifest(types::Manifest),
    Json(String),
    Route(types::HttpResponse),
    Reply(types::CliReply),
    Unit,
}

/// Marks the call cancelled when it ends, finished or dropped.
struct CancelOnDrop(Arc<AtomicBool>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

async fn run(pre: &bindings::PluginPre<State>, scope: Arc<Scope>, call: Call) -> Result<Out> {
    let id = scope.id;
    let _cancel = CancelOnDrop(scope.cancelled.clone());
    let mut wasi = WasiCtx::builder();
    wasi.inherit_stderr();
    let state = State {
        wasi: wasi.build(),
        table: ResourceTable::new(),
        budget: Budget { used: 0 },
        scope,
    };
    let mut store = Store::new(pre.engine(), state);
    store.limiter(|s| &mut s.budget);
    // yield to the runtime every tick, so the timeout below can drop a busy guest
    store.epoch_deadline_async_yield_and_update(1);
    let work = async {
        let p = pre.instantiate_async(&mut store).await?;
        let s = &mut store;
        wasmtime::Result::<Out>::Ok(match call {
            Call::Manifest => Out::Manifest(p.call_manifest(s).await?),
            Call::Sanitize(raw, current) => Out::Json(p.call_sanitize(s, &raw, &current).await?),
            Call::SettingsView(slice) => Out::Json(p.call_settings_view(s, &slice).await?),
            Call::Route(req) => Out::Route(p.call_route(s, &req).await?),
            Call::Command(name, args) => Out::Reply(p.call_command(s, &name, &args).await?),
            Call::Tick => {
                p.call_tick(s).await?;
                Out::Unit
            }
        })
    };
    let limit = call_timeout();
    match tokio::time::timeout(limit, work).await {
        Ok(out) => out.map_err(|e| anyhow!("plugin {id} failed: {e:#}")),
        Err(_) => bail!("plugin {id} timed out after {}ms", limit.as_millis()),
    }
}

/// A loaded package; every call runs in a fresh instance, so a trap never poisons the next one.
pub struct WasmPlugin {
    pre: bindings::PluginPre<State>,
    manifest: Manifest,
    dir: PathBuf,
    slots: tokio::sync::Semaphore,
    /// The backend run's context, for the synchronous settings calls.
    native: std::sync::RwLock<Option<Native>>,
}

struct Manifest {
    id: &'static str,
    label: &'static str,
    glyph: &'static str,
    description: &'static str,
    version: Option<(&'static str, &'static str)>,
    commands: &'static [CliCommand],
    hosts: Vec<String>,
    allowed: Arc<[Allowed]>,
    tick: Option<Duration>,
}

fn leak(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

impl Manifest {
    fn from_wit(m: types::Manifest) -> Self {
        let commands = m
            .commands
            .into_iter()
            .map(|c| CliCommand {
                name: leak(c.name),
                usage: leak(c.usage),
                summary: leak(c.summary),
            })
            .collect::<Vec<_>>();
        Self {
            id: leak(m.id),
            label: leak(m.label),
            glyph: leak(m.glyph),
            description: leak(m.description),
            version: m.version.zip(m.repo).map(|(v, r)| (leak(v), leak(r))),
            commands: Box::leak(commands.into_boxed_slice()),
            allowed: m.hosts.iter().map(|h| Allowed::parse(h)).collect(),
            hosts: m.hosts,
            tick: m.tick_secs.map(|s| Duration::from_secs(s.max(1).into())),
        }
    }
}

/// The compiled component, from the cache when this exact package was compiled by this engine.
fn compile(root: &Path, folder: &str, file: &Path) -> Result<Component> {
    use sha2::Digest;
    let bytes = std::fs::read(file)?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    engine().precompile_compatibility_hash().hash(&mut hasher);
    let digest = sha2::Sha256::digest(&bytes)[..12]
        .iter()
        .fold(String::new(), |mut hex, b| {
            use std::fmt::Write as _;
            let _ = write!(hex, "{b:02x}");
            hex
        });
    let key = format!("{folder}-{digest}-{:016x}", hasher.finish());
    let cache = cache_dir(root);
    let cached = cache.join(format!("{key}.cwasm"));
    if cached.is_file() {
        // SAFETY: only Trame writes this folder, from `Component::serialize` on this engine
        #[allow(unsafe_code, reason = "deserializing our own precompiled cache")]
        match unsafe { Component::deserialize_file(engine(), &cached) } {
            Ok(component) => return Ok(component),
            Err(e) => eprintln!("plugin {folder}: stale cache ({e:#}), recompiling"),
        }
    }
    let component = Component::new(engine(), &bytes).map_err(anyhow::Error::from)?;
    // a failed cache write only costs the next boot a compile
    let prefix = format!("{folder}-");
    let _ = (|| -> Result<()> {
        std::fs::create_dir_all(&cache)?;
        for old in std::fs::read_dir(&cache)?.flatten() {
            if old.file_name().to_string_lossy().starts_with(&prefix) {
                std::fs::remove_file(old.path())?;
            }
        }
        let tmp = cache.join(format!("{key}.tmp"));
        std::fs::write(&tmp, component.serialize().map_err(anyhow::Error::from)?)?;
        std::fs::rename(tmp, cached)?;
        Ok(())
    })();
    Ok(component)
}

impl WasmPlugin {
    /// Compiles and checks one package folder; the folder name must be the manifest's id.
    async fn load(root: &Path, dir: PathBuf) -> Result<Self> {
        let folder = dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_owned();
        let file = dir.join("plugin.wasm");
        if std::fs::metadata(&file)?.len() > PACKAGE_LIMIT {
            bail!("plugin.wasm over {PACKAGE_LIMIT} bytes");
        }
        let (root, name) = (root.to_owned(), folder.clone());
        // compiling is CPU-bound
        let component = crate::blocking::spawn(move || compile(&root, &name, &file))
            .await?
            .context("cannot compile plugin.wasm")?;
        let mut linker = Linker::<State>::new(engine());
        wasmtime_wasi::p2::add_to_linker_async(&mut linker)?;
        bindings::Plugin::add_to_linker::<_, wasmtime::component::HasSelf<State>>(
            &mut linker,
            |s| s,
        )?;
        let pre = bindings::PluginPre::new(
            linker
                .instantiate_pre(&component)
                .map_err(anyhow::Error::from)
                .context("does not match this Trame's wit/plugin.wit")?,
        )?;
        let scope = Arc::new(Scope {
            id: leak(folder.clone()),
            hosts: Arc::new([]),
            native: None,
            cancelled: Arc::default(),
        });
        let Out::Manifest(manifest) = run(&pre, scope, Call::Manifest).await? else {
            unreachable!("manifest answers a manifest")
        };
        let manifest = Manifest::from_wit(manifest);
        if manifest.id != folder {
            bail!("manifest id {:?} is not the folder name", manifest.id);
        }
        Ok(Self {
            pre,
            manifest,
            dir,
            slots: tokio::sync::Semaphore::new(CONCURRENT_CALLS),
            native: std::sync::RwLock::default(),
        })
    }

    /// `plugin.<ext>` beside the component, if the package ships that part of a frontend.
    pub fn web_file(&self, ext: &str) -> Option<PathBuf> {
        Some(self.dir.join(format!("plugin.{ext}"))).filter(|p| p.is_file())
    }

    /// What the plugins page shows besides the shared manifest fields.
    pub fn extra_manifest(&self) -> Value {
        json!({"web": self.web_file("js").is_some(), "hosts": self.manifest.hosts})
    }

    async fn run(&self, native: Option<Native>, call: Call) -> Result<Out> {
        let _slot = self.slots.acquire().await?;
        let scope = Arc::new(Scope {
            id: self.manifest.id,
            hosts: self.manifest.allowed.clone(),
            native,
            cancelled: Arc::default(),
        });
        run(&self.pre, scope, call).await
    }

    /// `sanitize` / `settings-view` for the trait's synchronous methods: a JSON object, or the error.
    fn json_call(&self, call: Call) -> Result<Value> {
        let native = self.native.read().ok().and_then(|n| n.clone());
        let Out::Json(text) = block_on(self.run(native, call))? else {
            unreachable!("settings calls answer JSON")
        };
        match serde_json::from_str(&text)? {
            value @ Value::Object(_) => Ok(value),
            other => bail!("expected a JSON object, got {other}"),
        }
    }
}

/// Runs `fut` to completion from synchronous code on any thread: a multi-thread runtime's
/// worker, a blocking thread, a current-thread runtime (tests) or no runtime at all.
fn block_on<T: Send>(fut: impl Future<Output = T> + Send) -> T {
    use tokio::runtime::{Handle, RuntimeFlavor};
    match Handle::try_current() {
        Ok(h) if h.runtime_flavor() == RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(|| h.block_on(fut))
        }
        _ => std::thread::scope(|s| {
            s.spawn(|| {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("a runtime starts")
                    .block_on(fut)
            })
            .join()
            .expect("plugin call thread")
        }),
    }
}

async fn into_request(sub: String, req: Request<Body>) -> Result<types::HttpRequest> {
    let method = req.method().as_str().to_owned();
    let url = match req.uri().query() {
        Some(q) => format!("{sub}?{q}"),
        None => sub,
    };
    let headers = req
        .headers()
        .iter()
        .filter(|(name, _)| !HIDDEN_REQUEST_HEADERS.contains(&name.as_str()))
        .filter_map(|(name, value)| {
            Some(types::Header {
                name: name.as_str().to_owned(),
                value: value.to_str().ok()?.to_owned(),
            })
        })
        .collect();
    let body = axum::body::to_bytes(req.into_body(), BODY_LIMIT)
        .await?
        .to_vec();
    Ok(types::HttpRequest {
        method,
        url,
        headers,
        body,
    })
}

fn into_response(res: types::HttpResponse) -> Response {
    let mut out = Response::new(Body::from(res.body));
    *out.status_mut() = axum::http::StatusCode::from_u16(res.status)
        .unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR);
    for h in res.headers {
        if HOST_SET_RESPONSE_HEADERS.contains(&h.name.to_ascii_lowercase().as_str()) {
            continue;
        }
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(h.name.as_bytes()),
            HeaderValue::from_str(&h.value),
        ) {
            out.headers_mut().append(name, value);
        }
    }
    out
}

impl api::Plugin for WasmPlugin {
    fn id(&self) -> &'static str {
        self.manifest.id
    }
    fn label(&self) -> &'static str {
        self.manifest.label
    }
    fn glyph(&self) -> &'static str {
        self.manifest.glyph
    }
    fn description(&self) -> &'static str {
        self.manifest.description
    }
    fn version(&self) -> Option<(&'static str, &'static str)> {
        self.manifest.version
    }
    fn sanitize(&self, raw: &Value, current: &Value) -> Value {
        // nothing is saved when the plugin fails: the slice keeps its current values
        self.json_call(Call::Sanitize(raw.to_string(), current.to_string()))
            .unwrap_or_else(|e| {
                eprintln!("plugin {} sanitize: {e:#}", self.manifest.id);
                json!({})
            })
    }
    fn settings_view(&self, slice: &Value) -> Value {
        self.json_call(Call::SettingsView(slice.to_string()))
            .unwrap_or_else(|e| json!({"error": format!("{e:#}")}))
    }
    fn route(&'static self, native: Native, sub: String, req: Request<Body>) -> RouteFuture {
        Box::pin(async move {
            let out = match into_request(sub, req).await {
                Ok(req) => self.run(Some(native), Call::Route(req)).await,
                Err(e) => Err(e),
            };
            match out {
                Ok(Out::Route(res)) => into_response(res),
                Ok(_) => unreachable!("route answers a response"),
                Err(e) => api::json_response(500, json!({"error": format!("{e:#}")})),
            }
        })
    }
    fn start(&'static self, native: Native) -> Option<tokio::task::JoinHandle<()>> {
        if let Ok(mut current) = self.native.write() {
            *current = Some(native.clone());
        }
        let every = self.manifest.tick?;
        Some(tokio::spawn(async move {
            let mut interval = tokio::time::interval(every);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                interval.tick().await;
                if crate::settings::plugin(&native.settings, self.manifest.id)["enabled"] != true {
                    continue;
                }
                if let Err(e) = self.run(Some(native.clone()), Call::Tick).await {
                    eprintln!("{e:#}");
                }
            }
        }))
    }
    fn commands(&self) -> &'static [CliCommand] {
        self.manifest.commands
    }
    fn command(&'static self, native: Native, name: String, args: Vec<String>) -> CliFuture {
        Box::pin(async move {
            match self.run(Some(native), Call::Command(name, args)).await {
                Ok(Out::Reply(reply)) => CliReply {
                    code: reply.code,
                    text: reply.text,
                    json: serde_json::from_str(&reply.json).unwrap_or(Value::Null),
                },
                Ok(_) => unreachable!("command answers a reply"),
                Err(e) => CliReply::fail(format!("{e:#}")),
            }
        })
    }
}

/// The packages under [`dir`] that loaded, and `(folder, error)` for those that did not.
pub async fn load_all(root: &Path, taken: &[&str]) -> (Vec<WasmPlugin>, Vec<(String, String)>) {
    let mut loaded: Vec<WasmPlugin> = Vec::new();
    let mut failed = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir(root)) else {
        return (loaded, failed);
    };
    let mut folders: Vec<_> = entries
        .filter_map(|e| Some(e.ok()?.path()))
        .filter(|p| p.join("plugin.wasm").is_file())
        .collect();
    folders.sort();
    for folder in folders {
        let name = folder
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        // the folder is the id: a clash needs no compile
        if taken.contains(&name.as_str()) {
            failed.push((name, "id already taken by a built-in plugin".to_owned()));
            continue;
        }
        match WasmPlugin::load(root, folder).await {
            Ok(p) => loaded.push(p),
            Err(e) => {
                eprintln!("plugin {name}: {e:#}");
                failed.push((name, format!("{e:#}")));
            }
        }
    }
    (loaded, failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fetch_reaches_only_listed_public_hosts_and_ports() {
        let hosts: Vec<_> = [
            "api.example.com",
            "data.example.com:8443",
            "127.0.0.1",
            "8.8.8.8",
        ]
        .map(Allowed::parse)
        .into();
        for (url, ok) in [
            ("https://api.example.com/v1", true),
            ("http://API.example.com/", true),
            ("https://api.example.com:8443/", false),
            ("https://data.example.com:8443/x", true),
            ("https://data.example.com/", false),
            ("https://evil.example.com/", false),
            ("https://api.example.com.evil.io/", false),
            ("http://8.8.8.8/", true),
            ("http://127.0.0.1/", false),
            ("http://localhost/", false),
            ("http://[::1]/", false),
            ("http://10.0.0.1/", false),
            ("http://169.254.169.254/", false),
            ("file:///etc/passwd", false),
            ("ftp://api.example.com/", false),
        ] {
            assert_eq!(
                allowed(&hosts, &reqwest::Url::parse(url).unwrap()),
                ok,
                "{url}"
            );
        }
    }

    #[test]
    fn block_on_runs_from_any_thread_or_runtime() {
        let work = || {
            block_on(async {
                tokio::task::yield_now().await;
                7
            })
        };
        assert_eq!(work(), 7, "no runtime");
        for runtime in [
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap(),
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .unwrap(),
        ] {
            assert_eq!(
                runtime.block_on(async { work() }),
                7,
                "{:?}",
                runtime.handle().runtime_flavor()
            );
        }
    }

    #[test]
    fn the_budget_spans_every_memory_and_table() {
        let mut b = Budget { used: 0 };
        assert!(b.grow(0, MEMORY_BUDGET / 2));
        assert!(b.grow(0, MEMORY_BUDGET / 2));
        // a third region, or growing one past the total, is refused
        assert!(!b.grow(0, 1));
        assert!(!b.grow(MEMORY_BUDGET / 2, MEMORY_BUDGET / 2 + 1));
        assert!(b.grow(MEMORY_BUDGET / 2, MEMORY_BUDGET / 4));
    }
}
