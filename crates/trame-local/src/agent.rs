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

use crate::db::Db;
use crate::pty::TOKEN_HEADER;
use crate::routes::Native;
use crate::routes::json_response;

pub(crate) mod bots;
pub mod claude;
pub mod codex;
pub(crate) mod connector;
pub mod relay;
pub mod run;
pub(crate) mod runner;
pub(crate) mod slack;

use claude::Launch;
use run::{Provider, Run, valid_choice as valid};

pub const CLOSE_AUTH: u16 = 4401;
/// The header a hook presents its run's secret in.
pub const HOOK_HEADER: &str = "x-trame-hook";
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

// Runs that survive a restart, in this machine's `agent_runs` table

enum Write {
    Records(Vec<Value>),
    Flush(std::sync::mpsc::SyncSender<()>),
}

// set once this workspace restored its runs (never the demo's)
static WRITER: Mutex<Option<std::sync::mpsc::Sender<Write>>> = Mutex::new(None);

/// Keep `agent_runs` equal to `records`: the postgres client blocks, so it gets its own thread.
fn write_runs(db: &mut Db, records: &[Value]) -> anyhow::Result<()> {
    let records = json!(serde_json::to_string(records)?);
    db.query(
        "delete from agent_runs
          where id <> all(array(select r->>'id' from jsonb_array_elements($1::text::jsonb) r))",
        std::slice::from_ref(&records),
    )?;
    db.query(
        "insert into agent_runs (id, record)
         select r->>'id', r from jsonb_array_elements($1::text::jsonb) r
         on conflict (id) do update set record = excluded.record",
        &[records],
    )?;
    Ok(())
}

fn start_writer(native: &Native) {
    let (tx, rx) = std::sync::mpsc::channel::<Write>();
    let native = native.clone();
    std::thread::spawn(move || {
        let mut db: Option<Db> = None;
        while let Ok(first) = rx.recv() {
            // only the latest snapshot matters
            let (mut latest, mut acks) = (None, Vec::new());
            for write in std::iter::once(first).chain(rx.try_iter()) {
                match write {
                    Write::Records(r) => latest = Some(r),
                    Write::Flush(ack) => acks.push(ack),
                }
            }
            if let Some(records) = latest {
                if db.is_none() {
                    db = Db::connect(
                        &native.root.join("socket"),
                        &native.origin,
                        Some(native.settings.clone()),
                    )
                    .ok();
                }
                let written = db.as_mut().map(|db| write_runs(db, &records));
                if !matches!(written, Some(Ok(()))) {
                    eprintln!("agent view: could not save the runs");
                    db = None;
                }
            }
            for ack in acks {
                let _ = ack.send(());
            }
        }
    });
    *WRITER.lock().unwrap() = Some(tx);
}

/// Record every run, so the next launch lists them stopped.
fn save() {
    let writer = WRITER.lock().unwrap();
    let Some(writer) = writer.as_ref() else {
        return;
    };
    let records: Vec<Value> = runs()
        .lock()
        .unwrap()
        .values()
        .map(|r| r.record())
        .collect();
    let _ = writer.send(Write::Records(records));
}

/// Wait, up to `limit`, until what `save` sent is written.
fn flush(limit: Duration) {
    let (ack, done) = std::sync::mpsc::sync_channel(1);
    let sent = WRITER
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|w| w.send(Write::Flush(ack)).is_ok());
    if sent {
        let _ = done.recv_timeout(limit);
    }
}

/// The saved records, taking over a JSON file an older Trame left (read once, then removed).
async fn saved_runs(native: &Native) -> Vec<Value> {
    let legacy = native.root.join("agent-runs.json");
    let read = with_db(native, move |db| {
        let mut rows: Vec<Value> = db
            .query("select record from agent_runs", &[])?
            .into_iter()
            .map(|mut r| r["record"].take())
            .collect();
        if let Some(old) = std::fs::read(&legacy)
            .ok()
            .and_then(|b| serde_json::from_slice::<Vec<Value>>(&b).ok())
        {
            let old: Vec<Value> = old.into_iter().filter(|r| r["id"].is_string()).collect();
            if rows.is_empty() {
                write_runs(db, &old)?;
                rows = old;
            }
            std::fs::remove_file(&legacy)?;
        }
        Ok(rows)
    })
    .await;
    read.unwrap_or_else(|e| {
        eprintln!("agent view: could not read the saved runs: {e:#}");
        Vec::new()
    })
}

