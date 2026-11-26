use axum::{
    body::{Body, to_bytes},
    extract::{
        FromRequest,
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
    },
    http::{Method, Request},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::sync::broadcast;

use crate::db::Db;
use crate::pty::TOKEN_HEADER;
use crate::routes::Native;
use crate::routes::json_response;

pub mod claude;
pub mod codex;
pub mod run;

use claude::Launch;
use run::{Provider, Run, valid_choice as valid};

pub const CLOSE_AUTH: u16 = 4401;
pub const CLOSE_GONE: u16 = 4404;
const MODES: &[&str] = &["auto", "manual", "default", "acceptEdits", "plan"];

/// The structured agent view; the app offers it as an opt-in setting, `TRAME_AGENT_VIEW=0` turns it off.
pub fn enabled() -> bool {
    std::env::var("TRAME_AGENT_VIEW").map_or(true, |v| v != "0")
}

fn runs() -> &'static Mutex<HashMap<String, Arc<Run>>> {
    static RUNS: OnceLock<Mutex<HashMap<String, Arc<Run>>>> = OnceLock::new();
    RUNS.get_or_init(Mutex::default)
}

fn get(id: &str) -> Option<Arc<Run>> {
    runs().lock().unwrap().get(id).cloned()
}

// Runs that survive a restart

