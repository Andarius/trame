// Notebook cells: a page's `code` blocks run on a Jupyter kernel. The kernel lives in a
// Jupyter Server the user points the plugin at; execution streams back as NDJSON events.
use crate::{routes::json_response, settings};
use anyhow::{Context, Result, anyhow, bail};
use axum::{
    body::{Body, Bytes},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};

mod pycharm;
mod uv;

pub const ID: &str = "notebook-cells";

fn settings_view(slice: &Value) -> Value {
    json!({
        "enabled": slice["enabled"] == true,
        "serverUrl": slice["serverUrl"].as_str().unwrap_or(""),
        "hasToken": slice["token"].as_str().is_some_and(|t| !t.is_empty()),
        "keymap": slice["keymap"],
    })
}

/// An imported editor keymap: `{name, actions: {action id: [shortcut]}}`, bounded; null resets it.
fn sanitize_keymap(raw: &Value) -> Option<Value> {
    if raw.is_null() {
        return Some(Value::Null);
    }
    let name: String = raw["name"].as_str()?.chars().take(80).collect();
    let actions: serde_json::Map<String, Value> = raw["actions"]
        .as_object()?
        .iter()
        .take(2000)
        .filter(|(id, _)| id.len() <= 120)
        .filter_map(|(id, keys)| {
            let keys: Vec<Value> = keys
                .as_array()?
                .iter()
                .filter_map(Value::as_str)
                .filter(|k| !k.is_empty() && k.len() <= 60)
                .take(8)
                .map(|k| json!(k))
                .collect();
            (!keys.is_empty()).then(|| (id.clone(), Value::Array(keys)))
        })
        .collect();
    Some(json!({"name": name, "actions": actions, "importedAt": chrono::Utc::now().to_rfc3339()}))
}

// Only the server URL and token are settable; a blank token keeps the stored one.
fn sanitize(raw: &Value) -> Value {
    let mut out = serde_json::Map::new();
    if let Some(enabled) = raw["enabled"].as_bool() {
        out.insert("enabled".into(), json!(enabled));
    }
    if let Some(url) = raw["serverUrl"].as_str() {
        let url = url.trim().trim_end_matches('/');
        if url.is_empty() || url.starts_with("http://") || url.starts_with("https://") {
            out.insert("serverUrl".into(), json!(url));
        }
    }
    if let Some(token) = raw["token"]
        .as_str()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        out.insert("token".into(), json!(token));
    }
    if let Some(keymap) = raw.get("keymap").and_then(sanitize_keymap) {
        out.insert("keymap".into(), keymap);
    }
    Value::Object(out)
}

#[derive(Clone)]
struct Server {
    url: String,
    token: String,
}

impl Server {
    fn from(slice: &Value) -> Result<Self> {
        let url = slice["serverUrl"]
            .as_str()
            .unwrap_or("")
            .trim_end_matches('/');
        if url.is_empty() {
            bail!("no Jupyter server configured");
        }
        Ok(Self {
            url: url.to_owned(),
            token: slice["token"].as_str().unwrap_or("").to_owned(),
        })
    }
    fn auth(&self) -> String {
        format!("token {}", self.token)
    }
    fn client() -> Result<reqwest::Client> {
        Ok(reqwest::Client::builder()
            .user_agent("trame-local")
            .timeout(std::time::Duration::from_secs(30))
            .build()?)
    }
    async fn get(&self, path: &str) -> Result<Value> {
        let res = Self::client()?
            .get(format!("{}{path}", self.url))
            .header("authorization", self.auth())
            .send()
            .await
            .context("jupyter unreachable")?;
        if !res.status().is_success() {
            bail!("jupyter {} on {path}", res.status().as_u16());
        }
        Ok(res.json().await?)
    }
    async fn post(&self, path: &str, body: Option<Value>) -> Result<Value> {
        let mut req = Self::client()?
            .post(format!("{}{path}", self.url))
            .header("authorization", self.auth());
        if let Some(body) = body {
            req = req.json(&body);
        }
        let res = req.send().await.context("jupyter unreachable")?;
        if !res.status().is_success() {
            bail!("jupyter {} on {path}", res.status().as_u16());
        }
        Ok(res.json().await.unwrap_or(Value::Null))
    }
    async fn delete(&self, path: &str) -> Result<()> {
        let res = Self::client()?
            .delete(format!("{}{path}", self.url))
            .header("authorization", self.auth())
            .send()
            .await
            .context("jupyter unreachable")?;
        if !res.status().is_success() {
            bail!("jupyter {} on {path}", res.status().as_u16());
        }
        Ok(())
    }
    fn local(&self) -> bool {
        let host = self.url.split_once("://").map_or("", |(_, h)| h);
        ["127.0.0.1", "localhost", "[::1]"].iter().any(|l| {
            host == *l || host.starts_with(&format!("{l}:")) || host.starts_with(&format!("{l}/"))
        })
    }
    fn ws(&self, path: &str) -> String {
        let scheme = if self.url.starts_with("https://") {
            "wss"
        } else {
            "ws"
        };
        let host = self
            .url
            .split_once("://")
            .map_or(self.url.as_str(), |(_, h)| h);
        format!("{scheme}://{host}{path}")
    }
}

