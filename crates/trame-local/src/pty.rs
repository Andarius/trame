#![allow(
    unsafe_code,
    reason = "signals a terminal's process groups through libc::kill"
)]

use crate::routes::json_response;
use axum::{
    body::Body,
    extract::{
        FromRequest,
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
    },
    http::{Method, Request},
    response::{IntoResponse, Response},
};
use bytes::Bytes;
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
use tokio::sync::{broadcast, oneshot};

/// Scrollback kept per terminal for re-attaching.
const RING: usize = 1 << 20;
const MAX_TERMS: usize = 32;
pub const TOKEN_HEADER: &str = "x-trame-term";
/// Close codes the panel acts on: re-auth, gone, superseded by another attach, too slow (reconnect).
pub const CLOSE_AUTH: u16 = 4401;
pub const CLOSE_GONE: u16 = 4404;
pub const CLOSE_SUPERSEDED: u16 = 4000;
pub const CLOSE_LAGGED: u16 = 4002;

/// The shell's exit; `code` is unknown when waiting on it failed.
#[derive(Clone, Copy)]
struct Exited {
    code: Option<u32>,
}

#[derive(Clone)]
enum Event {
    Data(u64, Bytes),
    Exit(Exited),
}

struct Buf {
    data: VecDeque<u8>,
    /// Byte offset just past the last output byte.
    end: u64,
    exit: Option<Exited>,
}

pub struct Term {
    id: String,
    title: String,
    cwd: String,
    /// The card this shell works for, so the card can list and show its terminals.
    card: Option<String>,
    /// The project a shell without a card was opened for.
    project: Option<String>,
    pid: Option<i32>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    // dropping the writer sends EOF to the shell, so it lives as long as the terminal
    writer: Mutex<Box<dyn Write + Send>>,
    buf: Mutex<Buf>,
    tx: broadcast::Sender<Event>,
    kick: Mutex<Option<oneshot::Sender<()>>>,
}

/// What a new attachment replays before streaming live output.
struct Attach {
    offset: u64,
    reset: bool,
    replay: Bytes,
    exit: Option<Exited>,
    rx: broadcast::Receiver<Event>,
}

impl Term {
    fn push(&self, chunk: &[u8]) {
        let mut buf = self.buf.lock().unwrap();
        let offset = buf.end;
        buf.data.extend(chunk);
        let over = buf.data.len().saturating_sub(RING);
        buf.data.drain(..over);
        buf.end += chunk.len() as u64;
        let _ = self
            .tx
            .send(Event::Data(offset, Bytes::copy_from_slice(chunk)));
    }

    fn finish(&self, code: Option<u32>) {
        let mut buf = self.buf.lock().unwrap();
        buf.exit = Some(Exited { code });
        let _ = self.tx.send(Event::Exit(Exited { code }));
    }

    fn exited(&self) -> bool {
        self.buf.lock().unwrap().exit.is_some()
    }

    /// The shell's current folder: it may have `cd`'d away from the one it started in.
    fn live_cwd(&self) -> Option<String> {
        self.pid.filter(|_| !self.exited()).and_then(process_cwd)
    }

    /// What runs in the foreground now (the shell itself when idle), for a Konsole-style pane title.
    fn foreground(&self) -> Option<String> {
        if self.exited() {
            return None;
        }
        let leader = self
            .master
            .lock()
            .unwrap()
            .process_group_leader()
            .or(self.pid)?;
        process_name(leader)
    }

    /// Snapshot and subscribe under one lock so no output falls between replay and live.
    fn attach(&self, from: Option<u64>) -> Attach {
        let buf = self.buf.lock().unwrap();
        let rx = self.tx.subscribe();
        let start = buf.end - buf.data.len() as u64;
        let (offset, reset) = match from {
            Some(from) if (start..=buf.end).contains(&from) => (from, false),
            _ => (start, true),
        };
        let skip = usize::try_from(offset - start).unwrap_or(usize::MAX);
        let replay = buf.data.iter().skip(skip).copied().collect::<Vec<u8>>();
        Attach {
            offset,
            reset,
            replay: replay.into(),
            exit: buf.exit,
            rx,
        }
    }

    fn resize(&self, cols: u16, rows: u16) {
        if cols == 0 || rows == 0 {
            return;
        }
        let _ = self.master.lock().unwrap().resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
    }

    fn write(&self, data: &[u8]) {
        let mut writer = self.writer.lock().unwrap();
        let _ = writer.write_all(data).and_then(|()| writer.flush());
    }

    /// Signal the shell's group and the tty's foreground group (a job may run in its own).
    fn signal(&self, sig: libc::c_int) {
        let foreground = self.master.lock().unwrap().process_group_leader();
        for group in [self.pid, foreground].into_iter().flatten() {
            if group > 1 {
                unsafe { libc::kill(-group, sig) };
            }
        }
    }

    fn summary(&self) -> Value {
        json!({"id":self.id,"title":self.title,"cwd":self.cwd,"card":self.card,"project":self.project,"exited":self.exited()})
    }
}

struct Registry {
    token: String,
    terms: Mutex<HashMap<String, Arc<Term>>>,
}

fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(|| Registry {
        token: uuid::Uuid::new_v4().simple().to_string(),
        terms: Mutex::new(HashMap::new()),
    })
}

pub fn get(id: &str) -> Option<Arc<Term>> {
    registry().terms.lock().unwrap().get(id).cloned()
}

