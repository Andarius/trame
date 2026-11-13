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
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
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
/// All of an instance's memories and tables together.
const MEMORY_BUDGET: usize = 256 << 20;
const BODY_LIMIT: usize = 32 << 20;

/// The installed packages' folder.
pub fn dir(root: &Path) -> PathBuf {
    root.join("plugins/wasm")
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

/// What a call's host imports reach: the plugin's own settings slice, its hosts, the db.
struct Scope {
    id: &'static str,
    hosts: Vec<String>,
    native: Option<Native>,
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
            .ok_or_else(|| "not available while loading".to_owned())
    }
}

/// `work` on a db connection, off the runtime; takes the `Native`, not the state (not `Sync`).
async fn with_db<T: Send + 'static>(
    native: Result<Native, String>,
    work: impl FnOnce(&mut Db) -> Result<T> + Send + 'static,
) -> Result<T, String> {
    let native = native?;
    crate::blocking::spawn(move || {
        let mut db = Db::connect(
            &native.root.join("socket"),
            &native.origin,
            Some(native.settings.clone()),
        )?;
        db.exclusive(work)
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
            return Err(format!(
                "{} is not in the plugin's hosts",
                url.host_str().unwrap_or("")
            ));
        }
        fetch(self.scope.hosts.clone(), url, req)
            .await
            .map_err(|e| format!("{e:#}"))
    }

    async fn apply(&mut self, plan: String) -> Result<String, String> {
        let plan: Vec<Write> = serde_json::from_str(&plan).map_err(|e| format!("bad plan: {e}"))?;
        with_db(self.native(), move |db| api::apply(db, &plan))
            .await
            .map(|out| Value::Array(out).to_string())
    }

    async fn get_page(&mut self, id: String) -> Result<String, String> {
        with_db(self.native(), move |db| crate::pages::get(db, &id))
            .await
            .map(|page| page.to_string())
    }

    async fn read_database(&mut self, id: String) -> Result<String, String> {
        match with_db(self.native(), move |db| crate::udb::read(db, &id)).await? {
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

/// `url` is on the allowlist: its host, exactly, over http(s).
fn allowed(hosts: &[String], url: &reqwest::Url) -> bool {
    matches!(url.scheme(), "https" | "http")
        && url
            .host_str()
            .is_some_and(|h| hosts.iter().any(|allowed| allowed.eq_ignore_ascii_case(h)))
}

async fn fetch(
    hosts: Vec<String>,
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
        .timeout(crate::cli::NETWORK_TIMEOUT)
        .build()?;
    let method = reqwest::Method::from_bytes(req.method.as_bytes())?;
    let mut builder = client.request(method, url);
    for h in req.headers {
        builder = builder.header(h.name, h.value);
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

/// One export call; [`WasmPlugin::run`] instantiates, calls and answers with the matching [`Out`].
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

/// A loaded package; every call runs in a fresh instance, so a trap never poisons the next one.
pub struct WasmPlugin {
    pre: bindings::PluginPre<State>,
    manifest: Manifest,
    native: OnceLock<Native>,
    dir: PathBuf,
}

struct Manifest {
    id: &'static str,
    label: &'static str,
    glyph: &'static str,
    description: &'static str,
    version: Option<(&'static str, &'static str)>,
    commands: &'static [CliCommand],
    hosts: Vec<String>,
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
            hosts: m.hosts,
            tick: m.tick_secs.map(|s| Duration::from_secs(s.max(1).into())),
        }
    }
}

async fn run(pre: &bindings::PluginPre<State>, scope: Arc<Scope>, call: Call) -> Result<Out> {
    let id = scope.id;
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
    match tokio::time::timeout(CALL_TIMEOUT, work).await {
        Ok(out) => out.map_err(|e| anyhow!("plugin {id} failed: {e:#}")),
        Err(_) => bail!("plugin {id} timed out after {}s", CALL_TIMEOUT.as_secs()),
    }
}

impl WasmPlugin {
    /// Compiles and checks one package folder; the folder name must be the manifest's id.
    pub async fn load(dir: PathBuf) -> Result<Self> {
        let file = dir.join("plugin.wasm");
        // compiling is CPU-bound
        let component = crate::blocking::spawn(move || Component::from_file(engine(), file))
            .await?
            .map_err(anyhow::Error::from)
            .with_context(|| format!("cannot compile {}", dir.display()))?;
        let mut linker = Linker::<State>::new(engine());
        wasmtime_wasi::p2::add_to_linker_async(&mut linker)?;
        bindings::Plugin::add_to_linker::<_, wasmtime::component::HasSelf<State>>(
            &mut linker,
            |s| s,
        )?;
        let pre = bindings::PluginPre::new(linker.instantiate_pre(&component)?)?;
        let folder = dir.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let scope = Arc::new(Scope {
            id: leak(folder.to_owned()),
            hosts: Vec::new(),
            native: None,
        });
        let Out::Manifest(manifest) = run(&pre, scope, Call::Manifest).await? else {
            unreachable!("manifest answers a manifest")
        };
        let manifest = Manifest::from_wit(manifest);
        if manifest.id != folder {
            bail!(
                "{}: manifest id {:?} is not the folder name",
                dir.display(),
                manifest.id
            );
        }
        Ok(Self {
            pre,
            manifest,
            native: OnceLock::new(),
            dir,
        })
    }

    /// `plugin.js` / `plugin.css` beside the component, if the package ships a frontend.
    pub fn web_file(&self, ext: &str) -> PathBuf {
        self.dir.join(format!("plugin.{ext}"))
    }

    async fn run(&self, call: Call) -> Result<Out> {
        let scope = Arc::new(Scope {
            id: self.manifest.id,
            hosts: self.manifest.hosts.clone(),
            native: self.native.get().cloned(),
        });
        run(&self.pre, scope, call).await
    }

    /// `sanitize` / `settings-view` for the trait's synchronous methods.
    fn json_call(&self, call: Call) -> Value {
        // the trait calls these from async handlers and blocking threads alike
        let out = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(self.run(call))
        });
        let parsed = match out {
            Ok(Out::Json(s)) => serde_json::from_str(&s).map_err(anyhow::Error::from),
            Ok(_) => unreachable!("settings calls answer JSON"),
            Err(e) => Err(e),
        };
        parsed.unwrap_or_else(|e| {
            eprintln!("plugin {}: {e:#}", self.manifest.id);
            json!({})
        })
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
        self.json_call(Call::Sanitize(raw.to_string(), current.to_string()))
    }
    fn settings_view(&self, slice: &Value) -> Value {
        self.json_call(Call::SettingsView(slice.to_string()))
    }
    fn route(&'static self, _native: Native, sub: String, req: Request<Body>) -> RouteFuture {
        Box::pin(async move {
            let out = match into_request(sub, req).await {
                Ok(req) => self.run(Call::Route(req)).await,
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
        let _ = self.native.set(native.clone());
        let every = self.manifest.tick?;
        Some(tokio::spawn(async move {
            let mut interval = tokio::time::interval(every);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                interval.tick().await;
                if crate::settings::plugin(&native.settings, self.manifest.id)["enabled"] != true {
                    continue;
                }
                if let Err(e) = self.run(Call::Tick).await {
                    eprintln!("{e:#}");
                }
            }
        }))
    }
    fn commands(&self) -> &'static [CliCommand] {
        self.manifest.commands
    }
    fn command(&'static self, _native: Native, name: String, args: Vec<String>) -> CliFuture {
        Box::pin(async move {
            match self.run(Call::Command(name, args)).await {
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

/// Every package under [`dir`]; a broken one is reported and skipped, as is one whose id is taken.
pub async fn load_all(root: &Path, taken: &[&str]) -> Vec<WasmPlugin> {
    let Ok(entries) = std::fs::read_dir(dir(root)) else {
        return Vec::new();
    };
    let mut loaded: Vec<WasmPlugin> = Vec::new();
    let mut folders: Vec<_> = entries
        .filter_map(|e| Some(e.ok()?.path()))
        .filter(|p| p.join("plugin.wasm").is_file())
        .collect();
    folders.sort();
    for folder in folders {
        let shown = folder.display().to_string();
        match WasmPlugin::load(folder).await {
            Ok(p)
                if taken.contains(&p.manifest.id)
                    || loaded.iter().any(|l| l.manifest.id == p.manifest.id) =>
            {
                eprintln!("plugin {}: id already taken, skipped", p.manifest.id);
            }
            Ok(p) => loaded.push(p),
            Err(e) => eprintln!("plugin {shown}: {e:#}"),
        }
    }
    loaded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fetch_reaches_only_listed_hosts_over_http() {
        let hosts = vec!["api.example.com".to_owned()];
        for (url, ok) in [
            ("https://api.example.com/v1", true),
            ("http://API.example.com/", true),
            ("https://evil.example.com/", false),
            ("https://api.example.com.evil.io/", false),
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