// Running kernels with the notebook each one serves, from /api/sessions.
async fn kernels(server: &Server) -> Result<Value> {
    let (kernels, sessions) =
        tokio::try_join!(server.get("/api/kernels"), server.get("/api/sessions"))?;
    let path_of = |id: &str| {
        sessions
            .as_array()
            .into_iter()
            .flatten()
            .find(|s| s["kernel"]["id"] == id)
            .and_then(|s| s["path"].as_str())
            .map(str::to_owned)
    };
    let list: Vec<Value> = kernels
        .as_array()
        .into_iter()
        .flatten()
        .map(|k| {
            let id = k["id"].as_str().unwrap_or("");
            json!({"id": id, "name": k["name"], "state": k["execution_state"], "path": path_of(id),
                "lastActivity": k["last_activity"], "connections": k["connections"]})
        })
        .collect();
    Ok(json!({"kernels": list}))
}

// Installed kernel specs, default first; `project` marks the ones made from a project folder.
async fn kernelspecs(server: &Server) -> Result<Value> {
    let specs = server.get("/api/kernelspecs").await?;
    let default = specs["default"].as_str().unwrap_or("");
    let mut list: Vec<Value> = specs["kernelspecs"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(name, k)| {
            let spec = &k["spec"];
            json!({"name": name, "display": spec["display_name"].as_str().unwrap_or(name),
                "language": spec["language"], "project": spec["metadata"]["trame"]["project"],
                "config": spec["metadata"]["trame"]})
        })
        .collect();
    list.sort_by_key(|k| {
        (
            k["name"] != default,
            k["display"].as_str().unwrap_or("").to_lowercase(),
        )
    });
    Ok(json!({"default": default, "specs": list}))
}

const fn spec_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')
}

/// The first `name` on PATH, absolute: Jupyter launches kernels with its own PATH.
fn on_path(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|d| d.join(name))
        .find(|p| p.is_file())
}

fn jupyter_data_dir() -> PathBuf {
    std::env::var_os("JUPYTER_DATA_DIR").map_or_else(
        || {
            let home = std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from);
            if cfg!(target_os = "macos") {
                home.join("Library/Jupyter")
            } else {
                home.join(".local/share/jupyter")
            }
        },
        PathBuf::from,
    )
}

/// A project kernel's settings, as the configure dialog sends them; validated before they reach argv.
#[derive(Debug, Default, PartialEq)]
pub(super) struct ProjectKernel {
    pub(super) dir: PathBuf,
    pub(super) display: Option<String>,
    pub(super) python: Option<String>,
    pub(super) packages: Vec<String>,
    pub(super) env: serde_json::Map<String, Value>,
}

const fn package_char(c: char) -> bool {
    c.is_ascii_alphanumeric()
        || matches!(
            c,
            '-' | '_' | '.' | '[' | ']' | ',' | '<' | '>' | '=' | '!' | '~'
        )
}