/// Start the user's login shell in `cwd`, running `command` first and keeping the shell afterwards.
pub fn spawn(
    id: Option<String>,
    cwd: &str,
    command: Option<&str>,
    title: &str,
    card: Option<String>,
    project: Option<String>,
) -> anyhow::Result<Arc<Term>> {
    let pair = native_pty_system().openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    // $SHELL, else the password database: a Finder-launched app may not have $SHELL
    let shell = CommandBuilder::new_default_prog().get_shell();
    let mut cmd = CommandBuilder::new(&shell);
    cmd.args(["-l", "-i"]);
    if let Some(command) = command {
        cmd.arg("-c");
        cmd.arg(format!(
            "{command}; exec {} -l -i",
            crate::terminal::shq(&shell)
        ));
    }
    cmd.cwd(cwd);
    // launched from an agent session, Trame inherits its env: an agent started here would
    // ride that session's auth and settings instead of the user's own
    for (key, _) in std::env::vars_os() {
        if key.to_str().is_some_and(agent_host_var) {
            cmd.env_remove(&key);
        }
    }
    for (key, value) in crate::host_env::host_env() {
        match value {
            Some(value) => cmd.env(key, value),
            None => cmd.env_remove(key),
        }
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "trame");
    let mut child = pair.slave.spawn_command(cmd)?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;
    let (tx, _) = broadcast::channel(1024);
    let term = Arc::new(Term {
        id: id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        title: title.to_owned(),
        cwd: cwd.to_owned(),
        card,
        project,
        pid: child.process_id().and_then(|p| i32::try_from(p).ok()),
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        buf: Mutex::new(Buf {
            data: VecDeque::new(),
            end: 0,
            exit: None,
        }),
        tx,
        kick: Mutex::new(None),
    });
    let (drained_tx, drained) = mpsc::channel::<()>();
    let out = term.clone();
    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        while let Ok(n) = reader.read(&mut chunk) {
            if n == 0 {
                break;
            }
            out.push(&chunk[..n]);
        }
        let _ = drained_tx.send(());
    });
    let waiter = term.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code());
        // flush the tail; a background job holding the tty open must not keep the exit back
        let _ = drained.recv_timeout(Duration::from_millis(500));
        waiter.finish(code);
    });
    registry()
        .terms
        .lock()
        .unwrap()
        .insert(term.id.clone(), term.clone());
    Ok(term)
}

/// `/home/x/…` or `/Users/x/…` from another machine, rebased on this machine's home.
fn rehome(path: &Path, home: &Path) -> Option<PathBuf> {
    let mut parts = path.components();
    parts.next(); // the root
    let foreign = matches!(parts.next(), Some(c) if c.as_os_str() == "home" || c.as_os_str() == "Users")
        && parts.next().is_some();
    foreign.then(|| home.join(parts.as_path()))
}

/// The repo a worktree path belongs to (`…/repo/.claude/worktrees/x` → `…/repo`).
fn repo_root(asked: &str) -> &str {
    ["/.claude/worktrees/", "/.worktrees/"]
        .iter()
        .find_map(|marker| asked.find(marker).map(|i| &asked[..i]))
        .unwrap_or(asked)
}

/// A card's folder as it exists here: a folder the user mapped for it, as given, rebased on
/// this home when it came from another machine, else the git repo holding a deleted worktree.
fn resolve_cwd(asked: &str, home: &Path, folders: &[(String, String)]) -> Option<String> {
    let path = Path::new(asked);
    if !path.is_absolute() {
        return None;
    }
    if path.is_dir() {
        return Some(asked.to_owned());
    }
    let mapped = folders.iter().find_map(|(from, to)| {
        let rest = asked.strip_prefix(from.as_str())?;
        (rest.is_empty() || rest.starts_with('/')).then(|| PathBuf::from(format!("{to}{rest}")))
    });
    let candidates = mapped
        .into_iter()
        .chain(rehome(path, home))
        .chain([path.to_path_buf()]);
    for candidate in candidates {
        if candidate.is_dir() {
            return candidate.to_str().map(str::to_owned);
        }
        // nearest repo above, never the home directory or the filesystem root
        let repo = candidate
            .ancestors()
            .skip(1)
            .take_while(|a| *a != home && a.parent().is_some())
            .find(|a| a.join(".git").exists());
        if let Some(repo) = repo {
            return repo.to_str().map(str::to_owned);
        }
    }
    None
}

/// Folders the user picked for cards whose path doesn't exist here, per machine (not synced).
fn folders_file(root: &Path) -> PathBuf {
    root.join("term-folders.json")
}
fn load_folders(root: &Path) -> Vec<(String, String)> {
    let map: serde_json::Map<String, Value> = std::fs::read(folders_file(root))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    map.into_iter()
        .filter_map(|(from, to)| Some((from, to.as_str()?.to_owned())))
        .collect()
}
fn save_folder(root: &Path, from: &str, to: &str) -> std::io::Result<()> {
    let mut map: serde_json::Map<String, Value> = std::fs::read(folders_file(root))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    map.insert(from.to_owned(), json!(to));
    std::fs::write(folders_file(root), serde_json::to_vec_pretty(&map)?)
}

/// Variables an agent harness sets for its own children (Claude Code, Codex, Anthropic SDK).
fn agent_host_var(key: &str) -> bool {
    ["CLAUDE", "ANTHROPIC_", "CODEX_", "OPENAI_"]
        .iter()
        .any(|prefix| key.starts_with(prefix))
}

/// Hang up the terminal, then force it after a grace period.
pub fn kill(id: &str) -> bool {
    let Some(term) = registry().terms.lock().unwrap().remove(id) else {
        return false;
    };
    term.signal(libc::SIGHUP);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(2));
        if !term.exited() {
            term.signal(libc::SIGKILL);
        }
    });
    true
}

/// Stop every terminal before the server drains its connections, saving them first for the next launch.
pub fn shutdown() {
    STOPPED.store(true, Ordering::SeqCst);
    save_now(true);
    SAVED_FILE.lock().unwrap().take();
    let terms: Vec<_> = registry()
        .terms
        .lock()
        .unwrap()
        .drain()
        .map(|(_, t)| t)
        .collect();
    for term in &terms {
        term.signal(libc::SIGHUP);
    }
    let deadline = Instant::now() + Duration::from_secs(1);
    while Instant::now() < deadline && terms.iter().any(|t| !t.exited()) {
        std::thread::sleep(Duration::from_millis(25));
    }
    for term in terms.iter().filter(|t| !t.exited()) {
        term.signal(libc::SIGKILL);
    }
}

pub fn owns(path: &str) -> bool {
    path == "/api/term" || path.starts_with("/api/term/")
}

