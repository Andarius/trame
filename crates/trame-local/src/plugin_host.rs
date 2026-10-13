// Supervises the out-of-process plugin host (`<root>/plugins/plugin-host`, built by
// `just plugins-install`) and forwards `/api/plugins/<id>/*` for the plugins it serves.
use crate::routes::Native;
use anyhow::{Context, Result};
use axum::{body::Bytes, http::StatusCode, response::IntoResponse, response::Response};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Mutex, Once},
    time::{Duration, Instant},
};
use tokio::io::{AsyncBufReadExt, BufReader};

#[derive(Clone)]
struct Conn {
    port: u16,
    token: String,
    ids: Vec<String>,
}

static CONN: Mutex<Option<Conn>> = Mutex::new(None);
static MARK_ROLES: Once = Once::new();

pub fn executable(root: &Path) -> PathBuf {
    std::env::var_os("TRAME_PLUGIN_HOST")
        .map_or_else(|| root.join("plugins/plugin-host"), PathBuf::from)
}

pub fn web_dir(root: &Path) -> PathBuf {
    root.join("plugins/web")
}

/// Runs the host while the app runs, restarting it with backoff; `None` when none is installed.
/// Offline (dev, tests) only an explicit `TRAME_PLUGIN_HOST` starts one.
pub fn start(state: Native) -> Option<tokio::task::JoinHandle<()>> {
    let exe = executable(&state.root);
    let explicit = std::env::var_os("TRAME_PLUGIN_HOST").is_some();
    if (state.sync.offline && !explicit) || !exe.is_file() {
        return None;
    }
    Some(tokio::spawn(async move {
        let mut backoff = 2;
        loop {
            let started = Instant::now();
            if let Err(error) = run(&state, &exe).await {
                eprintln!("plugin host: {error:#}");
            }
            *CONN.lock().unwrap() = None;
            if started.elapsed() > Duration::from_mins(5) {
                backoff = 2;
            }
            tokio::time::sleep(Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(300);
        }
    }))
}

async fn run(state: &Native, exe: &Path) -> Result<()> {
    let token = uuid::Uuid::new_v4().simple().to_string();
    // stdin stays piped and unread: the host exits when it closes, so an app crash cannot orphan it
    let mut child = tokio::process::Command::new(exe)
        .env("TRAME_PLUGIN_TOKEN", &token)
        .env("TRAME_PG_SOCKET", state.root.join("socket"))
        .env("TRAME_PG_SCHEMA_OWNED", "1")
        .env("TRACKER_SETTINGS_FILE", &state.settings)
        .env("TRACKER_NODE_ID", &state.origin)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("cannot start {}", exe.display()))?;
    // Child::wait closes a stdin it still holds; keep ours open until the host exits
    let _stdin = child.stdin.take();
    let mut lines = BufReader::new(child.stdout.take().context("no stdout")?).lines();
    let line = tokio::time::timeout(Duration::from_mins(1), lines.next_line())
        .await
        .context("no readiness line within a minute")??
        .context("exited before readiness")?;
    let port = serde_json::from_str::<Value>(&line)?["port"]
        .as_u64()
        .and_then(|p| u16::try_from(p).ok())
        .with_context(|| format!("bad readiness line: {line}"))?;
    let mut conn = Conn {
        port,
        token,
        ids: Vec::new(),
    };
    let manifests = get(&conn, "/host/manifests").await?;
    conn.ids = manifests
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| m["id"].as_str().map(str::to_owned))
        .filter(|id| id != "deployments")
        .collect();
    let roles = get(&conn, "/host/mark-roles").await?;
    MARK_ROLES.call_once(|| register_mark_roles(&roles));
    eprintln!("plugin host: serving {:?} on port {port}", conn.ids);
    *CONN.lock().unwrap() = Some(conn);
    tokio::spawn(async move {
        while let Ok(Some(line)) = lines.next_line().await {
            eprintln!("plugin host: {line}");
        }
    });
    let status = child.wait().await?;
    anyhow::bail!("exited with {status}")
}

fn register_mark_roles(roles: &Value) {
    let rules = roles
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            Some(crate::pages::MarkRule {
                mark: r["mark"].as_str()?.to_owned(),
                value: regex::Regex::new(r["value"].as_str()?).ok()?,
                role: r["role"].as_str()?.to_owned(),
            })
        })
        .collect();
    crate::pages::add_mark_roles(rules);
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap_or_default()
}

async fn get(conn: &Conn, path: &str) -> Result<Value> {
    let response = client()
        .get(format!("http://127.0.0.1:{}{path}", conn.port))
        .header("x-trame-plugin-token", &conn.token)
        .timeout(Duration::from_secs(10))
        .send()
        .await?
        .error_for_status()?;
    Ok(response.json().await?)
}

/// Whether the running host serves the plugin this `/api/plugins/<id>/…` path names.
pub fn serves(path: &str) -> bool {
    let Some(id) = path
        .strip_prefix("/api/plugins/")
        .and_then(|rest| rest.split('/').next())
    else {
        return false;
    };
    CONN.lock()
        .unwrap()
        .as_ref()
        .is_some_and(|conn| conn.ids.iter().any(|known| known == id))
}

/// The host's plugin manifests, or none while it is down.
pub async fn manifests() -> Vec<Value> {
    let Some(conn) = CONN.lock().unwrap().clone() else {
        return Vec::new();
    };
    match get(&conn, "/host/manifests").await {
        Ok(Value::Array(list)) => list
            .into_iter()
            .filter(|m| m["id"] != "deployments")
            .collect(),
        _ => Vec::new(),
    }
}

pub async fn forward(
    method: &str,
    path_and_query: &str,
    content_type: Option<&str>,
    body: Bytes,
) -> Response {
    let Some(conn) = CONN.lock().unwrap().clone() else {
        return error(503, "plugin host unavailable");
    };
    let Ok(method) = reqwest::Method::from_bytes(method.as_bytes()) else {
        return error(405, "method not allowed");
    };
    let mut request = client()
        .request(
            method,
            format!("http://127.0.0.1:{}{path_and_query}", conn.port),
        )
        .header("x-trame-plugin-token", &conn.token)
        .timeout(Duration::from_mins(2))
        .body(body);
    if let Some(content_type) = content_type {
        request = request.header("content-type", content_type);
    }
    let Ok(response) = request.send().await else {
        return error(502, "plugin host unreachable");
    };
    let status =
        StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/json")
        .to_owned();
    match response.bytes().await {
        Ok(bytes) => (status, [("content-type", content_type)], bytes).into_response(),
        Err(_) => error(502, "plugin host response failed"),
    }
}

fn error(status: u16, message: &str) -> Response {
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
        [("content-type", "application/json")],
        json!({ "error": message }).to_string(),
    )
        .into_response()
}
