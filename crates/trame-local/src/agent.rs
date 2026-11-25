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

use crate::pty::TOKEN_HEADER;
use crate::routes::json_response;

pub mod claude;
pub mod run;

use run::Run;

pub const CLOSE_AUTH: u16 = 4401;
pub const CLOSE_GONE: u16 = 4404;

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

/// Kill every agent child on the way out; their conversations stay resumable.
pub fn shutdown() {
    for run in runs().lock().unwrap().drain().map(|(_, r)| r) {
        run.kill();
    }
}

pub fn owns(path: &str) -> bool {
    path == "/api/agent" || path.starts_with("/api/agent/")
}

pub async fn serve(req: Request<Body>) -> Response {
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
        (Method::POST, ["", "api", "agent", "runs"]) => {
            let Ok(bytes) = to_bytes(req.into_body(), 1 << 20).await else {
                return json_response(400, json!({"error":"body too large"}));
            };
            let body: Value = serde_json::from_slice(&bytes).unwrap_or_default();
            start(&body)
        }
        (Method::GET, ["", "api", "agent", "runs", id]) => match get(id) {
            Some(run) => json_response(200, run.snapshot()),
            None => json_response(404, json!({"error":"no such run"})),
        },
        (Method::POST, ["", "api", "agent", "runs", id, "restart"]) => {
            match get(id).map(|r| r.restart()) {
                Some(Ok(())) => json_response(200, json!({"ok":true})),
                Some(Err(e)) => json_response(409, json!({"error":e})),
                None => json_response(404, json!({"error":"no such run"})),
            }
        }
        (Method::DELETE, ["", "api", "agent", "runs", id]) => {
            match runs().lock().unwrap().remove(*id) {
                Some(run) => {
                    run.stop();
                    json_response(200, json!({"ok":true}))
                }
                None => json_response(404, json!({"error":"no such run"})),
            }
        }
        _ => json_response(404, json!({"error":"not found"})),
    }
}

/// `{cwd, resume?}`: start Claude Code in an existing directory, fresh or resuming a conversation.
fn start(body: &Value) -> Response {
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
    if mode
        .as_deref()
        .is_some_and(|m| !["default", "acceptEdits", "plan"].contains(&m))
    {
        return json_response(400, json!({"error":"unknown permission mode"}));
    }
    let bin = std::env::var("TRAME_CLAUDE_BIN").unwrap_or_else(|_| "claude".into());
    let id = uuid::Uuid::new_v4().simple().to_string();
    match Run::start(id.clone(), cwd, bin, resume, mode) {
        Ok(run) => {
            let summary = run.summary();
            runs().lock().unwrap().insert(id, run);
            json_response(201, summary)
        }
        Err(e) => json_response(
            500,
            json!({"error":format!("could not start the agent: {e}")}),
        ),
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