pub async fn serve(root: &Path, req: Request<Body>) -> Response {
    let path = req.uri().path().to_owned();
    let method = req.method().clone();
    if path == "/api/term/token" && method == Method::GET {
        // readable only same-origin (no CORS headers; proxy rejects cross-site fetches)
        let mut response = json_response(200, json!({"token":registry().token}));
        response
            .headers_mut()
            .insert("cache-control", "no-store".parse().unwrap());
        return response;
    }
    let parts: Vec<&str> = path.split('/').collect();
    if let ["", "api", "term", id, "ws"] = parts.as_slice() {
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
    if token != Some(registry().token.as_str()) {
        return json_response(401, json!({"error":"terminal token required"}));
    }
    match (method, parts.as_slice()) {
        (Method::GET, ["", "api", "term", "agents"]) => {
            let agents = crate::blocking::spawn(installed_agents)
                .await
                .unwrap_or_default();
            json_response(200, Value::Array(agents))
        }
        (Method::GET, ["", "api", "term", "running"]) => {
            let running = running_in_shells().await;
            let map = running
                .into_iter()
                .map(|r| (r.session.id, Value::String(r.term)))
                .collect();
            json_response(200, Value::Object(map))
        }
        // the agent sessions running in Trame shells, with their name and state
        (Method::GET, ["", "api", "term", "sessions"]) => {
            json_response(200, json!(running_in_shells().await))
        }
        // an image a shell printed the path of, for the hover preview
        (Method::GET, ["", "api", "term", "file"]) => {
            let path = crate::sessions::query_param(req.uri().query().unwrap_or(""), "path");
            let home = std::env::var_os("HOME").map(PathBuf::from);
            let found =
                crate::blocking::spawn(move || preview_image(path.as_deref()?, home.as_deref()))
                    .await
                    .ok()
                    .flatten();
            match found {
                Some(Ok((mime, bytes))) => (
                    axum::http::StatusCode::OK,
                    [
                        ("content-type", mime),
                        ("x-content-type-options", "nosniff"),
                        ("cache-control", "no-store"),
                    ],
                    bytes,
                )
                    .into_response(),
                Some(Err(error)) => json_response(400, json!({"error":error})),
                None => json_response(404, json!({"error":"no such image"})),
            }
        }
        (Method::GET, ["", "api", "term", "theme"]) => {
            let theme = crate::blocking::spawn(ghostty_theme).await.ok().flatten();
            json_response(200, theme.unwrap_or(Value::Null))
        }
        (Method::GET, ["", "api", "term"]) => {
            let terms = registry().terms.lock().unwrap();
            let mut list: Vec<_> = terms.values().map(|t| t.summary()).collect();
            list.sort_by(|a, b| a["title"].as_str().cmp(&b["title"].as_str()));
            json_response(200, Value::Array(list))
        }
        (Method::POST, ["", "api", "term"]) => {
            let Ok(bytes) = axum::body::to_bytes(req.into_body(), 64 * 1024).await else {
                return json_response(400, json!({"error":"body unavailable"}));
            };
            let body = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
            create(root, &body).await
        }
        // pick a local folder for a card path that doesn't exist here, and remember it
        (Method::POST, ["", "api", "term", "folders"]) => {
            let Ok(bytes) = axum::body::to_bytes(req.into_body(), 64 * 1024).await else {
                return json_response(400, json!({"error":"body unavailable"}));
            };
            let body = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
            let Some(from) = body["from"]
                .as_str()
                .filter(|f| f.starts_with('/'))
                .map(str::to_owned)
            else {
                return json_response(400, json!({"error":"from must be an absolute path"}));
            };
            let root = root.to_path_buf();
            let picked = crate::blocking::spawn(move || {
                let picked = crate::platform::pick_folder(&format!("Folder for {from}"), None);
                if let Some(to) = picked.as_str() {
                    let to = to.trim_end_matches('/');
                    save_folder(&root, &from, to)?;
                    return Ok::<_, std::io::Error>(json!({"from":from,"to":to}));
                }
                Ok(picked)
            })
            .await;
            match picked {
                Ok(Ok(value)) => json_response(200, value),
                _ => json_response(500, json!({"error":"could not save the folder"})),
            }
        }
        // choose any folder to open a shell in: the path, `{cancelled}` or `{error}`
        (Method::POST, ["", "api", "term", "pick"]) => {
            let Ok(bytes) = axum::body::to_bytes(req.into_body(), 64 * 1024).await else {
                return json_response(400, json!({"error":"body unavailable"}));
            };
            let body = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
            let start = body["start"].as_str().map(str::to_owned);
            let picked = crate::blocking::spawn(move || {
                crate::platform::pick_folder("Open a terminal in", start.as_deref())
            })
            .await
            .unwrap_or_else(|_| json!({"error":"folder dialog failed"}));
            json_response(200, picked)
        }
        (Method::GET, ["", "api", "term", id, "now"]) => {
            let term = registry().terms.lock().unwrap().get(*id).cloned();
            let Some(term) = term else {
                return json_response(404, json!({"error":"not found"}));
            };
            let now = crate::blocking::spawn(move || {
                let cwd = term.live_cwd().unwrap_or_else(|| term.cwd.clone());
                json!({"cwd":cwd,"process":term.foreground()})
            })
            .await
            .unwrap_or_else(|_| json!({"cwd":null,"process":null}));
            json_response(200, now)
        }
        (Method::DELETE, ["", "api", "term", id]) => {
            let id = (*id).to_owned();
            let found = crate::blocking::spawn(move || kill(&id))
                .await
                .unwrap_or(false);
            json_response(if found { 200 } else { 404 }, json!({"ok":found}))
        }
        _ => json_response(404, json!({"error":"not found"})),
    }
}

/// Claude Code's config dir, where `sessions/<pid>.json` names each running CLI's transcript.
fn claude_dir() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| Some(PathBuf::from(std::env::var_os("HOME")?).join(".claude")))
}

/// An agent's transcript and, for Claude, its `/rename` name and busy / waiting state.
#[derive(Debug, PartialEq, serde::Serialize)]
struct AgentSession {
    id: String,
    name: Option<String>,
    named: bool, // the name was set by the user, not derived from the folder
    busy: bool,
    waiting: Option<String>, // what it waits on you for ("input needed", a permission), when it does
    started_at: Option<u64>, // epoch ms, Claude only
}