fn env_key(k: &str) -> bool {
    k.chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Bounds every field; the folder must hold a pyproject.toml.
pub(super) fn parse_project(body: &Value) -> Result<ProjectKernel> {
    let raw = body["path"].as_str().unwrap_or("").trim();
    if !Path::new(raw).is_absolute() {
        bail!("give the project's absolute path");
    }
    let dir = Path::new(raw).canonicalize().context("no such folder")?;
    if !dir.join("pyproject.toml").is_file() {
        bail!("no pyproject.toml in {}", dir.display());
    }
    let text = |k: &str, max: usize| {
        body[k]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(max).collect::<String>())
    };
    let python = text("python", 40);
    if python.as_deref().is_some_and(|p| !p.chars().all(spec_char)) {
        bail!("python version: letters, digits, dots and dashes only");
    }
    let packages: Vec<String> = body["packages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .collect();
    if packages.len() > 30 {
        bail!("at most 30 extra packages");
    }
    if let Some(bad) = packages
        .iter()
        .find(|p| p.len() > 100 || p.starts_with('-') || !p.chars().all(package_char))
    {
        bail!("not a package requirement: {bad}");
    }
    let mut env = serde_json::Map::new();
    for (k, v) in body["env"].as_object().into_iter().flatten() {
        let Some(v) = v.as_str() else { continue };
        if !env_key(k) {
            bail!("not an environment variable name: {k}");
        }
        if env.len() >= 30 || v.len() > 2000 {
            bail!("too many or too long environment variables");
        }
        env.insert(k.clone(), json!(v));
    }
    Ok(ProjectKernel {
        dir,
        display: text("display", 60),
        python,
        packages,
        env,
    })
}

/// The uv-run kernel spec: the folder's pyproject env plus ipykernel and the extras, cwd = the folder.
pub(super) fn project_spec(cfg: &ProjectKernel, uv: &Path) -> (String, Value) {
    let base = cfg
        .dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let slug: String = base
        .to_lowercase()
        .chars()
        .map(|c| if spec_char(c) { c } else { '-' })
        .collect();
    let name = format!("trame-{}", slug.trim_matches('-'));
    let mut argv = vec![
        json!(uv),
        json!("run"),
        json!("--directory"),
        json!(cfg.dir),
    ];
    if let Some(py) = &cfg.python {
        argv.extend([json!("--python"), json!(py)]);
    }
    for pkg in std::iter::once("ipykernel").chain(cfg.packages.iter().map(String::as_str)) {
        argv.extend([json!("--with"), json!(pkg)]);
    }
    argv.extend(
        [
            "python",
            "-m",
            "ipykernel_launcher",
            "-f",
            "{connection_file}",
        ]
        .map(|a| json!(a)),
    );
    let spec = json!({
        "argv": argv,
        "display_name": cfg.display.clone().unwrap_or_else(|| format!("{base} (uv)")),
        "language": "python",
        "env": cfg.env,
        // what the configure dialog reads back
        "metadata": {"trame": {"project": cfg.dir, "display": cfg.display, "python": cfg.python,
            "packages": cfg.packages, "env": cfg.env}},
    });
    (name, spec)
}

fn kernels_dir() -> PathBuf {
    jupyter_data_dir().join("kernels")
}

fn install_project_spec(body: &Value) -> Result<String> {
    let cfg = parse_project(body)?;
    let uv = on_path("uv").context("uv not found on PATH")?;
    let (name, spec) = project_spec(&cfg, &uv);
    let target = kernels_dir().join(&name);
    std::fs::create_dir_all(&target)?;
    std::fs::write(target.join("kernel.json"), crate::json::stringify(&spec))?;
    Ok(name)
}

/// Removes a spec this plugin made; any other kernel spec is left alone.
fn remove_project_spec(name: &str) -> Result<()> {
    if !name.starts_with("trame-") || !name.chars().all(spec_char) || name.contains("..") {
        bail!("not a project kernel");
    }
    let dir = kernels_dir().join(name);
    let spec: Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("kernel.json")).context("no such kernel spec")?,
    )?;
    if spec["metadata"]["trame"]["project"].is_null() {
        bail!("not a project kernel");
    }
    std::fs::remove_dir_all(dir)?;
    Ok(())
}