/// The runs open when Trame last stopped, back as stopped runs showing their latest history.
/// Nothing restarts by itself: an old prompt or decision is never sent again.
pub async fn restore(native: &Native) -> usize {
    let records = saved_runs(native).await;
    start_writer(native);
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
            text("hook"),
            history,
        );
        if r["relay"] == true {
            run.set_relay(true);
        }
        run.set_bot(r["bot"].as_str());
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

/// Hand the agent relay's incoming messages to the run that listens, as fast as its inbox takes them.
pub async fn bridge() {
    let every = std::env::var("TRAME_RELAY_POLL_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3000);
    loop {
        tokio::time::sleep(Duration::from_millis(every)).await;
        let listener = runs().lock().unwrap().values().find(|r| r.relay()).cloned();
        let Some(run) = listener else {
            continue;
        };
        let Some(relay) = relay::locate() else {
            run.relay_error(Some("no agent relay is set up on this machine"));
            continue;
        };
        let room = run.reserve_relay_slots();
        if room == 0 {
            continue;
        }
        match relay.take(room).await {
            Ok(messages) => {
                run.relay_error(None);
                for m in messages {
                    let from = m["from"].as_str().unwrap_or("an unknown peer");
                    let body = m["body"].as_str().unwrap_or_default();
                    let _ = run.deliver(
                        &format!("relay peer {from}"),
                        &relay::prompt(from, body),
                        None,
                    );
                }
            }
            Err(e) => run.relay_error(Some(&e)),
        }
        run.release_relay_slots();
    }
}

/// Kill every agent child on the way out; their records stay for the next launch.
pub fn shutdown() {
    save();
    flush(Duration::from_secs(3));
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
    let (token, hook, query) = {
        let header = |name: &str| {
            req.headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        };
        (
            header(TOKEN_HEADER),
            header(HOOK_HEADER),
            req.uri().query().unwrap_or_default().to_owned(),
        )
    };
    let method = req.method().clone();
    let body: Value = match to_bytes(req.into_body(), 1 << 20).await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => return json_response(400, json!({"error":"body too large"})),
    };
    // a CLI without custom headers may pass the app token in the query or the body
    let token = token
        .or_else(|| {
            query
                .split('&')
                .find_map(|kv| kv.strip_prefix("token="))
                .map(str::to_owned)
        })
        .or_else(|| body["token"].as_str().map(str::to_owned));
    let app = token.as_deref() == Some(crate::pty::token());
    // a hook holds only its run's own secret, which opens that run's inbox and nothing else
    if let (&Method::POST, ["", "api", "agent", "runs", id, "inbox"]) = (&method, parts.as_slice())
    {
        let Some(run) = get(id) else {
            return json_response(404, json!({"error":"no such run"}));
        };
        let hooked = hook
            .or_else(|| body["hook"].as_str().map(str::to_owned))
            .is_some_and(|h| h == run.hook_token());
        if !app && !hooked {
            return json_response(
                401,
                json!({"error":"terminal token or this run's hook token required"}),
            );
        }
        let text = body["text"].as_str().unwrap_or_default();
        if text.trim().is_empty() || text.len() > 64 << 10 {
            return json_response(400, json!({"error":"text required, up to 64 KiB"}));
        }
        let from = body["from"]
            .as_str()
            .filter(|f| !f.trim().is_empty() && f.len() <= 120)
            .unwrap_or(if hooked { "a hook" } else { "Trame" });
        // a run names itself as sender so the receiver can answer it
        let (key, from) = if app {
            match get(from) {
                Some(sender) => (
                    sender.id.clone(),
                    format!(
                        "run {} ({})",
                        sender.id,
                        sender.cwd.file_name().unwrap_or_default().to_string_lossy()
                    ),
                ),
                None => ("app".to_owned(), from.to_owned()),
            }
        } else {
            let label = if from == "a hook" {
                from.to_owned()
            } else {
                format!("a hook ({from})")
            };
            ("hook".to_owned(), label)
        };
        return match run.deliver(&from, text, Some(&key)) {
            Ok(queued) => json_response(202, json!({"queued":queued})),
            Err(e) => json_response(429, json!({"error":e})),
        };
    }
    if let ["", "api", "agent", "bots", rest @ ..] = parts.as_slice() {
        return bot_route(&native, &method, rest, app, hook, &body).await;
    }
    if !app {
        return json_response(401, json!({"error":"terminal token required"}));
    }
    match (method, parts.as_slice()) {
        (Method::POST, ["", "api", "agent", "relay", "send"]) => send_peer(&body).await,
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
        // `{on}`: this run takes the agent relay's incoming messages; one run at a time does
        (Method::POST, ["", "api", "agent", "runs", id, "relay"]) => {
            let Some(run) = get(id) else {
                return json_response(404, json!({"error":"no such run"}));
            };
            let on = body["on"] == true;
            if on {
                for other in runs()
                    .lock()
                    .unwrap()
                    .values()
                    .filter(|r| r.id != run.id && r.relay())
                {
                    other.set_relay(false);
                }
            }
            run.set_relay(on);
            save();
            json_response(200, json!({"on":on}))
        }
        // what a hook posts with: the run's inbox URL and its secret
        (Method::GET, ["", "api", "agent", "runs", id, "hook"]) => match get(id) {
            Some(run) => {
                let url = format!("http://127.0.0.1:{}/api/agent/runs/{id}/inbox", native.port);
                json_response(
                    200,
                    json!({"url":url,"token":run.hook_token(),"header":HOOK_HEADER}),
                )
            }
            None => json_response(404, json!({"error":"no such run"})),
        },
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

async fn send_peer(body: &Value) -> Response {
    let peer = body["peer"].as_str().unwrap_or_default();
    let text = body["text"].as_str().unwrap_or_default();
    if !relay::valid_peer(peer) || text.trim().is_empty() {
        return json_response(400, json!({"error":"a peer and message are required"}));
    }
    let message = match body["from"].as_str() {
        Some("tramecli") | None => text.to_owned(),
        Some(run) if exists(run) => format!("Message from Trame run {run}:\n\n{text}"),
        Some(_) => return json_response(400, json!({"error":"unknown sending run"})),
    };
    if message.len() > relay::MAX_MESSAGE_BYTES {
        return json_response(
            400,
            json!({"error":"relay messages including their sender must fit in 16 KiB"}),
        );
    }
    let Some(relay) = relay::locate() else {
        return json_response(503, json!({"error":"no agent relay is configured"}));
    };
    match relay.send(peer, &message).await {
        Ok(id) => json_response(200, json!({"id":id})),
        Err(error) => json_response(502, json!({"error":error})),
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
    match launch_run(cwd, provider, resume, launch, history) {
        Ok(run) => json_response(201, run.summary()),
        Err(e) => json_response(
            500,
            json!({"error":format!("could not start the agent: {e}")}),
        ),
    }
}

fn launch_run(
    cwd: PathBuf,
    provider: Provider,
    resume: Option<String>,
    launch: Launch,
    history: Vec<Value>,
) -> std::io::Result<Arc<Run>> {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let run = Run::start(id.clone(), cwd, provider, resume, launch, None, history)?;
    runs().lock().unwrap().insert(id, run.clone());
    save();
    Ok(run)
}

/// Run `f` on a connection to this machine's database, off the async runtime.
async fn with_db<T: Send + 'static>(
    native: &Native,
    f: impl FnOnce(&mut Db) -> anyhow::Result<T> + Send + 'static,
) -> anyhow::Result<T> {
    let native = native.clone();
    crate::blocking::spawn(move || {
        let mut db = Db::connect(
            &native.root.join("socket"),
            &native.origin,
            Some(native.settings),
        )?;
        f(&mut db)
    })
    .await?
}

fn db_failed() -> Response {
    json_response(500, json!({"error":"the bots could not be read or saved"}))
}

/// `/api/agent/bots/...`: the app manages bots; a bot's hook, holding only that bot's secret, starts
/// its runs and nothing else.
async fn bot_route(
    native: &Native,
    method: &Method,
    rest: &[&str],
    app: bool,
    hook: Option<String>,
    body: &Value,
) -> Response {
    let no_bot = || json_response(404, json!({"error":"no such bot"}));
    let refused = |r: bots::Refused| match r {
        bots::Refused::Missing => no_bot(),
        bots::Refused::Invalid(e) => json_response(400, json!({"error":e})),
        bots::Refused::Db(e) => {
            eprintln!("bots: {e:#}");
            db_failed()
        }
    };
    if let (&Method::POST, [id, "runs"]) = (method, rest) {
        let id = (*id).to_owned();
        let Ok(found) = with_db(native, move |db| bots::get(db, &id)).await else {
            return db_failed();
        };
        let Some(bot) = found else {
            return no_bot();
        };
        let hooked = hook
            .or_else(|| body["hook"].as_str().map(str::to_owned))
            .is_some_and(|h| h == bot.hook);
        if !app && !hooked {
            return json_response(
                401,
                json!({"error":"terminal token or this bot's hook token required"}),
            );
        }
        let label = body["from"]
            .as_str()
            .filter(|f| !f.trim().is_empty() && f.len() <= 120);
        let from = match (app, label) {
            (false, Some(label)) => format!("a hook ({label})"),
            (false, None) => "a hook".to_owned(),
            (true, label) => label.unwrap_or("Trame").to_owned(),
        };
        let text = body["text"].as_str().unwrap_or_default();
        let sender = if app { "app" } else { "hook" };
        return match bots::start(&bot, &from, text, sender) {
            Ok(run) => json_response(201, run.summary()),
            Err(e @ "text required, up to 64 KiB") => json_response(400, json!({"error":e})),
            Err(e @ "this bot already has as many runs as it may") => {
                json_response(429, json!({"error":e}))
            }
            Err(e) => json_response(500, json!({"error":e})),
        };
    }
    if !app {
        return json_response(401, json!({"error":"terminal token required"}));
    }
    let body = body.clone();
    match (method, rest) {
        (&Method::GET, []) => match with_db(native, bots::list).await {
            Ok(list) => json_response(
                200,
                Value::Array(list.iter().map(|b| b.summary(bot_live(&b.id))).collect()),
            ),
            Err(_) => db_failed(),
        },
        (&Method::POST, []) => {
            match with_db(native, move |db| Ok(bots::upsert(db, None, &body))).await {
                Ok(Ok(bot)) => json_response(201, bot.summary(0)),
                Ok(Err(r)) => refused(r),
                Err(_) => db_failed(),
            }
        }
        (&Method::PATCH, [id]) => {
            let id = (*id).to_owned();
            match with_db(native, move |db| Ok(bots::upsert(db, Some(&id), &body))).await {
                Ok(Ok(bot)) => json_response(200, bot.summary(bot_live(&bot.id))),
                Ok(Err(r)) => refused(r),
                Err(_) => db_failed(),
            }
        }
        // its runs stay; they just no longer belong to a bot
        (&Method::DELETE, [id]) => {
            let owned = (*id).to_owned();
            match with_db(native, move |db| bots::remove(db, &owned)).await {
                Ok(true) => {
                    for run in runs().lock().unwrap().values() {
                        if run.bot().as_deref() == Some(*id) {
                            run.set_bot(None);
                        }
                    }
                    save();
                    json_response(200, json!({"ok":true}))
                }
                Ok(false) => no_bot(),
                Err(_) => db_failed(),
            }
        }
        // what a hook starts the bot's runs with: its URL and secret; POST makes a new secret
        (&(Method::GET | Method::POST), [id, "hook"]) => {
            let (owned, rotate) = ((*id).to_owned(), *method == Method::POST);
            let token = with_db(native, move |db| {
                if rotate {
                    bots::rotate_hook(db, &owned)
                } else {
                    Ok(bots::get(db, &owned)?.map(|b| b.hook))
                }
            })
            .await;
            match token {
                Ok(Some(token)) => {
                    let url = format!("http://127.0.0.1:{}/api/agent/bots/{id}/runs", native.port);
                    json_response(200, json!({"url":url,"token":token,"header":HOOK_HEADER}))
                }
                Ok(None) => no_bot(),
                Err(_) => db_failed(),
            }
        }
        _ => json_response(404, json!({"error":"not found"})),
    }
}

/// The runs of bot `id` still running, against its cap.
fn bot_live(id: &str) -> usize {
    runs()
        .lock()
        .unwrap()
        .values()
        .filter(|r| r.running() && r.bot().as_deref() == Some(id))
        .count()
}

pub(crate) fn exists(id: &str) -> bool {
    get(id).is_some()
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
            event = run.next_event(&mut rx) => {
                let Some(event) = event else { return };
                if let Some(writer) = event["writer"].as_u64() {
                    if writer != lease {
                        lease = 0;
                    }
                }
                if !send_json(&mut ws, &event).await {
                    return;
                }
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