#[derive(Debug, PartialEq, serde::Serialize)]
struct Running {
    term: String,
    #[serde(skip)]
    pid: u32,
    agent: &'static str,
    #[serde(flatten)]
    session: AgentSession,
}

fn claude_session(dir: &Path, pid: u32) -> Option<AgentSession> {
    let raw = std::fs::read(dir.join("sessions").join(format!("{pid}.json"))).ok()?;
    let file: Value = serde_json::from_slice(&raw).ok()?;
    if file["pid"].as_u64() != Some(u64::from(pid)) {
        return None;
    }
    parse_claude_session(&file)
}

fn parse_claude_session(file: &Value) -> Option<AgentSession> {
    let waiting = (file["status"] == "waiting").then(|| {
        file["waitingFor"]
            .as_str()
            .unwrap_or("input needed")
            .to_owned()
    });
    Some(AgentSession {
        id: file["sessionId"].as_str()?.to_owned(),
        name: file["name"].as_str().map(str::to_owned),
        named: file["nameSource"] == "user",
        busy: file["status"] == "busy",
        waiting,
        started_at: file["startedAt"].as_u64(),
    })
}

async fn running_in_shells() -> Vec<Running> {
    let shells: Vec<(String, u32)> = {
        let terms = registry().terms.lock().unwrap();
        terms
            .values()
            .filter(|t| !t.exited())
            .filter_map(|t| Some((t.id.clone(), u32::try_from(t.pid?).ok()?)))
            .collect()
    };
    crate::blocking::spawn(move || {
        let dir = claude_dir();
        running_agents(&crate::diagnostics::processes(), &shells, |pid| {
            claude_session(dir.as_deref()?, pid)
        })
    })
    .await
    .unwrap_or_default()
}

/// The Claude (by `session_of`) and `codex resume` runs under each shell.
fn running_agents(
    all: &[crate::diagnostics::Process],
    shells: &[(String, u32)],
    session_of: impl Fn(u32) -> Option<AgentSession>,
) -> Vec<Running> {
    let mut out = Vec::new();
    for (term, pid) in shells {
        for p in crate::diagnostics::tree(all, *pid) {
            let codex = || {
                let at = p.args.iter().position(|a| a == "resume")?;
                let exe = if at == 0 { &p.name } else { &p.args[at - 1] };
                exe.rsplit('/').next().filter(|e| *e == "codex")?;
                let id = p.args.get(at + 1)?.clone();
                Some(AgentSession {
                    id,
                    name: None,
                    named: false,
                    busy: false,
                    waiting: None,
                    started_at: None,
                })
            };
            let found = session_of(p.pid)
                .map(|s| ("claude", s))
                .or_else(|| codex().map(|s| ("codex", s)));
            if let Some((agent, session)) = found {
                out.push(Running {
                    term: term.clone(),
                    pid: p.pid,
                    agent,
                    session,
                });
            }
        }
    }
    out
}

// Saved shells: reopened at the next launch, the agent in each resumed (a kill -9 included)

const SAVE_EVERY: Duration = Duration::from_secs(10);
// set while a workspace saves its shells (never the demo's), cleared once Trame stops it
static SAVED_FILE: Mutex<Option<PathBuf>> = Mutex::new(None);
static STOPPED: AtomicBool = AtomicBool::new(false);
// the last JSON written, so an unchanged snapshot is not rewritten
static WRITTEN: Mutex<Option<String>> = Mutex::new(None);

fn saved_file(root: &Path) -> PathBuf {
    root.join("terms.json")
}

/// A shell as it is reopened: its id (the dock's saved splits use it), folder, labels and agent.
#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
struct Saved {
    id: String,
    title: String,
    /// The agent's folder when one runs (Claude finds a transcript by folder), else the shell's.
    cwd: String,
    card: Option<String>,
    project: Option<String>,
    agent: Option<SavedAgent>,
}

#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
struct SavedAgent {
    kind: String,
    session: String,
}

/// What the live shells would reopen as.
fn snapshot() -> Vec<Saved> {
    let terms: Vec<Arc<Term>> = registry()
        .terms
        .lock()
        .unwrap()
        .values()
        .filter(|t| !t.exited())
        .cloned()
        .collect();
    let shells: Vec<(String, u32)> = terms
        .iter()
        .filter_map(|t| Some((t.id.clone(), u32::try_from(t.pid?).ok()?)))
        .collect();
    let dir = claude_dir();
    let running = running_agents(&crate::diagnostics::processes(), &shells, |pid| {
        claude_session(dir.as_deref()?, pid)
    });
    terms
        .iter()
        .map(|t| {
            let agent = running.iter().find(|r| r.term == t.id);
            let cwd = agent
                .and_then(|r| process_cwd(i32::try_from(r.pid).ok()?))
                .or_else(|| t.live_cwd())
                .unwrap_or_else(|| t.cwd.clone());
            Saved {
                id: t.id.clone(),
                title: t.title.clone(),
                cwd,
                card: t.card.clone(),
                project: t.project.clone(),
                agent: agent.map(|r| SavedAgent {
                    kind: r.agent.to_owned(),
                    session: r.session.id.clone(),
                }),
            }
        })
        .collect()
}

/// Writes the snapshot; after shutdown began only its own final write (`last`) goes through.
fn save_now(last: bool) {
    let Some(path) = SAVED_FILE.lock().unwrap().clone() else {
        return;
    };
    let mut written = WRITTEN
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if STOPPED.load(Ordering::SeqCst) && !last {
        return;
    }
    let Ok(text) = serde_json::to_string(&snapshot()) else {
        return;
    };
    if written.as_deref() == Some(text.as_str()) {
        return;
    }
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, &text)
        .and_then(|()| std::fs::rename(&tmp, &path))
        .is_ok()
    {
        *written = Some(text);
    }
}