// set once this workspace restored its runs (never the demo's)
static SAVED: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Write every run's record, atomically, so the next launch lists them stopped.
fn save() {
    let Some(path) = SAVED.lock().unwrap().clone() else {
        return;
    };
    let records: Vec<Value> = runs()
        .lock()
        .unwrap()
        .values()
        .map(|r| r.record())
        .collect();
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(
        &tmp,
        serde_json::to_vec_pretty(&records).unwrap_or_default(),
    )
    .is_ok()
    {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// The runs open when Trame last stopped, back as stopped runs showing their latest history.
/// Nothing restarts by itself: an old prompt or decision is never sent again.
pub async fn restore(native: &Native) -> usize {
    let path = native.root.join("agent-runs.json");
    *SAVED.lock().unwrap() = Some(path.clone());
    let records: Vec<Value> = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let mut n = 0;
    for r in records {
        let (Some(id), Some(cwd), Some(session)) =
            (r["id"].as_str(), r["cwd"].as_str(), r["sessionId"].as_str())
        else {
            continue;
        };
        let provider = r["provider"]
            .as_str()
            .and_then(Provider::parse)
            .unwrap_or(Provider::Claude);
        let history = history(native, provider, session).await;
        let text = |k: &str| r[k].as_str().filter(|v| valid(v)).map(str::to_owned);
        let launch = Launch {
            mode: text("mode").filter(|m| MODES.contains(&m.as_str())),
            model: text("model"),
            effort: text("effort"),
        };
        let run = Run::new(
            id.to_owned(),
            cwd.into(),
            provider,
            Some(session.to_owned()),
            launch,
            history,
        );
        runs().lock().unwrap().insert(id.to_owned(), run);
        n += 1;
    }
    n
}

/// The latest page of a conversation's transcript, shown above what a resumed run adds.
async fn history(native: &Native, provider: Provider, session: &str) -> Vec<Value> {
    let (native, session) = (native.clone(), session.to_owned());
    crate::blocking::spawn(move || {
        let db = Db::connect(
            &native.root.join("socket"),
            &native.origin,
            Some(native.settings),
        )
        .ok()?;
        let path = crate::imports::transcript_path(&db, provider.name(), &session).ok()??;
        Some(
            crate::imports::history::before(&path, None, provider == Provider::Codex)
                .ok()?
                .items,
        )
    })
    .await
    .ok()
    .flatten()
    .unwrap_or_default()
}

/// Kill every agent child on the way out; their records stay for the next launch.
pub fn shutdown() {
    save();
    for run in runs().lock().unwrap().drain().map(|(_, r)| r) {
        run.kill();
    }
}

/// Who else is writing to conversation `session`, if anyone: one writer per conversation.
fn owner(provider: Provider, session: &str) -> Option<Value> {
    if let Some(run) = runs()
        .lock()
        .unwrap()
        .values()
        .find(|r| r.running() && r.session() == session)
    {
        return Some(
            json!({"error":"this conversation is already open in the agent view","run":run.id}),
        );
    }
    // only Claude says which conversations its processes hold
    (provider == Provider::Claude && crate::pty::live_claude_sessions().contains_key(session))
        .then(|| json!({"error":"this conversation is running in another terminal: close it there first"}))
}

pub fn owns(path: &str) -> bool {
    path == "/api/agent" || path.starts_with("/api/agent/")
}

pub async fn serve(native: Native, req: Request<Body>) -> Response {
    if !enabled() {
        return json_response(
            404,
            json!({"error":"agent view is off (TRAME_AGENT_VIEW=0)"}),
        );
    }
    let path = req.uri().path().to_owned();
    let parts: Vec<&str> = path.split('/').collect();
    if let ["", "api", "agent", "runs", id, "ws"] = parts.as_slice() {
        // browsers can't set headers on a WebSocket: the token comes in the first frame
        let id = (*id).to_owned();
        return match WebSocketUpgrade::from_request(req, &()).await {
            Ok(upgrade) => upgrade.on_upgrade(move |ws| session(ws, id)),
            Err(e) => e.into_response(),
        };
    }
    let token = req
        .headers()
        .get(TOKEN_HEADER)
        .and_then(|v| v.to_str().ok());
    if token != Some(crate::pty::token()) {
        return json_response(401, json!({"error":"terminal token required"}));
    }
    let method = req.method().clone();
    let body: Value = match to_bytes(req.into_body(), 1 << 20).await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => return json_response(400, json!({"error":"body too large"})),
    };
    match (method, parts.as_slice()) {
        (Method::GET, ["", "api", "agent", "runs"]) => {
            let list: Vec<Value> = runs()
                .lock()
                .unwrap()
                .values()
                .map(|r| r.summary())
                .collect();
            json_response(200, Value::Array(list))
        }
        (Method::POST, ["", "api", "agent", "runs"]) => start(&native, &body).await,
        (Method::POST, ["", "api", "agent", "handoff"]) => from_terminal(&native, &body).await,
        (Method::GET, ["", "api", "agent", "runs", id]) => match get(id) {
            Some(run) => json_response(200, run.snapshot()),
            None => json_response(404, json!({"error":"no such run"})),
        },
        (Method::POST, ["", "api", "agent", "runs", id, "restart"]) => {
            let Some(run) = get(id) else {
                return json_response(404, json!({"error":"no such run"}));
            };
            if let Some(taken) = (!run.running())
                .then(|| owner(run.provider, &run.session()))
                .flatten()
            {
                return json_response(409, taken);
            }
            match run.restart() {
                Ok(()) => {
                    save();
                    json_response(200, json!({"ok":true}))
                }
                Err(e) => json_response(409, json!({"error":e})),
            }
        }
        (Method::POST, ["", "api", "agent", "runs", id, "handoff"]) => to_terminal(id).await,
        (Method::DELETE, ["", "api", "agent", "runs", id]) => {
            let removed = runs().lock().unwrap().remove(*id);
            match removed {
                Some(run) => {
                    run.stop();
                    save();
                    json_response(200, json!({"ok":true}))
                }
                None => json_response(404, json!({"error":"no such run"})),
            }
        }
        _ => json_response(404, json!({"error":"not found"})),
    }
}

/// `{cwd, provider?, resume?, mode?}`: start Claude Code or Codex in an existing directory, fresh or
/// resuming a conversation.
async fn start(native: &Native, body: &Value) -> Response {
    let Some(provider) = Provider::parse(body["provider"].as_str().unwrap_or("claude")) else {
        return json_response(400, json!({"error":"unknown provider"}));
    };
    let Some(cwd) = body["cwd"]
        .as_str()
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && p.is_dir())
    else {
        return json_response(
            400,
            json!({"error":"cwd must be an existing absolute directory"}),
        );
    };
    let resume = body["resume"].as_str().map(str::to_owned);
    if resume
        .as_deref()
        .is_some_and(|r| uuid::Uuid::parse_str(r).is_err())
    {
        return json_response(400, json!({"error":"resume must be a session id"}));
    }
    let mode = body["mode"].as_str().map(str::to_owned);
    // Codex has no permission modes to start in
    if mode
        .as_deref()
        .is_some_and(|m| !MODES.contains(&m) || provider == Provider::Codex)
    {
        return json_response(400, json!({"error":"unknown permission mode"}));
    }
    let (model, effort) = (body["model"].as_str(), body["effort"].as_str());
    if model.into_iter().chain(effort).any(|v| !valid(v)) {
        return json_response(400, json!({"error":"unknown model or effort"}));
    }
    let launch = Launch {
        // Claude starts in Auto unless asked otherwise
        mode: mode.or_else(|| (provider == Provider::Claude).then(|| "auto".to_owned())),
        model: model.map(str::to_owned),
        effort: effort.map(str::to_owned),
    };
    if let Some(taken) = resume.as_deref().and_then(|s| owner(provider, s)) {
        return json_response(409, taken);
    }
    start_run(native, provider, cwd, resume, launch).await
}

