// JupyterLab inside Trame: the plugin owns (or attaches to) a Jupyter server and
// proxies it same-origin under /api/plugins/notebook/j/, so the Lab iframe needs
// no CSP exception and the token never reaches the page.
#![allow(
    unsafe_code,
    reason = "libc::kill for server liveness and stopping a spawned server's process group"
)]

use crate::{db::Db, routes::Native, settings};
use anyhow::{Context, Result, anyhow, bail};
use axum::{
    body::Body,
    extract::{
        FromRequest,
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, HeaderName, HeaderValue, Request, StatusCode, header},
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};
use tokio_tungstenite::tungstenite;

pub const ID: &str = "notebook";
/// Local mount of the proxied server; a spawned server uses it as its `base_url`.
pub const PREFIX: &str = "/api/plugins/notebook/j/";
const LOG_LINES: usize = 80;
const START_TIMEOUT: Duration = Duration::from_mins(3);
const THEMES_SETTING: &str = "lab/api/settings/@jupyterlab/apputils-extension:themes";
/// Lab workspace the iframe uses: one notebook, no chrome. "Open in browser" uses the default one.
const WORKSPACE: &str = "trame";
/// Runs inside the embedded Lab once it is restored: single-document mode, no rails, header or status bar.
const EMBED_SCRIPT: &str = "<script>(function(){var n=0;function hide(w){if(w&&!w.isHidden){w.hide();}}function apply(s){try{if(s.mode!=='single-document'){s.mode='single-document';}}catch(e){}['left','right'].forEach(function(side){try{if(s.isSideTabBarVisible&&s.isSideTabBarVisible(side)){s.toggleSideTabBarVisibility(side);}}catch(e){}});try{if(s.isTopInSimpleModeVisible&&s.isTopInSimpleModeVisible()){s.toggleTopInSimpleModeVisibility();}}catch(e){}['menu','bottom'].forEach(function(area){try{var it=s.widgets(area),w;while(!(w=it.next()).done){hide(w.value.parent&&w.value.parent.id==='jp-menu-panel'?w.value.parent:w.value);}}catch(e){}});}function go(){var app=window.jupyterapp;if(!app){if(n++<600){setTimeout(go,100);}return;}app.restored.then(function(){var k=0;apply(app.shell);var t=setInterval(function(){apply(app.shell);if(++k>=20){clearInterval(t);}},500);});}go();})();</script>";

#[derive(Clone)]
struct Server {
    /// Upstream origin + `base_url`, always ending with '/'.
    url: String,
    token: String,
    root_dir: Option<String>,
    /// Process-group id of a spawned server; None when attached.
    pgid: Option<i32>,
}

#[derive(Default)]
struct State {
    server: Option<Server>,
    starting: bool,
    error: Option<String>,
    log: VecDeque<String>,
}

static STATE: LazyLock<Arc<Mutex<State>>> = LazyLock::new(Arc::default);
static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .expect("reqwest client")
});

fn state() -> std::sync::MutexGuard<'static, State> {
    STATE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn json_response(status: u16, value: Value) -> Response {
    crate::routes::json_response(status, value)
}

// Settings

fn text(v: &Value) -> String {
    v.as_str().unwrap_or("").trim().to_owned()
}

pub fn sanitize(raw: &Value, current: &Value) -> Value {
    let mut out = current.clone();
    if !out.is_object() {
        out = json!({});
    }
    for key in ["command", "rootDir"] {
        if let Some(v) = raw.get(key) {
            if v.is_null() || text(v).is_empty() {
                out.as_object_mut().unwrap().remove(key);
            } else {
                out[key] = json!(text(v));
            }
        }
    }
    out
}

pub fn settings_view(slice: &Value) -> Value {
    json!({
        "enabled": slice["enabled"] == true,
        "command": slice["command"].as_str().unwrap_or(""),
        "rootDir": slice["rootDir"].as_str().unwrap_or(""),
        "defaultCommand": default_command(),
    })
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from)
}

fn default_command() -> &'static str {
    static FOUND: LazyLock<bool> = LazyLock::new(|| {
        std::env::var_os("PATH")
            .is_some_and(|p| std::env::split_paths(&p).any(|d| d.join("jupyter").is_file()))
    });
    if *FOUND {
        "jupyter lab"
    } else {
        "uvx --from jupyterlab jupyter lab"
    }
}

// Running servers (jupyter's runtime dir)

fn runtime_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("JUPYTER_RUNTIME_DIR") {
        return PathBuf::from(dir);
    }
    let data = std::env::var_os("JUPYTER_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("XDG_DATA_HOME").map(|d| PathBuf::from(d).join("jupyter")))
        .unwrap_or_else(|| home().join(".local/share/jupyter"));
    data.join("runtime")
}