/// Keeps `terms.json` in step with the live shells, so even a killed Trame reopens them.
pub async fn keep_saved(root: PathBuf) {
    *SAVED_FILE.lock().unwrap() = Some(saved_file(&root));
    *WRITTEN
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    STOPPED.store(false, Ordering::SeqCst);
    loop {
        tokio::time::sleep(SAVE_EVERY).await;
        if STOPPED.load(Ordering::SeqCst) {
            return;
        }
        let _ = crate::blocking::spawn(|| save_now(false)).await;
    }
}

/// The command that resumes a saved agent session, for a session id that is a UUID.
fn resume_command(agent: &SavedAgent) -> Option<String> {
    let id = agent.session.as_str();
    if !crate::routes::valid_uuid(id) {
        return None;
    }
    match agent.kind.as_str() {
        "claude" => Some(format!("claude --resume {id}")),
        "codex" => Some(format!("codex resume {id}")),
        _ => None,
    }
}

/// A shell to reopen: (id, folder, command, title, card, project).
type Reopen = (
    Option<String>,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
);

/// What to reopen from the saved shells: folders resolved here, ids and agent sessions validated.
fn reopen_plan(saved: Vec<Saved>, home: &Path, folders: &[(String, String)]) -> Vec<Reopen> {
    let uuid = |v: Option<String>| v.filter(|v| crate::routes::valid_uuid(v));
    saved
        .into_iter()
        .take(MAX_TERMS)
        .filter_map(|s| {
            let cwd = resolve_cwd(&s.cwd, home, folders)?;
            let command = s.agent.as_ref().and_then(resume_command);
            Some((
                uuid(Some(s.id)),
                cwd,
                command,
                trame_core::trim(&s.title).to_owned(),
                uuid(s.card),
                uuid(s.project),
            ))
        })
        .collect()
}

/// Reopens the shells `terms.json` saved, resuming their agents; returns how many.
pub fn restore(root: &Path) -> usize {
    let Ok(raw) = std::fs::read(saved_file(root)) else {
        return 0;
    };
    let saved: Vec<Saved> = serde_json::from_slice(&raw).unwrap_or_default();
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    reopen_plan(saved, &home, &load_folders(root))
        .into_iter()
        .filter(|(id, cwd, command, title, card, project)| {
            spawn(
                id.clone(),
                cwd,
                command.as_deref(),
                title,
                card.clone(),
                project.clone(),
            )
            .is_ok()
        })
        .count()
}

const PREVIEW_MAX: u64 = 20 << 20;