async fn start_run(
    native: &Native,
    provider: Provider,
    cwd: PathBuf,
    resume: Option<String>,
    launch: Launch,
) -> Response {
    let history = match &resume {
        Some(session) => history(native, provider, session).await,
        None => Vec::new(),
    };
    let id = uuid::Uuid::new_v4().simple().to_string();
    match Run::start(id.clone(), cwd, provider, resume, launch, history) {
        Ok(run) => {
            let summary = run.summary();
            runs().lock().unwrap().insert(id, run);
            save();
            json_response(201, summary)
        }
        Err(e) => json_response(
            500,
            json!({"error":format!("could not start the agent: {e}")}),
        ),
    }
}

#[allow(unsafe_code, reason = "signal 0 only checks that the pid exists")]
fn alive(pid: u32) -> bool {
    i32::try_from(pid).is_ok_and(|p| unsafe { libc::kill(p, 0) } == 0)
}

/// `{term}`: move the idle Claude conversation of a Trame shell into the agent view. The shell's
/// Claude exits first (Ctrl+C, as a user would), then the same conversation resumes in its folder.
async fn from_terminal(native: &Native, body: &Value) -> Response {
    let Some(term) = body["term"].as_str() else {
        return json_response(400, json!({"error":"term required"}));
    };
    let Some(agent) = crate::pty::claude_in_shell(term).await else {
        return json_response(
            404,
            json!({"error":"no Claude conversation runs in that shell"}),
        );
    };
    if !agent.idle {
        return json_response(
            409,
            json!({"error":"Claude is working or waiting in that shell: let it finish first"}),
        );
    }
    let Some(cwd) = agent.cwd.map(PathBuf::from).filter(|p| p.is_dir()) else {
        return json_response(409, json!({"error":"the conversation's folder is gone"}));
    };
    // the first Ctrl+C clears a draft, the next ones exit an idle prompt
    for _ in 0..4 {
        if !alive(agent.pid) {
            break;
        }
        crate::pty::type_into(term, b"\x03");
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while alive(agent.pid) {
        if tokio::time::Instant::now() > deadline {
            return json_response(409, json!({"error":"Claude didn't exit in that shell"}));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    start_run(
        native,
        Provider::Claude,
        cwd,
        Some(agent.id),
        Launch::default(),
    )
    .await
}

/// Move an idle run back to a Trame shell: stop it, then resume the same conversation there.
async fn to_terminal(id: &str) -> Response {
    let Some(run) = get(id) else {
        return json_response(404, json!({"error":"no such run"}));
    };
    if run.running() && !run.idle() {
        return json_response(
            409,
            json!({"error":"the agent is working or waiting on you: finish that first"}),
        );
    }
    if run.running() && !run.stop_and_wait(Duration::from_secs(6)).await {
        return json_response(409, json!({"error":"the agent didn't stop"}));
    }
    runs().lock().unwrap().remove(id);
    save();
    let session = run.session();
    let cwd = run.cwd.display().to_string();
    let command = run.provider.resume_command(&session);
    let title = if run.provider == Provider::Codex {
        "Codex"
    } else {
        "Claude"
    };
    match crate::blocking::spawn(move || {
        crate::pty::spawn(None, &cwd, Some(&command), title, None, None)
    })
    .await
    {
        Ok(Ok(term)) => json_response(200, json!({"term":term.summary()["id"]})),
        _ => json_response(500, json!({"error":"could not open a terminal"})),
    }
}

async fn close(ws: &mut WebSocket, code: u16, reason: &'static str) {
    let _ = ws
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })))
        .await;
}