fn pid_alive(pid: i64) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// jpserver-*.json entries whose process is still alive; the token stays server-side.
fn running_servers(dir: &Path, alive: impl Fn(i64) -> bool) -> Vec<Value> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut list: Vec<Value> = entries
        .flatten()
        .filter(|e| {
            let name = e.file_name();
            let name = name.to_string_lossy();
            name.starts_with("jpserver-") && name.ends_with(".json")
        })
        .filter_map(|e| std::fs::read(e.path()).ok())
        .filter_map(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(|v| v["pid"].as_i64().is_some_and(&alive))
        .map(|v| {
            json!({
                "url": normalize_url(v["url"].as_str().unwrap_or("")),
                "rootDir": v["root_dir"],
                "pid": v["pid"],
                "version": v["version"],
                "token": v["token"],
            })
        })
        .collect();
    list.sort_by_key(|v| v["pid"].as_i64());
    list
}

fn normalize_url(url: &str) -> String {
    let trimmed = url.trim();
    if trimmed.ends_with('/') {
        trimmed.to_owned()
    } else {
        format!("{trimmed}/")
    }
}

fn public(server: &Value) -> Value {
    json!({"url": server["url"], "rootDir": server["rootDir"], "pid": server["pid"], "version": server["version"]})
}

// Lifecycle

fn status(settings_path: &Path) -> Value {
    let s = state();
    let server = s.server.as_ref().map(|srv| {
        json!({
            "url": format!("{PREFIX}lab"),
            "upstream": srv.url,
            "rootDir": srv.root_dir,
            "mode": if srv.pgid.is_some() { "spawned" } else { "attached" },
        })
    });
    let running: Vec<Value> = running_servers(&runtime_dir(), pid_alive)
        .iter()
        .map(public)
        .collect();
    let slice = settings::plugin(settings_path, ID);
    json!({
        "server": server,
        "starting": s.starting,
        "error": s.error,
        "log": s.log.iter().collect::<Vec<_>>(),
        "running": running,
        "rootDir": slice["rootDir"].as_str().map_or_else(|| home().to_string_lossy().into_owned(), str::to_owned),
    })
}

async fn probe(url: &str, token: &str) -> Result<Value> {
    let response = CLIENT
        .get(format!("{url}api/status"))
        .header(header::AUTHORIZATION, format!("token {token}"))
        .timeout(Duration::from_secs(5))
        .send()
        .await?;
    if response.status() != StatusCode::OK {
        bail!("server answered {}", response.status());
    }
    Ok(response.json::<Value>().await?)
}

async fn attach(settings_path: &Path, body: &Value) -> Result<(u16, Value)> {
    let url = normalize_url(&text(&body["url"]));
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Ok((400, json!({"error": "url must be http(s)"})));
    }
    let known = running_servers(&runtime_dir(), pid_alive)
        .into_iter()
        .find(|s| s["url"] == url);
    let token = match (text(&body["token"]), &known) {
        (t, _) if !t.is_empty() => t,
        (_, Some(k)) => text(&k["token"]),
        (_, None) => {
            return Ok((
                404,
                json!({"error": "no running server with that url in jupyter's runtime dir; pass its token"}),
            ));
        }
    };
    if let Err(e) = probe(&url, &token).await {
        return Ok((502, json!({"error": format!("cannot reach {url}: {e}")})));
    }
    stop_spawned();
    let root_dir = known
        .as_ref()
        .and_then(|k| k["rootDir"].as_str())
        .map(str::to_owned);
    {
        let mut s = state();
        s.server = Some(Server {
            url: url.clone(),
            token,
            root_dir,
            pgid: None,
        });
        s.error = None;
        s.starting = false;
    }
    settings::save_plugin(settings_path, ID, &json!({"attached": url}))?;
    Ok((200, status(settings_path)))
}

/// Re-attaches to the server saved in settings when it is still running (after a Trame restart).
fn reattach_saved(settings_path: &Path) {
    let saved = text(&settings::plugin(settings_path, ID)["attached"]);
    if saved.is_empty() || state().server.is_some() || state().starting {
        return;
    }
    let Some(known) = running_servers(&runtime_dir(), pid_alive)
        .into_iter()
        .find(|s| s["url"] == saved)
    else {
        return;
    };
    state().server = Some(Server {
        url: saved,
        token: text(&known["token"]),
        root_dir: known["rootDir"].as_str().map(str::to_owned),
        pgid: None,
    });
}

fn free_port() -> Result<u16> {
    Ok(std::net::TcpListener::bind("127.0.0.1:0")?
        .local_addr()?
        .port())
}