// The kernel a cell runs on: the one asked for, else the first running one, else a new one.
async fn ensure_kernel(server: &Server, wanted: Option<&str>) -> Result<String> {
    let list = server.get("/api/kernels").await?;
    let ids: Vec<&str> = list
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|k| k["id"].as_str())
        .collect();
    if let Some(id) = wanted.filter(|w| ids.contains(w)) {
        return Ok(id.to_owned());
    }
    if let Some(id) = ids.first() {
        return Ok((*id).to_owned());
    }
    let started = server.post("/api/kernels", Some(json!({}))).await?;
    started["id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("kernel start failed"))
}

fn event(tx: &mpsc::Sender<Result<Bytes, std::io::Error>>, value: &Value) -> bool {
    let mut line = crate::json::stringify(value);
    line.push('\n');
    tx.try_send(Ok(Bytes::from(line))).is_ok()
}

// One execute_request over the kernel's websocket; iopub messages of that request become events.
async fn run_cell(
    server: Server,
    kernel: String,
    code: String,
    tx: mpsc::Sender<Result<Bytes, std::io::Error>>,
) -> Result<()> {
    let session = uuid::Uuid::new_v4().to_string();
    let mut req = server
        .ws(&format!(
            "/api/kernels/{kernel}/channels?session_id={session}"
        ))
        .into_client_request()?;
    req.headers_mut()
        .insert("authorization", server.auth().parse()?);
    let (mut ws, _) = tokio_tungstenite::connect_async(req)
        .await
        .context("kernel channel refused")?;
    let msg_id = uuid::Uuid::new_v4().to_string();
    let request = json!({
        "header": {"msg_id": msg_id, "username": "trame", "session": session, "msg_type": "execute_request", "version": "5.3", "date": chrono::Utc::now().to_rfc3339()},
        "parent_header": {},
        "metadata": {},
        "content": {"code": code, "silent": false, "store_history": true, "user_expressions": {}, "allow_stdin": false, "stop_on_error": true},
        "channel": "shell",
        "buffers": [],
    });
    ws.send(Message::Text(request.to_string().into())).await?;
    let (mut replied, mut idle) = (false, false);
    while let Some(frame) = ws.next().await {
        let text = match frame? {
            Message::Text(t) => t,
            Message::Close(_) => break,
            _ => continue,
        };
        let Ok(m) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if m["parent_header"]["msg_id"] != msg_id {
            continue;
        }
        let content = &m["content"];
        let out = match m["header"]["msg_type"].as_str().unwrap_or("") {
            "status" => {
                idle = content["execution_state"] == "idle";
                None
            }
            "execute_input" => Some(json!({"type": "input", "count": content["execution_count"]})),
            "execute_reply" => {
                replied = true;
                Some(
                    json!({"type": "reply", "status": content["status"], "count": content["execution_count"]}),
                )
            }
            "stream" => {
                Some(json!({"type": "stream", "name": content["name"], "text": content["text"]}))
            }
            "display_data" | "execute_result" => Some(json!({
                "type": m["header"]["msg_type"],
                "data": content["data"],
                "metadata": content["metadata"],
                "count": content["execution_count"],
            })),
            "error" => Some(
                json!({"type": "error", "ename": content["ename"], "evalue": content["evalue"], "traceback": content["traceback"]}),
            ),
            "clear_output" => Some(json!({"type": "clear_output", "wait": content["wait"]})),
            _ => None,
        };
        if let Some(out) = out
            && !event(&tx, &out)
        {
            break; // the page went away
        }
        if replied && idle {
            break;
        }
    }
    let _ = ws.close(None).await;
    Ok(())
}

fn failed(e: &anyhow::Error) -> Response {
    json_response(502, json!({"error": e.to_string()}))
}

// Cells of a notebook on the server, for importing them into a page.
async fn notebook(server: &Server, path: &str) -> Result<Value> {
    let nb = server
        .get(&format!(
            "/api/contents/{}?type=notebook&content=1",
            path.trim_start_matches('/')
        ))
        .await?;
    let cells: Vec<Value> = nb["content"]["cells"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| {
            let source = match &c["source"] {
                Value::Array(parts) => parts.iter().filter_map(Value::as_str).collect::<String>(),
                Value::String(s) => s.clone(),
                _ => String::new(),
            };
            json!({"cell_type": c["cell_type"], "source": source, "outputs": c["outputs"], "count": c["execution_count"]})
        })
        .collect();
    Ok(json!({"path": path, "cells": cells}))
}

