// Deployments plugin: GitHub/GitLab releases waiting for approval, polled by the backend,
// approved or played from the panel. Fixture-driven in tests (TRACKER_DEPLOYMENTS_FIXTURE).
use super::api::{Plugin, RouteFuture};
pub(crate) use super::encode;
use crate::{db::Db, routes::Native, settings, terminal};
use anyhow::{Context, Result};
use axum::{
    body::Body,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{LazyLock, Mutex},
};

pub mod auth;
pub mod github;
pub mod gitlab;
pub mod live;
pub mod ships;

pub const ID: &str = "deployments";

static STATE: LazyLock<Mutex<Value>> = LazyLock::new(|| Mutex::new(empty_state()));
static FIXTURE_POLL: Mutex<()> = Mutex::new(());
#[allow(
    clippy::cast_sign_loss,
    reason = "values are non-negative by construction"
)]
fn start(state: Native) -> Option<tokio::task::JoinHandle<()>> {
    *STATE.lock().unwrap() = empty_state();
    if state.sync.offline && fixture().ok().flatten().is_none() {
        return None;
    }
    Some(tokio::spawn(async move {
        loop {
            let slice = settings::plugin(&state.settings, ID);
            let mut delay = slice["pollIdleSeconds"]
                .as_i64()
                .map(|n| n.clamp(15, 3600) * 1000)
                .unwrap_or_else(|| {
                    std::env::var("TRACKER_DEPLOYMENTS_POLL_IDLE_MS")
                        .ok()
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(300_000)
                });
            if slice["enabled"] == true {
                let polled = if fixture().ok().flatten().is_some() {
                    let state = state.clone();
                    crate::blocking::spawn(move || {
                        let mut db = Db::connect(
                            &state.root.join("socket"),
                            &state.origin,
                            Some(state.settings.clone()),
                        )
                        .ok()?;
                        db.exclusive(|db| poll(db, &state.settings)).ok()
                    })
                    .await
                    .ok()
                    .flatten()
                } else if !state.sync.offline {
                    live::poll(&state).await.ok()
                } else {
                    None
                };
                if polled.as_ref().is_some_and(|s| s["activePipeline"] == true) {
                    delay = std::env::var("TRACKER_DEPLOYMENTS_POLL_ACTIVE_MS")
                        .ok()
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(10_000);
                }
            }
            tokio::select! {
                () = tokio::time::sleep(std::time::Duration::from_millis(delay.max(1) as u64)) => {},
                () = state.sync.plugin_poll.notified() => {
                    tokio::time::sleep(std::time::Duration::from_secs(4)).await;
                }
            }
        }
    }))
}
fn empty_state() -> Value {
    json!({"configured":false,"items":[],"polledAt":null,"errors":[],"auth":{"github":"none","gitlab":"none"},"activePipeline":false})
}
fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}
fn fixture() -> Result<Option<PathBuf>> {
    let Some(path) = std::env::var_os("TRACKER_DEPLOYMENTS_FIXTURE") else {
        return Ok(None);
    };
    let path = PathBuf::from(path);
    let sample = crate::workspace().join("app/plugins/deployments/fixture.sample.json");
    if path.canonicalize().ok().as_ref() == sample.canonicalize().ok().as_ref() {
        return Ok(Some(sample));
    }
    Ok(Some(crate::scratch_path(&path)?))
}
fn watched(slice: &Value) -> Vec<String> {
    strings(&slice["githubRepos"])
        .into_iter()
        .chain(strings(&slice["gitlabProjects"]))
        .collect()
}
fn base_url(slice: &Value) -> String {
    slice["gitlabBaseUrl"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("https://gitlab.com")
        .trim()
        .trim_end_matches('/')
        .to_owned()
}
#[allow(
    clippy::cast_possible_truncation,
    reason = "values fit by construction (timestamps, ids, pids, JS-number parity)"
)]
fn clamp_idle(raw: &Value) -> Option<i64> {
    let n = raw
        .as_f64()
        .or_else(|| raw.as_str().and_then(|s| s.trim().parse::<f64>().ok()))
        .or_else(|| raw.as_bool().map(|b| if b { 1.0 } else { 0.0 }))?;
    if !n.is_finite() || n <= 0.0 {
        None
    } else {
        Some((n + 0.5).floor().clamp(15.0, 3600.0) as i64)
    }
}
fn sanitize(raw: &Value, current: &Value) -> Value {
    let mut patch = json!({});
    for key in ["githubRepos", "gitlabProjects"] {
        if raw.get(key).is_some() {
            patch[key] = json!(strings(&raw[key]));
        }
    }
    if let Some(s) = raw["gitlabBaseUrl"].as_str() {
        patch["gitlabBaseUrl"] = json!(s.trim());
    }
    if raw.get("ships").is_some() {
        let repos = patch
            .get("githubRepos")
            .map(strings)
            .unwrap_or_else(|| strings(&current["githubRepos"]))
            .into_iter()
            .chain(
                patch
                    .get("gitlabProjects")
                    .map(strings)
                    .unwrap_or_else(|| strings(&current["gitlabProjects"])),
            )
            .collect::<Vec<_>>();
        patch["ships"] = ships::sanitize_rules(&raw["ships"], &repos);
    }
    if raw.get("pollIdleSeconds").is_some() {
        if let Some(n) = clamp_idle(&raw["pollIdleSeconds"]) {
            patch["pollIdleSeconds"] = json!(n);
        }
    }
    for (key, clear) in [
        ("githubToken", "clearGithubToken"),
        ("gitlabToken", "clearGitlabToken"),
    ] {
        if let Some(token) = raw[key].as_str().map(str::trim).filter(|s| !s.is_empty()) {
            patch[key] = json!(token);
        } else if raw[clear] == true
            || key == "gitlabToken"
                && patch.get("gitlabBaseUrl").is_some()
                && patch["gitlabBaseUrl"]
                    != json!(current["gitlabBaseUrl"].as_str().unwrap_or("").trim())
        {
            patch[key] = json!("");
        } else if let Some(token) = current[key].as_str() {
            patch[key] = json!(token);
        }
    }
    patch
}
fn settings_view(slice: &Value) -> Value {
    let state = STATE.lock().unwrap().clone();
    json!({"githubRepos":strings(&slice["githubRepos"]),"gitlabProjects":strings(&slice["gitlabProjects"]),"gitlabBaseUrl":slice["gitlabBaseUrl"].as_str().unwrap_or(""),"githubHasToken":slice["githubToken"].as_str().is_some_and(|s|!s.is_empty()),"gitlabHasToken":slice["gitlabToken"].as_str().is_some_and(|s|!s.is_empty()),"pollIdleSeconds":slice["pollIdleSeconds"].as_i64().unwrap_or(300),"auth":state["auth"],"ships":ships::sanitize_rules(&slice["ships"],&watched(slice)),"shipDefaults":{"github":ships::defaults("github"),"gitlab":ships::defaults("gitlab")},"enabled":slice["enabled"]==true})
}
fn key(item: &Value) -> String {
    format!(
        "{}\n{}",
        item["url"].as_str().unwrap_or(""),
        item["environment"].as_str().unwrap_or("")
    )
}
fn poll(db: &mut Db, settings_path: &std::path::Path) -> Result<Value> {
    let _guard = FIXTURE_POLL
        .lock()
        .map_err(|_| anyhow::anyhow!("fixture poll unavailable"))?;
    let slice = settings::plugin(settings_path, ID);
    let Some(path) = fixture()? else {
        return Ok(empty_state());
    };
    let fixture: Value = serde_json::from_slice(&std::fs::read(path)?)?;
    let mut items = fixture["items"].as_array().cloned().unwrap_or_default();
    for item in &mut items {
        if item.get("status").is_none() {
            item["status"] = json!("waiting");
        }
    }
    ships::with_fixture_ships(db, &mut items, &slice, &fixture["changelogs"])?;
    items.sort_by(|a, b| {
        let rank = |v: &Value| match v["status"].as_str() {
            Some("failed") => 0,
            Some("waiting") => 1,
            _ => 2,
        };
        rank(a)
            .cmp(&rank(b))
            .then_with(|| a["waitingSince"].as_str().cmp(&b["waitingSince"].as_str()))
    });
    let ignored = strings(&slice["ignored"]);
    for item in &mut items {
        item["ignored"] = json!(ignored.contains(&key(item)));
    }
    let state = json!({"configured":true,"items":items,"polledAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"errors":fixture["errors"].as_array().cloned().unwrap_or_default(),"auth":{"github":"none","gitlab":"none"},"activePipeline":false});
    *STATE.lock().unwrap() = state.clone();
    Ok(state)
}
fn drop_item(body: &Value) -> Value {
    let mut state = STATE.lock().unwrap();
    let items = state["items"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| i["url"] != body["url"] || i["environment"] != body["environment"])
        .collect::<Vec<_>>();
    state["items"] = json!(items);
    state.clone()
}
fn ignore(settings_path: &std::path::Path, body: &Value) -> Result<(u16, Value)> {
    let url = body["url"].as_str().unwrap_or("");
    let env = body["environment"].as_str().unwrap_or("");
    if url.is_empty() || env.is_empty() {
        return Ok((400, json!({"ok":false,"error":"bad request"})));
    }
    let key = format!("{url}\n{env}");
    let mark = body["ignored"] != false;
    let known = STATE.lock().unwrap()["items"]
        .as_array()
        .is_some_and(|a| a.iter().any(|i| self::key(i) == key));
    if mark && !known {
        return Ok((404, json!({"ok":false,"error":"unknown deployment"})));
    }
    let mut ignored = strings(&settings::plugin(settings_path, ID)["ignored"]);
    ignored.retain(|s| s != &key);
    if mark {
        ignored.push(key.clone());
    }
    settings::save_plugin(settings_path, ID, &json!({"ignored":ignored}))?;
    let mut state = STATE.lock().unwrap();
    if let Some(items) = state["items"].as_array_mut() {
        for item in items {
            if self::key(item) == key {
                item["ignored"] = json!(mark);
            }
        }
    }
    Ok((200, json!({"ok":true,"state":state.clone()})))
}
fn login_command(forge: &str, host: &str) -> Option<String> {
    if !host
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        || host.is_empty()
    {
        return None;
    }
    Some(if forge == "github" {
        "gh auth login --hostname github.com --git-protocol https --web".into()
    } else {
        format!("glab auth login --hostname {host}")
    })
}
fn hostname(base: &str) -> Result<String> {
    Ok(reqwest::Url::parse(base)?
        .host_str()
        .context("missing host")?
        .to_owned())
}
#[allow(
    clippy::needless_pass_by_value,
    reason = "callers pass json! temporaries"
)]
fn json_response(status: u16, value: Value) -> Response {
    (
        StatusCode::from_u16(status).unwrap(),
        [("content-type", "application/json")],
        crate::json::stringify(&value),
    )
        .into_response()
}
fn route(
    db: &mut Db,
    settings_path: &std::path::Path,
    method: &str,
    sub: &str,
    query: &str,
    body: &Value,
) -> Result<(u16, Value)> {
    let slice = settings::plugin(settings_path, ID);
    match (sub, method) {
        ("/state", _) => Ok((200, STATE.lock().unwrap().clone())),
        ("/refresh", "POST") => Ok((200, poll(db, settings_path)?)),
        ("/approve" | "/cancel", "POST") => Ok((200, json!({"ok":true,"state":drop_item(body)}))),
        ("/ignore", "POST") => ignore(settings_path, body),
        ("/changelog", "POST") => {
            if let Some(path) = fixture()? {
                let fixture: Value = serde_json::from_slice(&std::fs::read(path)?)?;
                let commits = &fixture["changelogs"][body["url"].as_str().unwrap_or("")];
                Ok((
                    200,
                    if commits.is_array() {
                        json!({"ok":true,"baseline":null,"compareUrl":null,"commits":commits})
                    } else {
                        json!({"ok":false,"error":"no changelog available"})
                    },
                ))
            } else {
                Ok((404, json!({"ok":false,"error":"unknown deployment"})))
            }
        }
        ("/test", "POST") => Ok((
            200,
            if fixture()?.is_some() {
                json!({"ok":true,"user":"fixture","source":"none"})
            } else {
                json!({"ok":false,"source":"none","error":"no token found (PAT, GITHUB_TOKEN or gh cli)"})
            },
        )),
        ("/auth-status", _) => {
            let url = reqwest::Url::parse(&format!("http://localhost/?{query}"))?;
            let base = url
                .query_pairs()
                .find(|(k, _)| k == "gitlabBaseUrl")
                .map(|(_, v)| v.to_string())
                .unwrap_or_else(|| base_url(&slice));
            let host = hostname(&base)?;
            Ok((
                200,
                json!({"github":{"cli":false,"source":"none","loginCommand":login_command("github","github.com")},"gitlab":{"cli":false,"source":"none","loginCommand":login_command("gitlab",&host)}}),
            ))
        }
        ("/login", "POST") => {
            let base = body["gitlabBaseUrl"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| {
                    slice["gitlabBaseUrl"]
                        .as_str()
                        .unwrap_or("https://gitlab.com")
                });
            let host = if body["forge"] == "github" {
                "github.com".to_owned()
            } else {
                hostname(base)?
            };
            let command = login_command(body["forge"].as_str().unwrap_or("gitlab"), &host);
            let launched = command.as_ref().is_some_and(|c| {
                terminal::spawn_terminal(
                    &std::env::var("HOME").unwrap_or_else(|_| ".".into()),
                    c,
                    "window",
                )
            });
            Ok((200, json!({"launched":launched,"command":command})))
        }
        _ => Ok((404, json!({"error":"not found"}))),
    }
}