/// An image file's type and bytes, for an absolute or `~/` path; never another kind of file.
fn preview_image(
    path: &str,
    home: Option<&Path>,
) -> Option<Result<(&'static str, Vec<u8>), &'static str>> {
    let path = match path.strip_prefix("~/") {
        Some(rest) => home?.join(rest),
        None => PathBuf::from(path),
    };
    if !path.is_absolute() {
        return Some(Err("absolute path required"));
    }
    // the extension of the file read, not of a symlink pointing at it
    let real = std::fs::canonicalize(&path).ok()?;
    let Some(mime) = crate::platform::image_mime(&real.to_string_lossy()) else {
        return Some(Err("not an image"));
    };
    let meta = std::fs::metadata(&real).ok()?;
    if !meta.is_file() {
        return None;
    }
    if meta.len() > PREVIEW_MAX {
        return Some(Err("image too large"));
    }
    Some(
        std::fs::read(&real)
            .map(|b| (mime, b))
            .map_err(|_| "unreadable"),
    )
}

async fn create(root: &Path, body: &Value) -> Response {
    // no cwd: the home directory
    let home = std::env::var("HOME").unwrap_or_default();
    let asked = match &body["cwd"] {
        Value::Null => home.as_str(),
        cwd => cwd.as_str().unwrap_or(""),
    };
    let Some(cwd) = resolve_cwd(asked, Path::new(&home), &load_folders(root)) else {
        // the panel offers to pick a folder, clone the repo there, or use home
        let repo = repo_root(asked);
        let suggested = rehome(Path::new(repo), Path::new(&home))
            .and_then(|p| p.to_str().map(str::to_owned))
            .unwrap_or_else(|| repo.to_owned());
        return json_response(
            400,
            json!({"error":format!("no folder for this card on this machine ({asked})"),
                   "code":"missing_cwd","asked":asked,"repo":repo,"suggested":suggested}),
        );
    };
    if registry().terms.lock().unwrap().len() >= MAX_TERMS {
        return json_response(409, json!({"error":"too many terminals"}));
    }
    let command = body["command"]
        .as_str()
        .filter(|c| !c.trim().is_empty())
        .map(str::to_owned);
    let title = body["title"]
        .as_str()
        .map(trame_core::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            Path::new(&cwd)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| cwd.clone())
        });
    let card = match &body["card"] {
        Value::Null => None,
        card => match card.as_str().filter(|c| crate::routes::valid_uuid(c)) {
            Some(card) => Some(card.to_owned()),
            None => return json_response(400, json!({"error":"card must be a card id"})),
        },
    };
    let project = match &body["project"] {
        Value::Null => None,
        project => match project.as_str().filter(|p| crate::routes::valid_uuid(p)) {
            Some(project) => Some(project.to_owned()),
            None => return json_response(400, json!({"error":"project must be a project id"})),
        },
    };
    let spawned = crate::blocking::spawn(move || {
        spawn(None, &cwd, command.as_deref(), &title, card, project).map(|t| t.summary())
    })
    .await;
    match spawned {
        Ok(Ok(summary)) => json_response(200, summary),
        Ok(Err(e)) => json_response(500, json!({"error":e.to_string()})),
        Err(_) => json_response(500, json!({"error":"spawn failed"})),
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

/// One attachment: `{type:"auth",token,from?,cols,rows}` first, then binary input and
/// `{type:"resize"}` frames in; `{type:"attach"}`, binary output and `{type:"exit"}` out.
async fn session(mut ws: WebSocket, id: String) {
    let first = tokio::time::timeout(Duration::from_secs(5), ws.recv()).await;
    let auth = match first {
        Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str::<Value>(&text).ok(),
        _ => None,
    };
    let Some(auth) = auth.filter(|a| a["type"] == "auth" && a["token"] == registry().token) else {
        return close(&mut ws, CLOSE_AUTH, "unauthorized").await;
    };
    let Some(term) = get(&id) else {
        return close(&mut ws, CLOSE_GONE, "no such terminal").await;
    };
    let dim = |key: &str| {
        auth[key]
            .as_u64()
            .and_then(|v| u16::try_from(v).ok())
            .unwrap_or(0)
    };
    term.resize(dim("cols"), dim("rows"));
    let (kick_tx, mut kicked) = oneshot::channel();
    if let Some(previous) = term.kick.lock().unwrap().replace(kick_tx) {
        let _ = previous.send(());
    }
    let Attach {
        offset,
        reset,
        replay,
        exit,
        mut rx,
    } = term.attach(auth["from"].as_u64());
    let mut pos = offset + replay.len() as u64;
    if !send_json(
        &mut ws,
        &json!({"type":"attach","offset":offset,"reset":reset}),
    )
    .await
        || ws.send(Message::Binary(replay)).await.is_err()
    {
        return;
    }
    if let Some(Exited { code }) = exit {
        send_json(&mut ws, &json!({"type":"exit","code":code})).await;
        return close(&mut ws, 1000, "exited").await;
    }
    loop {
        tokio::select! {
            _ = &mut kicked => return close(&mut ws, CLOSE_SUPERSEDED, "superseded").await,
            event = rx.recv() => match event {
                Ok(Event::Data(at, bytes)) => {
                    let end = at + bytes.len() as u64;
                    if end <= pos {
                        continue;
                    }
                    let fresh = bytes.slice(usize::try_from(pos.saturating_sub(at)).unwrap_or(0)..);
                    pos = end;
                    if ws.send(Message::Binary(fresh)).await.is_err() {
                        return;
                    }
                }
                Ok(Event::Exit(Exited { code })) => {
                    send_json(&mut ws, &json!({"type":"exit","code":code})).await;
                    return close(&mut ws, 1000, "exited").await;
                }
                // the client re-attaches from its offset and catches up from the ring
                Err(broadcast::error::RecvError::Lagged(_)) => return close(&mut ws, CLOSE_LAGGED, "lagged").await,
                Err(broadcast::error::RecvError::Closed) => return,
            },
            message = ws.recv() => match message {
                Some(Ok(Message::Binary(data))) => {
                    let term = term.clone();
                    let _ = tokio::task::spawn_blocking(move || term.write(&data)).await;
                }
                Some(Ok(Message::Text(text))) => {
                    let msg = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
                    if msg["type"] == "resize" {
                        let dim = |key: &str| msg[key].as_u64().and_then(|v| u16::try_from(v).ok()).unwrap_or(0);
                        term.resize(dim("cols"), dim("rows"));
                    }
                }
                Some(Ok(Message::Close(_)) | Err(_)) | None => return,
                Some(Ok(_)) => {}
            },
        }
    }
}

#[cfg(target_os = "linux")]
fn process_cwd(pid: i32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()?
        .into_os_string()
        .into_string()
        .ok()
}

#[cfg(target_os = "linux")]
fn process_name(pid: i32) -> Option<String> {
    let comm = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
    Some(comm.trim().to_owned()).filter(|c| !c.is_empty())
}

#[cfg(not(target_os = "linux"))]
fn process_name(pid: i32) -> Option<String> {
    let out = std::process::Command::new("/bin/ps")
        .args(["-o", "comm=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    let comm = String::from_utf8(out.stdout).ok()?;
    let name = comm.trim().rsplit('/').next()?.trim_start_matches('-');
    Some(name.to_owned()).filter(|n| !n.is_empty())
}

#[cfg(not(target_os = "linux"))]
fn process_cwd(pid: i32) -> Option<String> {
    let out = std::process::Command::new("/usr/sbin/lsof")
        .args(["-a", "-d", "cwd", "-Fn", "-p", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    String::from_utf8(out.stdout)
        .ok()?
        .lines()
        .find_map(|l| l.strip_prefix('n'))
        .map(str::to_owned)
}

/// Agent CLIs the launcher offers, as (command, label).
const AGENTS: [(&str, &str); 5] = [
    ("claude", "Claude Code"),
    ("codex", "Codex"),
    ("gemini", "Gemini"),
    ("agy", "Antigravity"),
    ("vibe", "Mistral Vibe"),
];

/// The agents on the user's login-shell PATH (a GUI app's own PATH misses ~/.local/bin, nvm, …).
fn installed_agents() -> Vec<Value> {
    let shell = CommandBuilder::new_default_prog().get_shell();
    let names = AGENTS.map(|(c, _)| c).join(" ");
    let script =
        format!("for c in {names}; do command -v \"$c\" >/dev/null 2>&1 && echo \"@@$c\"; done");
    let mut probe = std::process::Command::new(&shell);
    for (key, value) in crate::host_env::host_env() {
        match value {
            Some(value) => probe.env(key, value),
            None => probe.env_remove(key),
        };
    }
    let Ok(mut child) = probe
        .args(["-l", "-i", "-c", &script])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return Vec::new();
    };
    // a slow or stuck shell profile must not hang the menu
    let deadline = Instant::now() + Duration::from_secs(8);
    while matches!(child.try_wait(), Ok(None)) {
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Vec::new();
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut out = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut out);
    }
    let found: Vec<&str> = out
        .lines()
        .filter_map(|l| l.trim().strip_prefix("@@"))
        .collect();
    AGENTS
        .iter()
        .filter(|(c, _)| found.contains(c))
        .map(|(c, label)| json!({"command":c,"label":label}))
        .collect()
}

const ANSI: [&str; 16] = [
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "brightBlack",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
    "brightWhite",
];

/// Ghostty's effective font and colors, so the panel looks like the user's terminal.
fn ghostty_theme() -> Option<Value> {
    let app = "/Applications/Ghostty.app/Contents/MacOS/ghostty";
    let bin = if Path::new(app).exists() {
        app
    } else {
        "ghostty"
    };
    let out = std::process::Command::new(bin)
        .args(["+show-config", "--changes-only=false"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    parse_ghostty(&String::from_utf8_lossy(&out.stdout))
}

/// `#rrggbb` from Ghostty's `#rrggbb` or bare `rrggbb`; named colors are skipped.
fn hex(value: &str) -> Option<String> {
    let v = value.trim().trim_start_matches('#');
    (v.len() == 6 && v.bytes().all(|b| b.is_ascii_hexdigit())).then(|| format!("#{v}"))
}

/// Map `ghostty +show-config` output to an xterm.js theme plus font.
fn parse_ghostty(config: &str) -> Option<Value> {
    let mut theme = serde_json::Map::new();
    let mut font_family = None;
    let mut font_size = None;
    for line in config.lines() {
        let Some((key, value)) = line.split_once(" = ") else {
            continue;
        };
        let value = value.trim();
        let mut color = |name: &str| {
            if let Some(c) = hex(value) {
                theme.insert(name.to_owned(), json!(c));
            }
        };
        match key.trim() {
            // the first family is the primary font; later ones are fallbacks
            "font-family" if font_family.is_none() && !value.is_empty() => {
                font_family = Some(value.trim_matches('"').to_owned());
            }
            "font-size" => font_size = value.parse::<f64>().ok(),
            "background" => color("background"),
            "foreground" => color("foreground"),
            "cursor-color" => color("cursor"),
            "cursor-text" => color("cursorAccent"),
            "selection-background" => color("selectionBackground"),
            "selection-foreground" => color("selectionForeground"),
            "palette" => {
                if let Some((index, c)) = value.split_once('=') {
                    let name = index.trim().parse::<usize>().ok().and_then(|i| ANSI.get(i));
                    if let (Some(name), Some(c)) = (name, hex(c)) {
                        theme.insert((*name).to_owned(), json!(c));
                    }
                }
            }
            _ => {}
        }
    }
    let (Some(bg), Some(fg)) = (
        theme.get("background").cloned(),
        theme.get("foreground").cloned(),
    ) else {
        return None;
    };
    // Ghostty's default selection swaps foreground and background
    theme.entry("selectionBackground").or_insert(fg);
    theme.entry("selectionForeground").or_insert(bg);
    Some(json!({"source":"ghostty","fontFamily":font_family,"fontSize":font_size,"theme":theme}))
}

#[cfg(test)]
mod tests {
    use super::{
        AgentSession, Saved, SavedAgent, parse_claude_session, parse_ghostty, preview_image,
        process_cwd, process_name, reopen_plan, repo_root, resolve_cwd, running_agents,
    };
    use crate::diagnostics::Process;
    use serde_json::{Value, json};
    use std::{fs, path::Path};

    fn proc(pid: u32, ppid: u32, name: &str, args: &[&str]) -> Process {
        Process {
            pid,
            ppid,
            name: name.to_owned(),
            args: args.iter().map(|a| (*a).to_owned()).collect(),
            cpu_seconds: 0.0,
            rss: 0,
            swap: None,
            threads: None,
            fds: None,
            sockets: None,
        }
    }

    #[test]
    fn agents_running_in_shells_map_to_their_terminal() {
        let all = [
            proc(10, 1, "zsh", &[]),
            proc(11, 10, "claude", &["--resume", "c-1"]),
            proc(20, 1, "zsh", &[]),
            proc(
                21,
                20,
                "node",
                &["/usr/lib/node_modules/codex", "resume", "x-2"],
            ),
            proc(30, 1, "zsh", &[]),
            proc(31, 30, "git", &["resume", "nope"]),
            proc(40, 1, "claude", &[]), // outside any Trame shell
        ];
        let shells = [("t1".into(), 10), ("t2".into(), 20), ("t3".into(), 30)];
        let claude = |id: &str| AgentSession {
            id: id.into(),
            name: Some("test".into()),
            named: true,
            busy: true,
            waiting: None,
            started_at: Some(1),
        };
        let session = |pid| match pid {
            11 => Some(claude("c-1")),
            40 => Some(claude("c-out")),
            _ => None,
        };
        assert_eq!(
            json!(running_agents(&all, &shells, session)),
            json!([
                {"term":"t1","agent":"claude","id":"c-1","name":"test","named":true,"busy":true,"waiting":null,"started_at":1},
                {"term":"t2","agent":"codex","id":"x-2","name":null,"named":false,"busy":false,"waiting":null,"started_at":null},
            ])
        );
    }

    #[test]
    fn claude_session_states() {
        // Claude's own ~/.claude/sessions/<pid>.json shape
        for (file, busy, waiting) in [
            (json!({"sessionId":"s","status":"busy"}), true, None),
            (json!({"sessionId":"s","status":"idle"}), false, None),
            (
                json!({"sessionId":"s","status":"waiting","waitingFor":"permission"}),
                false,
                Some("permission"),
            ),
            (
                json!({"sessionId":"s","status":"waiting"}),
                false,
                Some("input needed"),
            ),
        ] {
            let s = parse_claude_session(&file).unwrap();
            assert_eq!((s.busy, s.waiting.as_deref()), (busy, waiting), "{file}");
        }
    }

    #[test]
    fn saved_shells_reopen_with_their_agent_resumed() {
        let dir =
            std::env::temp_dir().join(format!("trame-reopen-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_string_lossy().into_owned();
        let (t1, s1, card) = (
            "6f0a2c1e-0000-4000-8000-000000000001",
            "6f0a2c1e-0000-4000-8000-0000000000aa",
            "6f0a2c1e-0000-4000-8000-0000000000cc",
        );
        let saved = |id: &str, cwd: &str, agent: Option<(&str, &str)>, card: Option<&str>| Saved {
            id: id.into(),
            title: " api ".into(),
            cwd: cwd.into(),
            card: card.map(Into::into),
            project: None,
            agent: agent.map(|(kind, session)| SavedAgent {
                kind: kind.into(),
                session: session.into(),
            }),
        };
        let plan = reopen_plan(
            vec![
                saved(t1, &cwd, Some(("claude", s1)), Some(card)),
                saved("not-a-uuid", &cwd, Some(("codex", s1)), Some("bad")),
                saved(t1, &cwd, Some(("claude", "x; rm -rf ~")), None),
                saved(t1, &cwd, Some(("gemini", s1)), None),
                saved(t1, "/no/such/folder/anywhere", None, None),
            ],
            Path::new("/nonexistent-home"),
            &[],
        );
        let shell = |id: Option<&str>, command: Option<String>, card: Option<&str>| {
            (
                id.map(Into::into),
                cwd.clone(),
                command,
                "api".to_owned(),
                card.map(Into::into),
                None,
            )
        };
        assert_eq!(
            plan,
            vec![
                shell(Some(t1), Some(format!("claude --resume {s1}")), Some(card)),
                shell(None, Some(format!("codex resume {s1}")), None),
                shell(Some(t1), None, None),
                shell(Some(t1), None, None),
            ]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn preview_serves_only_image_files() {
        let root =
            std::env::temp_dir().join(format!("trame-preview-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(root.join("shot.png")).unwrap();
        fs::write(root.join("a.png"), b"png").unwrap();
        fs::write(root.join("secret.txt"), b"key").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("secret.txt"), root.join("disguised.png")).unwrap();
        let at = |p: &str| root.join(p).to_string_lossy().into_owned();
        for (path, expected) in [
            (at("a.png"), Some(Ok(("image/png", b"png".to_vec())))),
            (
                "~/a.png".to_owned(),
                Some(Ok(("image/png", b"png".to_vec()))),
            ),
            (at("secret.txt"), Some(Err("not an image"))),
            (at("disguised.png"), Some(Err("not an image"))),
            (at("shot.png"), None), // a directory named like an image
            (at("missing.png"), None),
            ("a.png".to_owned(), Some(Err("absolute path required"))),
        ] {
            assert_eq!(preview_image(&path, Some(&root)), expected, "{path}");
        }
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn ghostty_config_maps_to_xterm_theme() {
        for (config, expected) in [
            (
                "font-family = \nfont-size = 13\nbackground = #282c34\nforeground = #ffffff\n\
                 cursor-color = \npalette = 0=#1d1f21\npalette = 9=#d54e53\npalette = 16=#000000\n",
                json!({"source":"ghostty","fontFamily":null,"fontSize":13.0,"theme":{
                    "background":"#282c34","foreground":"#ffffff","black":"#1d1f21","brightRed":"#d54e53",
                    "selectionBackground":"#ffffff","selectionForeground":"#282c34"}}),
            ),
            (
                "font-family = \"Iosevka Term\"\nfont-family = Symbols Nerd Font\nfont-size = 14.5\n\
                 background = 1e1e2e\nforeground = #CDD6F4\ncursor-color = #f5e0dc\n\
                 selection-background = #585b70\nselection-foreground = cdd6f4\npalette = 2=green\n",
                json!({"source":"ghostty","fontFamily":"Iosevka Term","fontSize":14.5,"theme":{
                    "background":"#1e1e2e","foreground":"#CDD6F4","cursor":"#f5e0dc",
                    "selectionBackground":"#585b70","selectionForeground":"#cdd6f4"}}),
            ),
            ("font-size = 13\nforeground = #ffffff\n", Value::Null),
        ] {
            assert_eq!(
                parse_ghostty(config).unwrap_or(Value::Null),
                expected,
                "{config}"
            );
        }
    }

    #[test]
    fn card_folders_resolve_across_machines_and_deleted_worktrees() {
        let root =
            std::env::temp_dir().join(format!("trame-cwd-{}", uuid::Uuid::new_v4().simple()));
        let home = root.join("Users/me");
        let repo = home.join("Projects/app");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(home.join("Projects/notes")).unwrap();
        let elsewhere = root.join("Volumes/work/sre");
        fs::create_dir_all(elsewhere.join(".git")).unwrap();
        let elsewhere_s = elsewhere.to_str().unwrap().to_owned();
        let folders = [(
            "/home/julien/Work/sre-config".to_owned(),
            elsewhere_s.clone(),
        )];
        let at = |p: &str| root.join(p).to_str().unwrap().to_owned();
        let repo_s = repo.to_str().unwrap().to_owned();
        for (asked, expected) in [
            (repo_s.clone(), Some(repo_s.clone())),
            ("/home/julien/Projects/app".to_owned(), Some(repo_s.clone())),
            (
                at("Users/me/Projects/app/.claude/worktrees/gone"),
                Some(repo_s.clone()),
            ),
            (
                "/home/julien/Projects/app/.claude/worktrees/gone".to_owned(),
                Some(repo_s.clone()),
            ),
            // a missing folder that sits in no repo never falls back to home or root
            (at("Users/me/Projects/notes/gone"), None),
            ("/home/julien/Projects/missing".to_owned(), None),
            ("relative/dir".to_owned(), None),
            // a folder the user picked wins, worktrees under it fall back to it
            (
                "/home/julien/Work/sre-config".to_owned(),
                Some(elsewhere_s.clone()),
            ),
            (
                "/home/julien/Work/sre-config/.claude/worktrees/sm-cleanup".to_owned(),
                Some(elsewhere_s.clone()),
            ),
            ("/home/julien/Work/sre-config-other".to_owned(), None),
        ] {
            assert_eq!(resolve_cwd(&asked, &home, &folders), expected, "{asked}");
        }
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn worktree_paths_name_their_repo() {
        for (asked, repo) in [
            (
                "/home/j/Work/sre-config/.claude/worktrees/sm-cleanup",
                "/home/j/Work/sre-config",
            ),
            ("/Users/j/app/.worktrees/x/y", "/Users/j/app"),
            ("/Users/j/app", "/Users/j/app"),
        ] {
            assert_eq!(repo_root(asked), repo, "{asked}");
        }
    }

    #[test]
    fn a_process_reports_its_live_folder_and_name() {
        let pid = i32::try_from(std::process::id()).unwrap();
        let here = std::env::current_dir().unwrap();
        assert_eq!(process_cwd(pid).map(std::path::PathBuf::from), Some(here));
        let exe = std::env::current_exe().unwrap();
        let name = process_name(pid).unwrap();
        // Linux truncates comm to 15 bytes
        assert!(
            exe.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with(&name),
            "{name}"
        );
    }
}