async fn handle(
    settings_path: &Path,
    method: &str,
    sub: &str,
    query: &str,
    body: &Value,
) -> Response {
    let slice = settings::plugin(settings_path, ID);
    if (sub, method) == ("/pycharm-keymap", "GET") {
        return match crate::blocking::spawn(pycharm::import).await {
            Ok(Ok(v)) => json_response(200, v),
            Ok(Err(e)) => json_response(404, json!({"error": e.to_string()})),
            Err(_) => json_response(500, json!({"error": "keymap import failed"})),
        };
    }
    let server = match Server::from(&slice) {
        Ok(s) => s,
        Err(e) => return json_response(400, json!({"error": e.to_string()})),
    };
    let param = |key: &str| {
        reqwest::Url::parse(&format!("http://q.invalid/?{query}"))
            .ok()
            .and_then(|u| {
                u.query_pairs()
                    .find(|(k, _)| k == key)
                    .map(|(_, v)| v.into_owned())
            })
            .unwrap_or_default()
    };
    match (sub, method) {
        ("/kernels", "GET") => kernels(&server)
            .await
            .map_or_else(|e| failed(&e), |v| json_response(200, v)),
        ("/kernels", "POST") => {
            let mut req = json!({});
            if let Some(name) = body["name"].as_str().filter(|n| !n.is_empty()) {
                if !name.chars().all(spec_char) {
                    return json_response(400, json!({"error": "bad kernel spec name"}));
                }
                req["name"] = json!(name);
            }
            match server.post("/api/kernels", Some(req)).await {
                Ok(k) => json_response(200, json!({"id": k["id"], "name": k["name"]})),
                Err(e) => failed(&e),
            }
        }
        ("/kernelspecs", "GET") => kernelspecs(&server)
            .await
            .map_or_else(|e| failed(&e), |v| json_response(200, v)),
        ("/project-kernel", "POST") => {
            // the spec is a file Jupyter reads: only a server on this machine sees it
            if !server.local() {
                return json_response(
                    400,
                    json!({"error": "project kernels need a Jupyter server on this machine"}),
                );
            }
            let start = body["start"] != false;
            let cfg = body.clone();
            let name = match crate::blocking::spawn(move || install_project_spec(&cfg)).await {
                Ok(Ok(n)) => n,
                Ok(Err(e)) => return json_response(400, json!({"error": e.to_string()})),
                Err(_) => return json_response(500, json!({"error": "install failed"})),
            };
            if !start {
                return json_response(200, json!({"spec": name}));
            }
            match server
                .post("/api/kernels", Some(json!({"name": name})))
                .await
            {
                Ok(k) => {
                    json_response(200, json!({"id": k["id"], "name": k["name"], "spec": name}))
                }
                Err(e) => failed(&e),
            }
        }
        ("/project", "GET") => {
            let path = param("path");
            match crate::blocking::spawn(move || uv::project_info(path.trim())).await {
                Ok(Ok(v)) => json_response(200, v),
                Ok(Err(e)) => json_response(400, json!({"error": e.to_string()})),
                Err(_) => json_response(500, json!({"error": "read failed"})),
            }
        }
        ("/pythons", "GET") => {
            let Some(uv) = on_path("uv") else {
                return json_response(400, json!({"error": "uv not found on PATH"}));
            };
            match crate::blocking::spawn(move || uv::pythons(&uv)).await {
                Ok(Ok(v)) => json_response(200, v),
                Ok(Err(e)) => failed(&e),
                Err(_) => json_response(500, json!({"error": "uv failed"})),
            }
        }
        ("/pypi", "GET") => uv::pypi(param("name").trim())
            .await
            .map_or_else(|e| failed(&e), |v| json_response(200, v)),
        ("/project-kernel/remove", "POST") => {
            let name = body["name"].as_str().unwrap_or("").to_owned();
            match crate::blocking::spawn(move || remove_project_spec(&name)).await {
                Ok(Ok(())) => json_response(200, json!({"ok": true})),
                Ok(Err(e)) => json_response(400, json!({"error": e.to_string()})),
                Err(_) => json_response(500, json!({"error": "remove failed"})),
            }
        }
        ("/interrupt" | "/restart" | "/shutdown", "POST") => {
            // the id lands in the Jupyter URL path: kernel ids are uuids
            let Some(id) = body["kernel"].as_str().filter(|s| {
                !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            }) else {
                return json_response(400, json!({"error": "kernel required"}));
            };
            let done = if sub == "/shutdown" {
                server.delete(&format!("/api/kernels/{id}")).await
            } else {
                server
                    .post(&format!("/api/kernels/{id}{sub}"), None)
                    .await
                    .map(drop)
            };
            match done {
                Ok(()) => json_response(200, json!({"ok": true})),
                Err(e) => failed(&e),
            }
        }
        ("/notebook", "GET") => {
            let path = param("path");
            if path.is_empty() {
                return json_response(400, json!({"error": "path required"}));
            }
            notebook(&server, &path)
                .await
                .map_or_else(|e| failed(&e), |v| json_response(200, v))
        }
        ("/execute", "POST") => {
            let code = body["code"].as_str().unwrap_or("").to_owned();
            let kernel = match ensure_kernel(&server, body["kernel"].as_str()).await {
                Ok(k) => k,
                Err(e) => return failed(&e),
            };
            let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(256);
            let started = json!({"type": "start", "kernel": kernel});
            event(&tx, &started);
            tokio::spawn(async move {
                if let Err(e) = run_cell(server, kernel, code, tx.clone()).await {
                    event(&tx, &json!({"type": "failed", "error": e.to_string()}));
                }
            });
            let stream = futures_util::stream::unfold(rx, |mut rx| async move {
                rx.recv().await.map(|item| (item, rx))
            });
            (
                StatusCode::OK,
                [
                    ("content-type", "application/x-ndjson"),
                    ("cache-control", "no-store"),
                    ("x-accel-buffering", "no"),
                ],
                Body::from_stream(stream),
            )
                .into_response()
        }
        _ => json_response(404, json!({"error": "not found"})),
    }
}