async fn send_json(ws: &mut WebSocket, value: &Value) -> bool {
    ws.send(Message::Text(value.to_string().into()))
        .await
        .is_ok()
}

/// One client: `{type:"attach",token,epoch?,afterSeq?,role}` first; then `{type:"command"}` in and
/// `{type:"reply"}`, events, snapshots and lease changes out.
async fn session(mut ws: WebSocket, id: String) {
    let first = tokio::time::timeout(Duration::from_secs(5), ws.recv()).await;
    let hello = match first {
        Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str::<Value>(&text).ok(),
        _ => None,
    };
    let Some(hello) = hello.filter(|a| a["type"] == "attach" && a["token"] == crate::pty::token())
    else {
        return close(&mut ws, CLOSE_AUTH, "unauthorized").await;
    };
    let Some(run) = get(&id) else {
        return close(&mut ws, CLOSE_GONE, "no such run").await;
    };
    let attached = run.attach(
        hello["epoch"].as_str(),
        hello["afterSeq"].as_u64(),
        hello["role"] == "writer",
    );
    let mut lease = attached.lease;
    let mut rx = attached.rx;
    let mut resync: Option<(Value, u64)> = None;
    if !send_json(
        &mut ws,
        &json!({"type":"attached","runId":id,"lease":lease}),
    )
    .await
    {
        return;
    }
    for frame in &attached.first {
        if !send_json(&mut ws, frame).await {
            return;
        }
    }
    loop {
        tokio::select! {
            event = rx.recv() => match event {
                Ok(event) => {
                    // a newer writer took the lease: this client keeps watching
                    if event["type"] == "lease" && lease != 0 && event["writer"].as_u64() != Some(lease) {
                        lease = 0;
                    }
                    // already folded into the snapshot sent after a lag
                    let stale = resync.as_ref().is_some_and(|(epoch, seq)| {
                        event["epoch"] == *epoch && event["seq"].as_u64().is_some_and(|s| s <= *seq)
                    });
                    if !stale && !send_json(&mut ws, &event).await {
                        return;
                    }
                }
                // fell behind the live stream: resync from the state, not from the ring
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let snapshot = run.snapshot();
                    resync = Some((snapshot["epoch"].clone(), snapshot["seq"].as_u64().unwrap_or(0)));
                    if !send_json(&mut ws, &snapshot).await {
                        return;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => return,
            },
            message = ws.recv() => match message {
                Some(Ok(Message::Text(text))) => {
                    let msg = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
                    if msg["type"] != "command" {
                        continue;
                    }
                    let reply = match run.command(lease, &msg) {
                        Ok(()) => json!({"type":"reply","commandId":msg["commandId"],"accepted":true}),
                        Err(reason) => json!({"type":"reply","commandId":msg["commandId"],"accepted":false,"reason":reason}),
                    };
                    if !send_json(&mut ws, &reply).await {
                        return;
                    }
                }
                Some(Ok(Message::Close(_)) | Err(_)) | None => return,
                Some(Ok(_)) => {}
            },
        }
    }
}