/// Database-level entry (integration tests): the registry's gate and settings handling for
/// this plugin, then `route`, all on the caller's connection.
#[doc(hidden)]
pub fn handle(
    db: &mut Db,
    settings_path: &std::path::Path,
    method: &str,
    path: &str,
    query: &str,
    body: &Value,
) -> Result<(u16, Value)> {
    if path == "/api/plugins" {
        return Ok((200, json!([super::api::manifest(&PLUGIN, settings_path)])));
    }
    let Some(sub) = path.strip_prefix("/api/plugins/deployments") else {
        return Ok((404, json!({"error":"unknown plugin"})));
    };
    if let Some(answer) = super::api::handle_sync(&PLUGIN, settings_path, method, sub, body)? {
        if sub == "/enable" && body["enabled"] == true {
            let _ = poll(db, settings_path);
        }
        return Ok(answer);
    }
    route(db, settings_path, method, sub, query, body)
}

pub struct Deployments;
pub static PLUGIN: Deployments = Deployments;

impl Plugin for Deployments {
    fn id(&self) -> &'static str {
        ID
    }
    fn label(&self) -> &'static str {
        "Deployments"
    }
    fn glyph(&self) -> &'static str {
        "⇈"
    }
    fn description(&self) -> &'static str {
        "GitHub & GitLab releases waiting for approval, in the sidebar."
    }
    fn badge(&self, _slice: &Value) -> Option<u64> {
        let state = STATE.lock().unwrap();
        let count = state["items"]
            .as_array()
            .map(|a| a.iter().filter(|i| i["ignored"] != true).count())
            .unwrap_or(0);
        (count > 0).then_some(count as u64)
    }
    fn ungated(&self, sub: &str) -> bool {
        matches!(sub, "/test" | "/auth-status" | "/login")
    }
    fn sanitize(&self, raw: &Value, current: &Value) -> Value {
        sanitize(raw, current)
    }
    fn settings_view(&self, slice: &Value) -> Value {
        settings_view(slice)
    }
    fn start(&'static self, native: Native) -> Option<tokio::task::JoinHandle<()>> {
        if native.demo.active {
            return None;
        }
        start(native)
    }
    fn on_enabled(&'static self, native: &Native) {
        if fixture().ok().flatten().is_some() {
            let native = native.clone();
            drop(crate::blocking::spawn(move || {
                let mut db = Db::connect(
                    &native.root.join("socket"),
                    &native.origin,
                    Some(native.settings.clone()),
                )?;
                db.exclusive(|db| poll(db, &native.settings))
            }));
        } else if !native.sync.offline {
            native.sync.plugin_poll.notify_one();
        }
    }
    fn route(&'static self, native: Native, sub: String, req: Request<Body>) -> RouteFuture {
        Box::pin(async move {
            let fixture = fixture().ok().flatten().is_some();
            if native.sync.offline && !fixture {
                return json_response(503, json!({"error":"unavailable in offline mode"}));
            }
            let method = req.method().to_string();
            let query = req.uri().query().unwrap_or("").to_owned();
            let Ok(bytes) = axum::body::to_bytes(req.into_body(), usize::MAX).await else {
                return json_response(500, json!({"error":"body unavailable"}));
            };
            let body = serde_json::from_slice::<Value>(&bytes).unwrap_or_else(|_| json!({}));
            if !fixture {
                let path = format!("/api/plugins/{ID}{sub}");
                match live::handle(&native, &method, &path, &query, &body).await {
                    Ok(Some((status, value))) => return json_response(status, value),
                    Err(_) => return json_response(500, json!({"error":"Internal Server Error"})),
                    Ok(None) => {}
                }
            }
            let result = crate::blocking::spawn(move || -> Result<(u16, Value)> {
                let mut db = Db::connect(
                    &native.root.join("socket"),
                    &native.origin,
                    Some(native.settings.clone()),
                )?;
                db.exclusive(|db| route(db, &native.settings, &method, &sub, &query, &body))
            })
            .await;
            match result {
                Ok(Ok((status, value))) => json_response(status, value),
                _ => json_response(500, json!({"error":"Internal Server Error"})),
            }
        })
    }
}