pub struct NotebookCells;
pub static PLUGIN: NotebookCells = NotebookCells;

impl super::api::Plugin for NotebookCells {
    fn id(&self) -> &'static str {
        ID
    }
    fn label(&self) -> &'static str {
        "Notebook cells"
    }
    fn glyph(&self) -> &'static str {
        "▶"
    }
    fn description(&self) -> &'static str {
        "Run Python cells of a page on a Jupyter kernel."
    }
    fn sanitize(&self, raw: &Value, _current: &Value) -> Value {
        sanitize(raw)
    }
    fn settings_view(&self, slice: &Value) -> Value {
        settings_view(slice)
    }
    fn route(
        &'static self,
        native: crate::routes::Native,
        sub: String,
        req: axum::http::Request<Body>,
    ) -> super::api::RouteFuture {
        Box::pin(async move {
            let method = req.method().to_string();
            let query = req.uri().query().unwrap_or("").to_owned();
            let Ok(bytes) = axum::body::to_bytes(req.into_body(), usize::MAX).await else {
                return json_response(500, json!({"error":"body unavailable"}));
            };
            let body = serde_json::from_slice::<Value>(&bytes).unwrap_or_else(|_| json!({}));
            handle(&native.settings, &method, &sub, &query, &body).await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_keeps_only_url_token_and_enabled() {
        let out = sanitize(
            &json!({"serverUrl": " http://127.0.0.1:8890/ ", "token": " ", "enabled": true, "x": 1}),
        );
        assert_eq!(
            out,
            json!({"enabled": true, "serverUrl": "http://127.0.0.1:8890"})
        );
        assert_eq!(sanitize(&json!({"serverUrl": "ftp://x"})), json!({}));
        assert_eq!(sanitize(&json!({"token": "abc"})), json!({"token": "abc"}));
    }

    #[test]
    fn settings_view_never_echoes_the_token() {
        let view = settings_view(&json!({"token": "secret", "serverUrl": "http://h"}));
        assert_eq!(
            view,
            json!({"enabled": false, "serverUrl": "http://h", "hasToken": true, "keymap": null})
        );
    }

    #[test]
    fn keymap_is_bounded_and_resettable() {
        let out = sanitize(
            &json!({"keymap": {"name": "Custom", "actions": {"A": ["ctrl d", "", 5], "B": []}}}),
        );
        assert_eq!(out["keymap"]["name"], "Custom");
        assert_eq!(out["keymap"]["actions"], json!({"A": ["ctrl d"]}));
        assert_eq!(sanitize(&json!({"keymap": null})), json!({"keymap": null}));
        assert!(
            sanitize(&json!({"keymap": {"actions": {}}}))
                .get("keymap")
                .is_none()
        );
    }

    #[test]
    fn project_kernels_only_for_a_local_server() {
        let at = |url: &str| {
            Server {
                url: url.into(),
                token: String::new(),
            }
            .local()
        };
        assert!(at("http://127.0.0.1:8891") && at("http://localhost") && at("http://[::1]:8888"));
        assert!(
            !at("http://127.0.0.1.evil.com:80")
                && !at("https://jupyter.example.com")
                && !at("http://localhostx:1")
        );
    }

    #[test]
    fn project_spec_runs_the_folder_with_uv_and_the_extras() {
        let cfg = ProjectKernel {
            dir: "/w/OKR grille".into(),
            python: Some("3.13".into()),
            packages: vec!["polars>=1.0".into()],
            env: [("PGHOST".to_owned(), json!("localhost"))]
                .into_iter()
                .collect(),
            ..Default::default()
        };
        let (name, spec) = project_spec(&cfg, Path::new("/bin/uv"));
        assert_eq!(name, "trame-okr-grille");
        let argv: Vec<&str> = spec["argv"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(
            argv[..10],
            [
                "/bin/uv",
                "run",
                "--directory",
                "/w/OKR grille",
                "--python",
                "3.13",
                "--with",
                "ipykernel",
                "--with",
                "polars>=1.0"
            ]
        );
        assert_eq!(spec["display_name"], "OKR grille (uv)");
        assert_eq!(spec["env"]["PGHOST"], "localhost");
        assert_eq!(spec["metadata"]["trame"]["python"], "3.13");
    }

    #[test]
    fn project_settings_are_validated() {
        let dir = crate::scratch_root(
            &crate::workspace().join(format!(".scratch/kp-{}", uuid::Uuid::new_v4())),
        )
        .unwrap();
        std::fs::write(dir.join("pyproject.toml"), "[project]\nname='x'\n").unwrap();
        let path = dir.to_string_lossy().into_owned();
        let ok = parse_project(&json!({"path": path, "packages": ["pandas", " "], "env": {"A_1": "x"}, "python": "3.12"})).unwrap();
        assert_eq!((ok.packages, ok.env.len()), (vec!["pandas".to_owned()], 1));
        for (body, why) in [
            (json!({"path": "rel/dir"}), "absolute"),
            (json!({"path": "/"}), "pyproject"),
            (
                json!({"path": path, "packages": ["--index-url=http://x"]}),
                "package",
            ),
            (json!({"path": path, "packages": ["a b"]}), "package"),
            (json!({"path": path, "python": "3.12 --x"}), "python"),
            (json!({"path": path, "env": {"1BAD": "x"}}), "environment"),
        ] {
            let err = parse_project(&body).unwrap_err().to_string();
            assert!(err.contains(why), "{body}: {err}");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn only_project_specs_can_be_removed() {
        for name in ["python3", "trame-../x", "trame-x/y"] {
            assert!(remove_project_spec(name).is_err(), "{name}");
        }
    }

    #[test]
    fn ws_url_follows_the_http_scheme() {
        let s = Server {
            url: "https://h:1".into(),
            token: String::new(),
        };
        assert_eq!(
            s.ws("/api/kernels/k/channels"),
            "wss://h:1/api/kernels/k/channels"
        );
        let s = Server {
            url: "http://127.0.0.1:8890".into(),
            token: String::new(),
        };
        assert_eq!(s.ws("/x"), "ws://127.0.0.1:8890/x");
    }
}