fn push_log(line: String) {
    let mut s = state();
    if s.log.len() >= LOG_LINES {
        s.log.pop_front();
    }
    s.log.push_back(line);
}

fn start(settings_path: &Path, body: &Value) -> (u16, Value) {
    {
        let mut s = state();
        if s.starting {
            return (409, json!({"error": "already starting"}));
        }
        s.starting = true;
        s.error = None;
        s.log.clear();
    }
    stop_spawned();
    let slice = settings::plugin(settings_path, ID);
    let root_dir = match text(&body["cwd"]) {
        d if !d.is_empty() => d,
        _ => slice["rootDir"]
            .as_str()
            .map_or_else(|| home().to_string_lossy().into_owned(), str::to_owned),
    };
    let command = match text(&slice["command"]) {
        c if !c.is_empty() => c,
        _ => default_command().to_owned(),
    };
    let settings_path = settings_path.to_owned();
    tokio::spawn(async move {
        if let Err(e) = spawn_and_wait(&command, &root_dir).await {
            let mut s = state();
            s.error = Some(e.to_string());
            s.starting = false;
        } else {
            let _ = settings::save_plugin(&settings_path, ID, &json!({"attached": Value::Null}));
        }
    });
    (200, json!({"starting": true}))
}

async fn spawn_and_wait(command: &str, root_dir: &str) -> Result<()> {
    if !Path::new(root_dir).is_dir() {
        bail!("{root_dir} is not a directory");
    }
    let port = free_port()?;
    let token = uuid::Uuid::new_v4().simple().to_string();
    let url = format!("http://127.0.0.1:{port}{PREFIX}");
    let mut child = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(format!("exec {command} \"$@\""))
        .arg("jupyter")
        .args([
            "--no-browser",
            "--ip=127.0.0.1",
            &format!("--port={port}"),
            "--ServerApp.port_retries=0",
            &format!("--ServerApp.base_url={PREFIX}"),
            "--ServerApp.root_dir=.",
            "--LabApp.open_browser=False",
        ])
        .env("JUPYTER_TOKEN", &token)
        .current_dir(root_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .process_group(0)
        .spawn()
        .with_context(|| format!("cannot run `{command}`"))?;
    let pgid = i32::try_from(child.id().unwrap_or(0))?;
    if let Some(out) = child.stdout.take() {
        tail("out", out);
    }
    if let Some(err) = child.stderr.take() {
        tail("err", err);
    }
    push_log(format!(
        "[trame] $ {command} … (port {port}, in {root_dir})"
    ));
    let deadline = tokio::time::Instant::now() + START_TIMEOUT;
    loop {
        if let Some(code) = child.try_wait()? {
            bail!("jupyter exited with {code} before it was ready");
        }
        if probe(&url, &token).await.is_ok() {
            break;
        }
        if tokio::time::Instant::now() > deadline {
            let _ = child.start_kill();
            bail!(
                "jupyter did not come up within {}s",
                START_TIMEOUT.as_secs()
            );
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    // reap when it exits on its own; the handle is otherwise owned by the process group id
    tokio::spawn(async move {
        let _ = child.wait().await;
    });
    let mut s = state();
    s.server = Some(Server {
        url,
        token,
        root_dir: Some(root_dir.to_owned()),
        pgid: Some(pgid),
    });
    s.starting = false;
    Ok(())
}

fn tail(name: &'static str, out: impl tokio::io::AsyncRead + Unpin + Send + 'static) {
    tokio::spawn(async move {
        use tokio::io::AsyncBufReadExt;
        let mut lines = tokio::io::BufReader::new(out).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            push_log(format!("[{name}] {line}"));
        }
    });
}

fn kill_group(pgid: i32) {
    unsafe {
        libc::killpg(pgid, libc::SIGTERM);
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while std::time::Instant::now() < deadline {
        if unsafe { libc::killpg(pgid, 0) } != 0 {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    unsafe {
        libc::killpg(pgid, libc::SIGKILL);
    }
}

/// Drops the current server, killing it when Trame spawned it.
fn stop_spawned() {
    let taken = state().server.take();
    if let Some(pgid) = taken.and_then(|s| s.pgid) {
        kill_group(pgid);
    }
}

/// Called at Trame shutdown: a spawned server must not outlive the app.
pub fn shutdown() {
    stop_spawned();
}

fn current() -> Option<Server> {
    state().server.clone()
}

// Export

fn encode_path(path: &str) -> String {
    path.split('/')
        .map(super::encode)
        .collect::<Vec<_>>()
        .join("/")
}

async fn export(state_: &Native, body: &Value) -> Result<(u16, Value)> {
    let Some(server) = current() else {
        return Ok((409, json!({"error": "no notebook server"})));
    };
    let path = text(&body["path"]).trim_start_matches('/').to_owned();
    if path.is_empty() || path.split('/').any(|seg| seg == "..") {
        return Ok((400, json!({"error": "path required"})));
    }
    let response = CLIENT
        .get(format!(
            "{}nbconvert/html/{}?download=true",
            server.url,
            encode_path(&path)
        ))
        .header(header::AUTHORIZATION, format!("token {}", server.token))
        .send()
        .await?;
    if response.status() != StatusCode::OK {
        let status = response.status();
        return Ok((
            502,
            json!({"error": format!("nbconvert answered {status}")}),
        ));
    }
    let html = response.text().await?;
    let stem = Path::new(&path)
        .file_stem()
        .map_or_else(|| path.clone(), |s| s.to_string_lossy().into_owned());
    if text(&body["to"]) == "file" {
        let Some(root) = server.root_dir.as_deref() else {
            return Ok((
                409,
                json!({"error": "unknown notebook folder for this server"}),
            ));
        };
        let file = Path::new(root).join(&path).with_extension("html");
        std::fs::write(&file, html).with_context(|| format!("cannot write {}", file.display()))?;
        return Ok((200, json!({"file": file.to_string_lossy()})));
    }
    let native = state_.clone();
    let title = stem;
    let id = crate::blocking::spawn(move || -> Result<Value> {
        let mut db = Db::connect(
            &native.root.join("socket"),
            &native.origin,
            Some(native.settings.clone()),
        )?;
        db.exclusive(|db| {
            crate::sessions::create_report(db, &json!({"title": title, "html": html}))
        })
    })
    .await
    .map_err(|_| anyhow!("export task failed"))??;
    Ok((
        200,
        json!({"id": id, "url": format!("/report/{}", id.as_str().unwrap_or(""))}),
    ))
}

// Embedded workspace

fn workspace_layout(path: &str) -> Value {
    let widget = format!("notebook:{path}");
    json!({
        "metadata": {"id": WORKSPACE},
        "data": {
            "layout-restorer:data": {
                "main": {"dock": {"type": "tab-area", "currentIndex": 0, "widgets": [widget]}, "current": widget},
                "down": {"size": 0, "collapsed": true, "widgets": []},
                "left": {"collapsed": true, "visible": true, "widgets": ["filebrowser", "running-sessions"]},
                "right": {"collapsed": true, "visible": true, "widgets": []},
                "relativeSizes": [0, 1, 0],
                "top": {"simpleVisibility": false}
            },
            widget: {"data": {"path": path, "factory": "Notebook"}}
        }
    })
}

/// Resets Trame's Lab workspace to the one notebook and returns the iframe URL for it.
async fn open(body: &Value) -> Result<(u16, Value)> {
    let Some(server) = current() else {
        return Ok((409, json!({"error": "no notebook server"})));
    };
    let path = text(&body["path"]).trim_start_matches('/').to_owned();
    if path.is_empty() || path.split('/').any(|seg| seg == "..") {
        return Ok((400, json!({"error": "path required"})));
    }
    let response = CLIENT
        .put(format!("{}lab/api/workspaces/{WORKSPACE}", server.url))
        .header(header::AUTHORIZATION, format!("token {}", server.token))
        .json(&workspace_layout(&path))
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        return Ok((
            502,
            json!({"error": format!("workspace answered {status}")}),
        ));
    }
    Ok((200, json!({"url": embed_url(&path)})))
}

fn embed_url(path: &str) -> String {
    format!(
        "{PREFIX}lab/workspaces/{WORKSPACE}/tree/{}",
        encode_path(path)
    )
}

/// Lab rewrites `/lab/` to `/doc/` once in single-document mode, so a reload keeps the chrome hidden.
fn embedded(rest: &str) -> bool {
    ["lab", "doc"]
        .iter()
        .any(|app| rest.starts_with(&format!("{app}/workspaces/{WORKSPACE}")))
}

// Theme

async fn set_theme(body: &Value) -> Result<(u16, Value)> {
    let Some(server) = current() else {
        return Ok((409, json!({"error": "no notebook server"})));
    };
    let theme = match text(&body["theme"]).as_str() {
        "dark" => "JupyterLab Dark",
        "light" => "JupyterLab Light",
        _ => return Ok((400, json!({"error": "theme must be light or dark"}))),
    };
    let auth = format!("token {}", server.token);
    let url = format!("{}{THEMES_SETTING}", server.url);
    let current = CLIENT
        .get(&url)
        .header(header::AUTHORIZATION, &auth)
        .send()
        .await?
        .json::<Value>()
        .await
        .unwrap_or(Value::Null);
    if current["settings"]["theme"] == theme {
        return Ok((200, json!({"theme": theme, "changed": false})));
    }
    let raw = json!({"theme": theme, "adaptive-theme": false});
    let response = CLIENT
        .put(&url)
        .header(header::AUTHORIZATION, &auth)
        .json(&json!({"raw": raw.to_string()}))
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        return Ok((502, json!({"error": format!("settings answered {status}")})));
    }
    Ok((200, json!({"theme": theme, "changed": true})))
}

// Proxy

const HOP: [HeaderName; 8] = [
    header::CONNECTION,
    header::HOST,
    header::ORIGIN,
    header::REFERER,
    header::TRANSFER_ENCODING,
    header::UPGRADE,
    header::ACCEPT_ENCODING,
    header::CONTENT_LENGTH,
];

/// Request headers forwarded upstream: the browser's, minus hop-by-hop and origin ones
/// (token auth replaces them), plus the token.
fn upstream_headers(incoming: &HeaderMap, token: &str) -> HeaderMap {
    let mut out = HeaderMap::new();
    for (name, value) in incoming {
        if HOP.contains(name)
            || name.as_str().starts_with("sec-websocket-")
            || name.as_str() == "keep-alive"
        {
            continue;
        }
        out.append(name.clone(), value.clone());
    }
    if let Ok(v) = HeaderValue::from_str(&format!("token {token}")) {
        out.insert(header::AUTHORIZATION, v);
    }
    out
}

/// Upstream path of the server's `base_url` (e.g. "/"), the part the HTML rewrite maps onto PREFIX.
fn base_path(url: &str) -> String {
    reqwest::Url::parse(url).map_or_else(|_| "/".to_owned(), |u| u.path().to_owned())
}

/// Maps an upstream root-relative URL onto the local mount; None when it is outside the server's base.
fn localize(target: &str, base: &str) -> Option<String> {
    if base == PREFIX {
        return None;
    }
    let rest = target.strip_prefix(base)?;
    // protocol-relative URLs ("//cdn…") are not under a "/" base
    if base == "/" && rest.starts_with('/') {
        return None;
    }
    Some(format!("{PREFIX}{rest}"))
}

/// Rewrites Lab's HTML: for a server whose `base_url` is not our mount, the page config's URLs
/// and the root-relative href/src attributes move under PREFIX; for the embedded workspace the
/// app object is exposed and the chrome-hiding script appended.
fn rewrite_html(html: &str, base: &str, embed: bool) -> String {
    let relocate = base != PREFIX;
    if !relocate && !embed {
        return html.to_owned();
    }
    let marker = "id=\"jupyter-config-data\"";
    let (head, tail) = match html.find(marker).and_then(|i| {
        let open = html[i..].find('>')? + i + 1;
        let close = html[open..].find("</script>")? + open;
        Some((&html[..open], (&html[open..close], &html[close..])))
    }) {
        Some((head, (config, rest))) => {
            let config = match serde_json::from_str::<Value>(config) {
                Ok(Value::Object(mut map)) => {
                    if relocate {
                        for (key, value) in &mut map {
                            let is_url = key == "baseUrl"
                                || (key.starts_with("full") && key.ends_with("Url"));
                            if let (true, Some(s)) = (is_url, value.as_str()) {
                                if let Some(local) = localize(s, base) {
                                    *value = json!(local);
                                }
                            }
                        }
                    }
                    if embed {
                        map.insert("exposeAppInBrowser".into(), json!("true"));
                    }
                    Value::Object(map).to_string()
                }
                _ => config.to_owned(),
            };
            (format!("{head}{config}"), rest)
        }
        None => (String::new(), html),
    };
    let mut out = String::with_capacity(html.len() + EMBED_SCRIPT.len() + 512);
    if relocate {
        out.push_str(&rewrite_attrs(&head, base));
        out.push_str(&rewrite_attrs(tail, base));
    } else {
        out.push_str(&head);
        out.push_str(tail);
    }
    if embed {
        match out.rfind("</body>") {
            Some(i) => out.insert_str(i, EMBED_SCRIPT),
            None => out.push_str(EMBED_SCRIPT),
        }
    }
    out
}

fn rewrite_attrs(html: &str, base: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(i) = rest.find("=\"") {
        let (before, after) = rest.split_at(i + 2);
        out.push_str(before);
        let attr_ok = before.ends_with("href=\"")
            || before.ends_with("src=\"")
            || before.ends_with("action=\"");
        let end = after.find('"').unwrap_or(after.len());
        let value = &after[..end];
        match attr_ok.then(|| localize(value, base)).flatten() {
            Some(local) => out.push_str(&local),
            None => out.push_str(value),
        }
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

fn forbidden_response(code: u16, msg: &str) -> Response {
    json_response(code, json!({"error": msg}))
}

async fn proxy(req: Request<Body>, rest: &str) -> Response {
    let Some(server) = current() else {
        return forbidden_response(409, "no notebook server");
    };
    let base = base_path(&server.url);
    let query = req
        .uri()
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let upstream = format!("{}{rest}{query}", server.url);
    let wants_ws = req
        .headers()
        .get(header::UPGRADE)
        .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"websocket"));
    if wants_ws {
        return proxy_ws(req, &upstream, &server.token).await;
    }
    let method = req.method().clone();
    let headers = upstream_headers(req.headers(), &server.token);
    let Ok(body) = axum::body::to_bytes(req.into_body(), usize::MAX).await else {
        return forbidden_response(500, "body unavailable");
    };
    let sent = CLIENT
        .request(method, &upstream)
        .headers(headers)
        .body(body)
        .send()
        .await;
    let response = match sent {
        Ok(r) => r,
        Err(e) => return forbidden_response(502, &format!("notebook server unreachable: {e}")),
    };
    let status = response.status();
    let mut builder = Response::builder().status(status);
    let is_html = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/html"));
    let embed = embedded(rest);
    let rewrite = is_html && (base != PREFIX || embed);
    for (name, value) in response.headers() {
        if *name == header::TRANSFER_ENCODING
            || *name == header::CONNECTION
            || name.as_str() == "x-frame-options"
            || (rewrite && *name == header::CONTENT_LENGTH)
        {
            continue;
        }
        if *name == header::LOCATION {
            if let Some(local) = value.to_str().ok().and_then(|v| localize(v, &base)) {
                builder = builder.header(name, local);
                continue;
            }
        }
        builder = builder.header(name, value);
    }
    let body = if rewrite {
        match response.text().await {
            Ok(html) => Body::from(rewrite_html(&html, &base, embed)),
            Err(_) => return forbidden_response(502, "notebook server body unavailable"),
        }
    } else {
        Body::from_stream(response.bytes_stream())
    };
    builder
        .body(body)
        .unwrap_or_else(|_| forbidden_response(502, "bad upstream response"))
}

fn to_upstream(message: Message) -> tungstenite::Message {
    match message {
        Message::Text(t) => tungstenite::Message::Text(t.as_str().into()),
        Message::Binary(b) => tungstenite::Message::Binary(b),
        Message::Ping(b) => tungstenite::Message::Ping(b),
        Message::Pong(b) => tungstenite::Message::Pong(b),
        Message::Close(frame) => {
            tungstenite::Message::Close(frame.map(|f| tungstenite::protocol::CloseFrame {
                code: f.code.into(),
                reason: f.reason.as_str().into(),
            }))
        }
    }
}

fn to_client(message: tungstenite::Message) -> Option<Message> {
    Some(match message {
        tungstenite::Message::Text(t) => Message::Text(t.as_str().into()),
        tungstenite::Message::Binary(b) => Message::Binary(b),
        tungstenite::Message::Ping(b) => Message::Ping(b),
        tungstenite::Message::Pong(b) => Message::Pong(b),
        tungstenite::Message::Close(frame) => Message::Close(frame.map(|f| CloseFrame {
            code: f.code.into(),
            reason: f.reason.as_str().into(),
        })),
        tungstenite::Message::Frame(_) => return None,
    })
}

async fn proxy_ws(req: Request<Body>, upstream: &str, token: &str) -> Response {
    use tungstenite::client::IntoClientRequest;
    let ws_url = upstream
        .replacen("http://", "ws://", 1)
        .replacen("https://", "wss://", 1);
    let Ok(mut up) = ws_url.as_str().into_client_request() else {
        return forbidden_response(502, "bad websocket url");
    };
    if let Ok(v) = HeaderValue::from_str(&format!("token {token}")) {
        up.headers_mut().insert(header::AUTHORIZATION, v);
    }
    for name in [header::SEC_WEBSOCKET_PROTOCOL, header::COOKIE] {
        if let Some(v) = req.headers().get(&name) {
            up.headers_mut().insert(name, v.clone());
        }
    }
    let connected = tokio::time::timeout(
        Duration::from_secs(20),
        tokio_tungstenite::connect_async(up),
    )
    .await;
    let (upstream_ws, handshake) = match connected {
        Ok(Ok(pair)) => pair,
        Ok(Err(e)) => return forbidden_response(502, &format!("notebook websocket refused: {e}")),
        Err(_) => return forbidden_response(504, "notebook websocket timed out"),
    };
    let selected = handshake
        .headers()
        .get(header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let upgrade = match WebSocketUpgrade::from_request(req, &()).await {
        Ok(u) => u,
        Err(e) => return e.into_response(),
    };
    let upgrade = match selected {
        Some(p) => upgrade.protocols([p]),
        None => upgrade,
    };
    upgrade.on_upgrade(move |client| pump(client, upstream_ws))
}

type Upstream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn pump(client: WebSocket, upstream: Upstream) {
    let (mut client_tx, mut client_rx) = client.split();
    let (mut up_tx, mut up_rx) = upstream.split();
    let down = async {
        while let Some(Ok(m)) = client_rx.next().await {
            if up_tx.send(to_upstream(m)).await.is_err() {
                break;
            }
        }
    };
    let up = async {
        while let Some(Ok(m)) = up_rx.next().await {
            let Some(m) = to_client(m) else { continue };
            if client_tx.send(m).await.is_err() {
                break;
            }
        }
    };
    tokio::select! {
        () = down => {}
        () = up => {}
    }
}

// Routes

pub struct Notebook;
pub static PLUGIN: Notebook = Notebook;

impl super::api::Plugin for Notebook {
    fn id(&self) -> &'static str {
        ID
    }
    fn label(&self) -> &'static str {
        "Notebook"
    }
    fn glyph(&self) -> &'static str {
        "▤"
    }
    fn description(&self) -> &'static str {
        "JupyterLab in the sidebar: start a server in a folder or attach to one already running."
    }
    fn sanitize(&self, raw: &Value, current: &Value) -> Value {
        sanitize(raw, current)
    }
    fn settings_view(&self, slice: &Value) -> Value {
        settings_view(slice)
    }
    fn stop(&'static self) {
        shutdown();
    }
    fn route(
        &'static self,
        native: Native,
        sub: String,
        req: Request<Body>,
    ) -> super::api::RouteFuture {
        Box::pin(route(native, sub, req))
    }
}

/// `/api/plugins/notebook/<sub>` once the registry has gated it.
async fn route(native: Native, sub: String, req: Request<Body>) -> Response {
    let settings_path = native.settings.clone();
    if let Some(rest) = sub.strip_prefix("/j/") {
        reattach_saved(&settings_path);
        let rest = rest.to_owned();
        return proxy(req, &rest).await;
    }
    let method = req.method().clone();
    let body = match axum::body::to_bytes(req.into_body(), 1 << 20).await {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes).unwrap_or_else(|_| json!({})),
        Err(_) => return forbidden_response(400, "body unavailable"),
    };
    let outcome: Result<(u16, Value)> = match (sub.as_str(), method.as_str()) {
        ("/status", _) => {
            reattach_saved(&settings_path);
            Ok((200, status(&settings_path)))
        }
        ("/start", "POST") => Ok(start(&settings_path, &body)),
        ("/attach", "POST") => attach(&settings_path, &body).await,
        ("/stop", "POST") => {
            let _ = settings::save_plugin(&settings_path, ID, &json!({"attached": Value::Null}));
            crate::blocking::spawn(stop_spawned)
                .await
                .map_err(|_| anyhow!("stop failed"))
                .map(|()| (200, status(&settings_path)))
        }
        ("/open", "POST") => open(&body).await,
        ("/export", "POST") => export(&native, &body).await,
        ("/theme", "POST") => set_theme(&body).await,
        _ => Ok((404, json!({"error": "not found"}))),
    };
    match outcome {
        Ok((status, value)) => json_response(status, value),
        Err(e) => json_response(500, json!({"error": e.to_string()})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn localize_maps_only_urls_under_the_servers_base() {
        assert_eq!(
            localize("/static/lab/main.js", "/").as_deref(),
            Some("/api/plugins/notebook/j/static/lab/main.js")
        );
        assert_eq!(localize("//cdn.example/x.js", "/"), None);
        assert_eq!(localize("https://cdn.example/x.js", "/"), None);
        assert_eq!(
            localize("/nb/lab", "/nb/").as_deref(),
            Some("/api/plugins/notebook/j/lab")
        );
        assert_eq!(localize("/other/lab", "/nb/"), None);
        assert_eq!(localize("/api/plugins/notebook/j/lab", PREFIX), None);
    }

    #[test]
    fn rewrite_html_moves_page_config_and_root_relative_assets() {
        let html = concat!(
            "<link href=\"/static/lab/x.css\"><a href=\"//cdn/x\">",
            "<script id=\"jupyter-config-data\" type=\"application/json\">",
            "{\"appUrl\":\"/lab\",\"baseUrl\":\"/\",\"fullStaticUrl\":\"/static/lab\",\"fullMathjaxUrl\":\"https://cdn/m.js\",\"serverRoot\":\"/home/x\",\"wsUrl\":\"\"}",
            "</script><script src=\"/static/lab/main.js\"></script>",
        );
        let out = rewrite_html(html, "/", false);
        assert!(
            out.contains("href=\"/api/plugins/notebook/j/static/lab/x.css\""),
            "{out}"
        );
        assert!(out.contains("href=\"//cdn/x\""), "{out}");
        assert!(
            out.contains("src=\"/api/plugins/notebook/j/static/lab/main.js\""),
            "{out}"
        );
        assert!(
            out.contains("\"baseUrl\":\"/api/plugins/notebook/j/\""),
            "{out}"
        );
        assert!(
            out.contains("\"fullStaticUrl\":\"/api/plugins/notebook/j/static/lab\""),
            "{out}"
        );
        assert!(out.contains("\"appUrl\":\"/lab\""), "{out}");
        assert!(out.contains("\"serverRoot\":\"/home/x\""), "{out}");
        assert!(
            out.contains("\"fullMathjaxUrl\":\"https://cdn/m.js\""),
            "{out}"
        );
        assert_eq!(rewrite_html(html, PREFIX, false), html);
    }

    #[test]
    fn rewrite_html_for_the_embedded_workspace_exposes_the_app_and_appends_the_script() {
        let html = "<html><head><script id=\"jupyter-config-data\" type=\"application/json\">{\"baseUrl\":\"/api/plugins/notebook/j/\"}</script></head><body><div></div></body></html>";
        let out = rewrite_html(html, PREFIX, true);
        assert!(out.contains("\"exposeAppInBrowser\":\"true\""), "{out}");
        assert!(
            out.ends_with(&format!("{EMBED_SCRIPT}</body></html>")),
            "{out}"
        );
        assert!(
            embedded("lab/workspaces/trame/tree/x.ipynb")
                && embedded("doc/workspaces/trame/tree/x.ipynb")
        );
        assert!(!embedded("lab/tree/x.ipynb") && !embedded("lab/workspaces/auto-G/tree/x.ipynb"));
        assert_eq!(
            embed_url("a b/x.ipynb"),
            "/api/plugins/notebook/j/lab/workspaces/trame/tree/a+b/x.ipynb"
        );
    }

    #[test]
    fn running_servers_lists_live_entries_without_their_token() {
        let dir = crate::scratch_root(
            &crate::workspace().join(format!(".scratch/notebook-rt-{}", uuid::Uuid::new_v4())),
        )
        .unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("jpserver-1.json"),
            r#"{"pid":1,"url":"http://127.0.0.1:8890","root_dir":"/w","token":"secret","version":"2.21.1"}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("jpserver-2.json"),
            r#"{"pid":2,"url":"http://127.0.0.1:1/","token":"t"}"#,
        )
        .unwrap();
        std::fs::write(dir.join("other.json"), r#"{"pid":1}"#).unwrap();
        let list = running_servers(&dir, |pid| pid == 1);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["url"], "http://127.0.0.1:8890/");
        assert_eq!(list[0]["token"], "secret");
        assert_eq!(public(&list[0]).get("token"), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn upstream_headers_drop_origin_and_add_the_token() {
        let mut incoming = HeaderMap::new();
        incoming.insert(header::ORIGIN, "http://127.0.0.1:1".parse().unwrap());
        incoming.insert(header::HOST, "127.0.0.1:1".parse().unwrap());
        incoming.insert(header::COOKIE, "_xsrf=a".parse().unwrap());
        incoming.insert(header::ACCEPT_ENCODING, "gzip".parse().unwrap());
        let out = upstream_headers(&incoming, "tok");
        assert_eq!(out.get(header::AUTHORIZATION).unwrap(), "token tok");
        assert_eq!(out.get(header::COOKIE).unwrap(), "_xsrf=a");
        assert!(out.get(header::ORIGIN).is_none() && out.get(header::HOST).is_none());
        assert!(out.get(header::ACCEPT_ENCODING).is_none());
    }

    #[test]
    fn sanitize_keeps_only_known_fields_and_clears_blanks() {
        let current = json!({"enabled": true, "command": "jupyter lab", "rootDir": "/w"});
        let out = sanitize(
            &json!({"command": " ", "rootDir": "/x", "token": "no"}),
            &current,
        );
        assert_eq!(out, json!({"enabled": true, "rootDir": "/x"}));
    }
}
