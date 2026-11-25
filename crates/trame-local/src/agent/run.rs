use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{broadcast, mpsc},
};

use super::claude::{self, Frame, Launch};
use super::codex::{self, Msg};
use crate::imports::history::claude_items;

/// Events kept for a reconnecting client; an older cursor gets a snapshot instead.
const RING: usize = 512;
/// Completed items kept in the snapshot; older ones stay in the provider's transcript.
const ITEMS: usize = 2000;
/// A longer stdout line is dropped and reported, not buffered.
const MAX_LINE: usize = 16 << 20;
const STDERR_LINES: usize = 40;
const SEEN_COMMANDS: usize = 256;
const STDIN_QUEUE: usize = 64;
/// Messages a run holds for its next idle moment; more are refused.
const INBOX: usize = 20;
/// Permission modes a client may switch to; bypassing every check is left to the terminal.
const MODES: &[&str] = &["auto", "manual", "default", "acceptEdits", "plan"];

/// The agent CLI a run drives, each with its own protocol on stdio.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provider {
    /// `claude -p` speaking stream-json, with control requests for decisions
    Claude,
    /// `codex app-server` speaking JSON-RPC
    Codex,
}

impl Provider {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    /// The installed CLI, or a stand-in for tests.
    fn bin(self) -> String {
        let (var, default) = match self {
            Self::Claude => ("TRAME_CLAUDE_BIN", "claude"),
            Self::Codex => ("TRAME_CODEX_BIN", "codex"),
        };
        std::env::var(var).unwrap_or_else(|_| default.into())
    }

    /// The shell command that resumes `session` in a terminal.
    pub fn resume_command(self, session: &str) -> String {
        match self {
            Self::Claude => format!("claude --resume {session}"),
            Self::Codex => format!("codex resume {session}"),
        }
    }
}

/// What one of our JSON-RPC requests to Codex was for.
enum Rpc {
    Initialize,
    Thread,
    Models,
    Turn,
    Other,
}

/// One live agent run: its child, its reduced state and the clients following it.
pub struct Run {
    pub id: String,
    pub cwd: PathBuf,
    pub provider: Provider,
    inner: Mutex<Inner>,
    tx: broadcast::Sender<Value>,
}

struct Inner {
    epoch: String,
    seq: u64,
    ring: VecDeque<Value>,
    state: State,
    seen: VecDeque<String>,
    seen_set: HashSet<String>,
    /// the attachment allowed to send commands; a newer writer takes it over
    writer: u64,
    next_lease: u64,
    stdin: Option<mpsc::Sender<String>>,
    child_pid: Option<i32>,
    requests: u64,
    stopping: bool,
    /// requests the CLI is blocked on, by request ID: what was asked, to build the answer
    pending: HashMap<String, Value>,
    /// our own control requests still waiting for the CLI's answer: the mode asked for
    modes: HashMap<String, String>,
    /// our `set_model` requests still waiting for the CLI's answer
    model_reqs: HashSet<String>,
    /// messages from outside waiting for an idle moment, and the secret hooks post them with
    inbox: VecDeque<(String, String)>,
    hook: String,
    /// Codex: our JSON-RPC requests in flight, the turn running and file changes by item
    rpc: HashMap<u64, Rpc>,
    rpc_next: u64,
    codex_turn: Option<String>,
    /// whether this incarnation resumes its thread rather than starting one
    codex_resume: bool,
    patches: HashMap<String, String>,
}

#[derive(Default)]
struct State {
    status: &'static str,
    provider: &'static str,
    cwd: String,
    session: String,
    model: Option<String>,
    mode: Option<String>,
    effort: Option<String>,
    /// what the provider offers: `{value, label, description, efforts}`
    models: Vec<Value>,
    queued: u64,
    turn: u64,
    items: VecDeque<Value>,
    dropped: u64,
    partial: String,
    error: Option<String>,
    stderr: VecDeque<String>,
    interactions: Vec<Value>,
}

impl State {
    fn to_json(&self) -> Value {
        json!({
            "status": self.status,
            "provider": self.provider,
            // what this provider's view can offer: Codex has no permission modes to switch, and
            // Claude only takes a new effort at launch, so changing it restarts an idle run
            "capabilities": {"modes": self.provider == "claude", "effortRestarts": self.provider == "claude"},
            "cwd": self.cwd,
            "sessionId": self.session,
            "model": self.model,
            "mode": self.mode,
            "effort": self.effort,
            "models": self.models,
            "queued": self.queued,
            "turn": self.turn,
            "items": self.items,
            "droppedItems": self.dropped,
            "partial": self.partial,
            "error": self.error,
            "interactions": self.interactions,
        })
    }
}

/// What a client gets on attach: either the missed events or a snapshot, then live updates.
pub struct Attached {
    pub lease: u64,
    pub first: Vec<Value>,
    pub rx: broadcast::Receiver<Value>,
}

/// A command's outcome, sent back as `{type:"reply"}`.
pub type Reply = Result<(), &'static str>;

impl Run {
    /// Start a run in `cwd`: a fresh conversation, or `resume` an existing one by its provider ID,
    /// showing `history` (its transcript's latest items) above what this run adds.
    pub fn start(
        id: String,
        cwd: PathBuf,
        provider: Provider,
        resume: Option<String>,
        launch: Launch,
        hook: Option<String>,
        history: Vec<Value>,
    ) -> std::io::Result<Arc<Self>> {
        let resumed = resume.is_some();
        let run = Self::new(id, cwd, provider, resume, launch, hook, history);
        run.spawn(resumed)?;
        Ok(run)
    }

    /// A run with no child yet: restored after a restart, it waits for the user to resume it.
    pub fn new(
        id: String,
        cwd: PathBuf,
        provider: Provider,
        resume: Option<String>,
        launch: Launch,
        hook: Option<String>,
        history: Vec<Value>,
    ) -> Arc<Self> {
        let (tx, _) = broadcast::channel(1024);
        let shown = cwd.display().to_string();
        let session = resume.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let mut items: VecDeque<Value> = history.into();
        let dropped = items.len().saturating_sub(ITEMS);
        items.drain(..dropped);
        Arc::new(Self {
            id,
            cwd,
            provider,
            tx,
            inner: Mutex::new(Inner {
                epoch: String::new(),
                seq: 0,
                ring: VecDeque::new(),
                state: State {
                    status: "stopped",
                    provider: provider.name(),
                    cwd: shown,
                    session,
                    mode: launch.mode,
                    model: launch.model,
                    effort: launch.effort,
                    items,
                    ..State::default()
                },
                seen: VecDeque::new(),
                seen_set: HashSet::new(),
                writer: 0,
                next_lease: 1,
                stdin: None,
                child_pid: None,
                requests: 0,
                stopping: false,
                pending: HashMap::new(),
                modes: HashMap::new(),
                model_reqs: HashSet::new(),
                inbox: VecDeque::new(),
                hook: hook.unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string()),
                rpc: HashMap::new(),
                rpc_next: 0,
                codex_turn: None,
                codex_resume: false,
                patches: HashMap::new(),
            }),
        })
    }

    /// Restart a stopped or failed run, resuming its conversation under a new epoch.
    pub fn restart(self: &Arc<Self>) -> Result<(), &'static str> {
        if self.inner.lock().unwrap().stdin.is_some() {
            return Err("still running");
        }
        self.spawn(true).map_err(|_| "spawn failed")
    }

    fn spawn(self: &Arc<Self>, resume: bool) -> std::io::Result<()> {
        let (session, launch) = {
            let inner = self.inner.lock().unwrap();
            let st = &inner.state;
            let launch = Launch {
                mode: st.mode.clone(),
                model: st.model.clone(),
                effort: st.effort.clone(),
            };
            (st.session.clone(), launch)
        };
        let mut cmd = Command::new(self.provider.bin());
        match self.provider {
            Provider::Claude => cmd.args(claude::args(
                resume.then_some(session.as_str()),
                &session,
                &launch,
            )),
            Provider::Codex => cmd.arg("app-server"),
        };
        cmd.current_dir(&self.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .process_group(0);
        for (key, _) in std::env::vars_os() {
            if key.to_str().is_some_and(crate::pty::agent_host_var) {
                cmd.env_remove(&key);
            }
        }
        for (key, value) in crate::host_env::host_env() {
            match value {
                Some(value) => cmd.env(key, value),
                None => cmd.env_remove(key),
            };
        }
        // lets the agent name itself when it messages another run (`tramecli agent send`)
        cmd.env("TRAME_AGENT_RUN", &self.id);
        let mut child = cmd.spawn()?;
        let (stdin_tx, stdin_rx) = mpsc::channel(STDIN_QUEUE);
        {
            let mut inner = self.inner.lock().unwrap();
            // a new incarnation: old cursors and commands cannot apply to it
            inner.epoch = uuid::Uuid::new_v4().simple().to_string();
            inner.seq = 0;
            inner.ring.clear();
            inner.stdin = Some(stdin_tx.clone());
            inner.child_pid = child.id().and_then(|p| i32::try_from(p).ok());
            inner.stopping = false;
            inner.state.status = "starting";
            inner.state.error = None;
            inner.state.partial.clear();
            inner.state.stderr.clear();
            inner.rpc.clear();
            inner.codex_turn = None;
            // a fresh Codex thread gets its id from Codex; resuming one keeps it
            inner.codex_resume = resume;
            let snapshot = snapshot(&inner);
            let _ = self.tx.send(snapshot);
        }
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let init = match self.provider {
            Provider::Claude => {
                let init = self.next_request();
                let _ = stdin_tx.try_send(claude::initialize(&init).to_string());
                init
            }
            Provider::Codex => {
                let id = self.rpc(Rpc::Initialize);
                let _ = stdin_tx
                    .try_send(codex::request(id, "initialize", &codex::initialize()).to_string());
                String::new()
            }
        };
        tokio::spawn(write_stdin(stdin, stdin_rx));
        let errors = tokio::spawn(read_stderr(self.clone(), stderr));
        tokio::spawn(self.clone().supervise(child, stdout, errors, init));
        Ok(())
    }

    fn next_request(&self) -> String {
        let mut inner = self.inner.lock().unwrap();
        inner.requests += 1;
        format!("trame-{}", inner.requests)
    }

    /// A fresh JSON-RPC id for a Codex request, remembering what it is for.
    fn rpc(&self, purpose: Rpc) -> u64 {
        let mut inner = self.inner.lock().unwrap();
        inner.rpc_next += 1;
        let id = inner.rpc_next;
        inner.rpc.insert(id, purpose);
        id
    }

    fn send(&self, line: &Value) -> bool {
        let stdin = self.inner.lock().unwrap().stdin.clone();
        stdin.is_some_and(|s| s.try_send(line.to_string()).is_ok())
    }

    /// Apply an event to the state and hand it to every client, in one step under the lock.
    fn publish(&self, kind: &str, payload: Value) {
        let mut inner = self.inner.lock().unwrap();
        apply(&mut inner.state, kind, &payload);
        inner.seq += 1;
        let mut event = json!({
            "type": "event", "v": 1, "runId": self.id, "epoch": inner.epoch, "seq": inner.seq,
            "turn": inner.state.turn, "kind": kind,
        });
        event["payload"] = payload;
        inner.ring.push_back(event.clone());
        if inner.ring.len() > RING {
            inner.ring.pop_front();
        }
        let _ = self.tx.send(event);
        let idle =
            kind == "turn.finished" || (kind == "run.state" && inner.state.status == "ready");
        drop(inner);
        if idle {
            self.pump();
        }
    }

    /// Start a turn with `text`; `from` names who sent it when it came through the inbox.
    fn send_prompt(&self, text: &str, from: Option<&str>) -> Reply {
        // the agent sees who wrote: a hook, another run, a relayed agent
        let said = match from {
            Some(from) => format!("Message from {from}:\n\n{text}"),
            None => text.to_owned(),
        };
        let line = match self.provider {
            Provider::Claude => claude::user_message(&said),
            Provider::Codex => {
                // a model or effort picked since the last turn applies from this one
                let (model, effort) = {
                    let st = &self.inner.lock().unwrap().state;
                    (st.model.clone(), st.effort.clone())
                };
                let params = json!({
                    "threadId":self.session(),"input":codex::user_input(&said),"model":model,"effort":effort,
                });
                codex::request(self.rpc(Rpc::Turn), "turn/start", &params)
            }
        };
        if !self.send(&line) {
            return Err("input queue full");
        }
        self.publish("turn.started", json!({}));
        self.publish(
            "item.completed",
            json!({"kind":"user","text":text,"truncated":false,"ts":now(),"from":from}),
        );
        Ok(())
    }

    /// Queue a message from outside (a hook, another run, the relay) for this run's next idle moment.
    pub fn deliver(&self, from: &str, text: &str) -> Result<usize, &'static str> {
        let queued = {
            let mut inner = self.inner.lock().unwrap();
            if inner.inbox.len() >= INBOX {
                return Err("inbox full");
            }
            inner.inbox.push_back((from.to_owned(), text.to_owned()));
            inner.inbox.len()
        };
        self.publish("inbox.queued", json!({"from":from,"text":text}));
        self.pump();
        Ok(queued)
    }

    /// Start the next queued message when the run is idle: never mid-turn, never over a pending decision.
    fn pump(&self) {
        let next = {
            let mut inner = self.inner.lock().unwrap();
            let idle =
                inner.state.status == "ready" && inner.stdin.is_some() && inner.pending.is_empty();
            if idle { inner.inbox.pop_front() } else { None }
        };
        if let Some((from, text)) = next {
            self.publish("inbox.delivered", json!({"from":from}));
            if self.send_prompt(&text, Some(&from)).is_err() {
                self.inner.lock().unwrap().inbox.push_front((from, text));
            }
        }
    }

    /// The secret a hook presents to post into this run's inbox.
    pub fn hook_token(&self) -> String {
        self.inner.lock().unwrap().hook.clone()
    }

    fn status(&self, status: &'static str) {
        self.publish("run.state", json!({"status": status}));
    }

    /// Register a client: events after `after` in `epoch` when the ring still has them, else a snapshot.
    pub fn attach(&self, epoch: Option<&str>, after: Option<u64>, writer: bool) -> Attached {
        let mut inner = self.inner.lock().unwrap();
        let rx = self.tx.subscribe();
        let lease = if writer {
            let lease = inner.next_lease;
            inner.next_lease += 1;
            inner.writer = lease;
            let _ = self.tx.send(json!({"type":"lease","writer":lease}));
            lease
        } else {
            0
        };
        let oldest = inner
            .ring
            .front()
            .map_or(inner.seq + 1, |e| e["seq"].as_u64().unwrap_or(0));
        let first = match (epoch, after) {
            (Some(e), Some(after))
                if e == inner.epoch && after + 1 >= oldest && after <= inner.seq =>
            {
                inner
                    .ring
                    .iter()
                    .filter(|e| e["seq"].as_u64().is_some_and(|s| s > after))
                    .cloned()
                    .collect()
            }
            _ => vec![snapshot(&inner)],
        };
        Attached { lease, first, rx }
    }

    /// The state now, for a client that fell behind the live stream.
    pub fn snapshot(&self) -> Value {
        snapshot(&self.inner.lock().unwrap())
    }

    /// Check and run one client command; `lease` is the sender's writer lease.
    pub fn command(self: &Arc<Self>, lease: u64, cmd: &Value) -> Reply {
        let id = cmd["commandId"]
            .as_str()
            .ok_or("commandId required")?
            .to_owned();
        let text;
        {
            let mut inner = self.inner.lock().unwrap();
            if lease == 0 || lease != inner.writer {
                return Err("not the writer");
            }
            if cmd["epoch"].as_str() != Some(inner.epoch.as_str()) {
                return Err("stale epoch");
            }
            // accept a command once; a retry after a lost ACK must not run it twice
            if !inner.seen_set.insert(id.clone()) {
                return Err("duplicate command");
            }
            inner.seen.push_back(id);
            if inner.seen.len() > SEEN_COMMANDS {
                let old = inner.seen.pop_front().unwrap();
                inner.seen_set.remove(&old);
            }
            if inner.stdin.is_none() {
                return Err("not running");
            }
            match (cmd["kind"].as_str(), inner.state.status) {
                (Some("prompt"), "ready") => {}
                (Some("prompt"), _) => return Err("busy"),
                (Some("interrupt"), "busy") => {}
                (Some("interrupt"), _) => return Err("nothing to interrupt"),
                (Some("stop" | "answer"), _) => {}
                (Some("setMode" | "setModel"), "ready" | "busy") => {}
                (Some("setMode" | "setModel"), _) => return Err("not ready"),
                (Some("setEffort"), "ready") => {}
                (Some("setEffort"), _) => return Err("finish the turn first"),
                _ => return Err("unknown command"),
            }
            text = cmd["payload"]["text"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
        }
        match cmd["kind"].as_str() {
            Some("prompt") => {
                if text.trim().is_empty() {
                    return Err("empty prompt");
                }
                self.send_prompt(&text, None)?;
            }
            Some("interrupt") => {
                let line = match self.provider {
                    Provider::Claude => claude::interrupt(&self.next_request()),
                    Provider::Codex => {
                        let turn = self.inner.lock().unwrap().codex_turn.clone();
                        let turn = turn.ok_or("the turn hasn't started yet")?;
                        let params = json!({"threadId":self.session(),"turnId":turn});
                        codex::request(self.rpc(Rpc::Other), "turn/interrupt", &params)
                    }
                };
                if !self.send(&line) {
                    return Err("input queue full");
                }
                self.status("interrupting");
            }
            Some("answer") => return self.answer(&cmd["payload"]),
            Some("setMode") => {
                let mode = cmd["payload"]["mode"].as_str().unwrap_or_default();
                if self.provider == Provider::Codex {
                    return Err("Codex has no permission modes to switch");
                }
                if !MODES.contains(&mode) {
                    return Err("unknown mode");
                }
                let id = self.next_request();
                self.inner
                    .lock()
                    .unwrap()
                    .modes
                    .insert(id.clone(), mode.to_owned());
                if !self.send(&claude::set_mode(&id, mode)) {
                    return Err("input queue full");
                }
            }
            Some("setModel") => {
                let model = cmd["payload"]["model"].as_str().unwrap_or_default();
                if !valid_choice(model) {
                    return Err("unknown model");
                }
                match self.provider {
                    Provider::Claude => {
                        let id = self.next_request();
                        self.inner.lock().unwrap().model_reqs.insert(id.clone());
                        if !self.send(&claude::set_model(&id, model)) {
                            return Err("input queue full");
                        }
                    }
                    Provider::Codex => self.publish("run.info", json!({"model":model})),
                }
            }
            Some("setEffort") => {
                let effort = cmd["payload"]["effort"].as_str().unwrap_or_default();
                if !valid_choice(effort) {
                    return Err("unknown effort");
                }
                self.publish("run.info", json!({"effort":effort}));
                // Claude takes effort only at launch: resume the same conversation with it
                if self.provider == Provider::Claude {
                    let run = self.clone();
                    tokio::spawn(async move {
                        if run.stop_and_wait(Duration::from_secs(6)).await {
                            let _ = run.spawn(true);
                        }
                    });
                }
            }
            _ => self.stop(),
        }
        Ok(())
    }

    /// Answer a request the CLI is blocked on, once; a withdrawn or answered request is refused.
    fn answer(&self, p: &Value) -> Reply {
        let id = p["requestId"].as_str().ok_or("requestId required")?;
        let request = self
            .inner
            .lock()
            .unwrap()
            .pending
            .remove(id)
            .ok_or("no such request")?;
        let input = &request["input"];
        let decision = p["decision"].as_str().unwrap_or_default();
        let message = p["message"].as_str().filter(|m| !m.trim().is_empty());
        if self.provider == Provider::Codex {
            return self.answer_codex(id, request, decision, p);
        }
        let allow = |updated: &Value| json!({"behavior":"allow","updatedInput":updated});
        let deny = |text: &str| json!({"behavior":"deny","message":text});
        let response = match (request["kind"].as_str(), decision) {
            (Some("permission"), "allow") | (Some("plan"), "accept") => allow(input),
            (Some("question"), "answer") => {
                let Some(answers) = p["answers"]
                    .as_object()
                    .filter(|a| a.values().all(Value::is_string))
                else {
                    self.inner
                        .lock()
                        .unwrap()
                        .pending
                        .insert(id.to_owned(), request);
                    return Err("answers must map each question to text");
                };
                let mut updated = input.clone();
                updated["answers"] = Value::Object(answers.clone());
                allow(&updated)
            }
            (Some("plan"), "revise") => deny(&format!(
                "The user wants changes to the plan: {}",
                message.unwrap_or("keep planning")
            )),
            (_, "deny") => deny(message.unwrap_or("The user declined this.")),
            _ => {
                self.inner
                    .lock()
                    .unwrap()
                    .pending
                    .insert(id.to_owned(), request);
                return Err("unknown decision");
            }
        };
        if !self.send(&claude::respond(id, &response)) {
            return Err("input queue full");
        }
        self.publish(
            "interaction.resolved",
            json!({"requestId":id,"decision":decision}),
        );
        Ok(())
    }

    /// Codex's answers: `accept`/`decline` for approvals, answers keyed by question id.
    fn answer_codex(&self, id: &str, request: Value, decision: &str, p: &Value) -> Reply {
        let result = match (request["kind"].as_str(), decision) {
            (Some("permission"), "allow") => json!({"decision":"accept"}),
            (Some("permission"), "deny") => json!({"decision":"decline"}),
            (Some("question"), "answer" | "deny") => {
                let given = p["answers"].as_object().cloned().unwrap_or_default();
                let answers: serde_json::Map<String, Value> = request["input"]["questions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|q| {
                        let text = given.get(q["question"].as_str()?)?.as_str()?;
                        Some((q["id"].as_str()?.to_owned(), json!({"answers":[text]})))
                    })
                    .collect();
                json!({"answers":answers})
            }
            _ => {
                self.inner
                    .lock()
                    .unwrap()
                    .pending
                    .insert(id.to_owned(), request);
                return Err("unknown decision");
            }
        };
        if !self.send(&codex::respond(&request["rpcId"], &result)) {
            return Err("input queue full");
        }
        self.publish(
            "interaction.resolved",
            json!({"requestId":id,"decision":decision}),
        );
        Ok(())
    }

    /// End the child: close its input, then signal its process group if it lingers.
    pub fn stop(&self) {
        let pid = {
            let mut inner = self.inner.lock().unwrap();
            inner.stopping = true;
            inner.stdin = None;
            inner.child_pid
        };
        if let Some(pid) = pid {
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(2)).await;
                signal_group(pid, libc::SIGTERM);
                tokio::time::sleep(Duration::from_secs(2)).await;
                signal_group(pid, libc::SIGKILL);
            });
        }
    }

    /// Kill the child's whole process group now, for app shutdown.
    pub fn kill(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.stopping = true;
        inner.stdin = None;
        if let Some(pid) = inner.child_pid {
            signal_group(pid, libc::SIGKILL);
        }
    }

    /// What survives a restart: enough to resume the conversation in its folder and mode.
    pub fn record(&self) -> Value {
        let inner = self.inner.lock().unwrap();
        json!({
            "id":self.id,"provider":self.provider.name(),"cwd":self.cwd,"sessionId":inner.state.session,
            "mode":inner.state.mode,"model":inner.state.model,"effort":inner.state.effort,"hook":inner.hook,
        })
    }

    pub fn session(&self) -> String {
        self.inner.lock().unwrap().state.session.clone()
    }

    pub fn running(&self) -> bool {
        self.inner.lock().unwrap().stdin.is_some()
    }

    /// Ready for the next prompt with nothing pending: the only state a handoff may leave.
    pub fn idle(&self) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.state.status == "ready" && inner.pending.is_empty()
    }

    /// Stop the child and wait for it to be reaped, up to `limit`.
    pub async fn stop_and_wait(&self, limit: Duration) -> bool {
        self.stop();
        let deadline = tokio::time::Instant::now() + limit;
        while self.inner.lock().unwrap().child_pid.is_some() {
            if tokio::time::Instant::now() > deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        true
    }

    pub fn summary(&self) -> Value {
        let inner = self.inner.lock().unwrap();
        json!({"id":self.id,"provider":self.provider.name(),"cwd":self.cwd,"epoch":inner.epoch,"status":inner.state.status,"sessionId":inner.state.session})
    }

    async fn supervise(
        self: Arc<Self>,
        mut child: Child,
        stdout: tokio::process::ChildStdout,
        errors: tokio::task::JoinHandle<()>,
        init: String,
    ) {
        let mut reader = BufReader::new(stdout);
        let mut buf = Vec::new();
        let mut init_id = Some(init);
        loop {
            match next_line(&mut reader, &mut buf).await {
                Ok(None) | Err(_) => break,
                Ok(Some(false)) => {
                    self.publish("run.warning", json!({"text":"dropped an oversized frame"}));
                }
                Ok(Some(true)) => {
                    let line = String::from_utf8_lossy(&buf);
                    if line.trim().is_empty() {
                        continue;
                    }
                    let decoded = match self.provider {
                        Provider::Claude => {
                            claude::decode(&line).map(|f| self.frame(f, &mut init_id))
                        }
                        Provider::Codex => codex::decode(&line).map(|m| self.codex(m)),
                    };
                    if decoded.is_none() {
                        self.publish("run.warning", json!({"text":"skipped a malformed frame"}));
                    }
                }
            }
        }
        let code = child.wait().await.ok().and_then(|s| s.code());
        // the exit reason is usually the last thing on stderr
        let _ = tokio::time::timeout(Duration::from_secs(1), errors).await;
        let expired: Vec<String> = self
            .inner
            .lock()
            .unwrap()
            .pending
            .drain()
            .map(|(id, _)| id)
            .collect();
        for id in expired {
            self.publish(
                "interaction.cancelled",
                json!({"requestId":id,"reason":"exited"}),
            );
        }
        let (stopping, tail) = {
            let mut inner = self.inner.lock().unwrap();
            inner.stdin = None;
            inner.child_pid = None;
            (
                inner.stopping,
                inner
                    .state
                    .stderr
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
        };
        if stopping {
            self.publish("run.state", json!({"status":"stopped","code":code}));
        } else {
            let error = if tail.is_empty() {
                format!(
                    "the agent exited (code {})",
                    code.map_or("none".into(), |c| c.to_string())
                )
            } else {
                tail
            };
            self.publish(
                "run.state",
                json!({"status":"failed","code":code,"error":error}),
            );
        }
    }

    fn frame(&self, frame: Frame, init_id: &mut Option<String>) {
        match frame {
            Frame::Init {
                session,
                model,
                mode,
            } => {
                // a resume must continue the same conversation, not fork a new one
                let expected = self.inner.lock().unwrap().state.session.clone();
                if session.as_deref().is_some_and(|got| got != expected) {
                    self.publish(
                        "run.warning",
                        json!({"text":format!("Claude reports session {} instead of {expected}", session.as_deref().unwrap_or_default())}),
                    );
                }
                self.publish(
                    "run.info",
                    json!({"sessionId":session,"model":model,"mode":mode}),
                );
            }
            Frame::Delta(text) => self.publish("item.delta", json!({"text":text})),
            Frame::Message(event) => {
                for mut item in claude_items(&event) {
                    // stream-json frames carry no time; the arrival time gives turns a duration
                    if item.get("ts").is_none() {
                        item["ts"] = now().into();
                    }
                    self.publish("item.completed", item);
                }
            }
            Frame::Result {
                error,
                subtype,
                cost,
            } => {
                let outcome = if self.inner.lock().unwrap().state.status == "interrupting" {
                    "interrupted"
                } else if error {
                    "error"
                } else {
                    "success"
                };
                self.publish(
                    "turn.finished",
                    json!({"outcome":outcome,"subtype":subtype,"cost":cost}),
                );
            }
            Frame::Request { id, subtype, body } if subtype == "can_use_tool" => {
                let kind = match body["tool_name"].as_str() {
                    Some("AskUserQuestion") => "question",
                    Some("ExitPlanMode") => "plan",
                    _ => "permission",
                };
                let request = json!({
                    "requestId": id, "kind": kind, "tool": body["tool_name"],
                    "toolUseId": body["tool_use_id"], "input": body["input"],
                });
                self.inner
                    .lock()
                    .unwrap()
                    .pending
                    .insert(id, request.clone());
                self.publish("interaction.requested", request);
            }
            Frame::Request { id, subtype, body } => {
                // a blocking request with no UI must fail, not leave the turn hanging
                self.send(&claude::refuse(
                    &id,
                    "Trame's agent view can't answer this request",
                ));
                self.publish(
                    "interaction.denied",
                    json!({"requestId":id,"subtype":subtype,"tool":body["tool_name"]}),
                );
            }
            Frame::Response { id, error, body } => {
                // taken out of the lock first: publish locks it again
                let (mode, model) = {
                    let mut inner = self.inner.lock().unwrap();
                    (inner.modes.remove(&id), inner.model_reqs.remove(&id))
                };
                if init_id.as_deref() == Some(id.as_str()) {
                    *init_id = None;
                    match error {
                        None => {
                            // the CLI says which mode it starts in and which models it offers
                            let models: Vec<Value> = body["models"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .map(|m| json!({
                                    "value": m["value"], "resolved": m["resolvedModel"], "label": m["displayName"], "description": m["description"],
                                    "efforts": m["supportedEffortLevels"],
                                }))
                                .collect();
                            // the CLI doesn't say its effort: it starts at the one its settings give
                            let effort = self.inner.lock().unwrap().state.effort.clone();
                            let effort = effort.or_else(|| claude::default_effort(&self.cwd));
                            self.publish(
                                "run.info",
                                json!({"mode":body["current_permission_mode"],"models":models,"effort":effort}),
                            );
                            self.status("ready");
                        }
                        Some(e) => self.publish("run.state", json!({"status":"failed","error":e})),
                    }
                } else if let Some(mode) = mode.filter(|_| error.is_none()) {
                    self.publish("run.info", json!({"mode":mode}));
                } else if model && error.is_none() {
                    self.publish("run.info", json!({"model":body["model"]}));
                } else if let Some(e) = error {
                    self.publish("run.warning", json!({"text":e,"requestId":id}));
                }
            }
            Frame::Mode(mode) => self.publish("run.info", json!({"mode":mode})),
            Frame::Cancel(id) => {
                // withdrawn by the CLI: a late answer must not reach it
                if self.inner.lock().unwrap().pending.remove(&id).is_some() {
                    self.publish("interaction.cancelled", json!({"requestId":id}));
                }
            }
            Frame::Other(_) => {}
        }
    }
}

impl Run {
    fn codex(&self, msg: Msg) {
        match msg {
            Msg::Response { id, result, error } => {
                let purpose = id
                    .as_u64()
                    .and_then(|id| self.inner.lock().unwrap().rpc.remove(&id));
                match (purpose, error) {
                    (Some(Rpc::Initialize), None) => {
                        self.send(&codex::notify("initialized"));
                        let (cwd, resume) = {
                            let inner = self.inner.lock().unwrap();
                            (
                                inner.state.cwd.clone(),
                                inner.codex_resume.then(|| inner.state.session.clone()),
                            )
                        };
                        let (method, params) = codex::thread(&cwd, resume.as_deref());
                        self.send(&codex::request(self.rpc(Rpc::Thread), method, &params));
                    }
                    (Some(Rpc::Thread), None) => {
                        let thread = result["thread"]["id"]
                            .as_str()
                            .unwrap_or_default()
                            .to_owned();
                        let expected = self.session();
                        if self.inner.lock().unwrap().codex_resume && thread != expected {
                            self.publish(
                                "run.warning",
                                json!({"text":format!("Codex resumed thread {thread} instead of {expected}")}),
                            );
                        }
                        self.publish(
                            "run.info",
                            json!({"sessionId":thread,"model":result["model"],"effort":result["reasoningEffort"]}),
                        );
                        self.status("ready");
                        // the models and efforts offered, for the pickers
                        self.send(&codex::request(
                            self.rpc(Rpc::Models),
                            "model/list",
                            &json!({}),
                        ));
                    }
                    (Some(Rpc::Models), None) => {
                        let models: Vec<Value> = result["data"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter(|m| m["hidden"] != true)
                            .map(|m| {
                                let efforts: Vec<Value> = m["supportedReasoningEfforts"]
                                    .as_array()
                                    .into_iter()
                                    .flatten()
                                    .map(|e| e["reasoningEffort"].clone())
                                    .collect();
                                json!({"value":m["model"],"label":m["displayName"],"description":m["description"],"efforts":efforts})
                            })
                            .collect();
                        self.publish("run.info", json!({"models":models}));
                    }
                    (Some(Rpc::Initialize | Rpc::Thread), Some(e)) => {
                        self.publish("run.state", json!({"status":"failed","error":e}));
                    }
                    (Some(Rpc::Turn), Some(e)) => {
                        self.publish("run.warning", json!({"text":e}));
                        self.publish(
                            "turn.finished",
                            json!({"outcome":"error","subtype":"rejected"}),
                        );
                    }
                    (Some(Rpc::Turn), None) => {
                        self.inner.lock().unwrap().codex_turn =
                            result["turn"]["id"].as_str().map(str::to_owned);
                    }
                    (_, Some(e)) => self.publish("run.warning", json!({"text":e})),
                    _ => {}
                }
            }
            Msg::Notification { method, params } => match method.as_str() {
                "item/agentMessage/delta" => {
                    self.publish("item.delta", json!({"text":params["delta"]}));
                }
                // a file change is shown in its approval before it completes
                "item/started" if params["item"]["type"] == "fileChange" => {
                    let id = params["item"]["id"].as_str().unwrap_or_default().to_owned();
                    let patch = codex::patch(&params["item"]["changes"]);
                    self.inner.lock().unwrap().patches.insert(id, patch);
                }
                "item/completed" => {
                    for mut item in codex::items(&params["item"]) {
                        item["ts"] = now().into();
                        self.publish("item.completed", item);
                    }
                }
                "turn/started" => {
                    self.inner.lock().unwrap().codex_turn =
                        params["turn"]["id"].as_str().map(str::to_owned);
                }
                "turn/completed" => {
                    self.inner.lock().unwrap().codex_turn = None;
                    let outcome = match params["turn"]["status"].as_str() {
                        Some("completed") => "success",
                        Some("interrupted") => "interrupted",
                        _ => "error",
                    };
                    self.publish(
                        "turn.finished",
                        json!({"outcome":outcome,"subtype":params["turn"]["status"]}),
                    );
                }
                "error" if params["willRetry"] != true => {
                    self.publish("run.warning", json!({"text":params["error"]["message"]}));
                }
                // answered elsewhere or withdrawn: a late answer must not reach Codex
                "serverRequest/resolved" => {
                    let id = request_key(&params["requestId"]);
                    if self.inner.lock().unwrap().pending.remove(&id).is_some() {
                        self.publish("interaction.cancelled", json!({"requestId":id}));
                    }
                }
                _ => {}
            },
            Msg::Request { id, method, params } => {
                let key = request_key(&id);
                let request = match method.as_str() {
                    "item/commandExecution/requestApproval" => Some(json!({
                        "kind": "permission", "tool": "Bash",
                        "input": {"command": params["command"], "cwd": params["cwd"], "description": params["reason"]},
                    })),
                    "item/fileChange/requestApproval" => {
                        let item = params["itemId"].as_str().unwrap_or_default();
                        let patch = self
                            .inner
                            .lock()
                            .unwrap()
                            .patches
                            .get(item)
                            .cloned()
                            .unwrap_or_default();
                        Some(
                            json!({"kind":"permission","tool":"apply_patch","input":{"input":patch,"description":params["reason"]}}),
                        )
                    }
                    "item/tool/requestUserInput" => {
                        let questions: Vec<Value> = params["questions"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .map(|q| {
                                json!({
                                    "id": q["id"], "question": q["question"], "header": q["header"], "multiSelect": false,
                                    "options": q["options"].as_array().map(|o| o.iter().map(|o| json!({"label":o["label"],"description":o["description"]})).collect::<Vec<_>>()),
                                })
                            })
                            .collect();
                        Some(
                            json!({"kind":"question","tool":"request_user_input","input":{"questions":questions}}),
                        )
                    }
                    _ => None,
                };
                if let Some(mut request) = request {
                    request["requestId"] = key.clone().into();
                    request["rpcId"] = id;
                    self.inner
                        .lock()
                        .unwrap()
                        .pending
                        .insert(key, request.clone());
                    self.publish("interaction.requested", request);
                } else {
                    // a blocking request with no UI must fail, not leave the turn hanging
                    self.send(&codex::refuse(
                        &id,
                        "Trame's agent view can't answer this request",
                    ));
                    self.publish(
                        "interaction.denied",
                        json!({"requestId":key,"subtype":method}),
                    );
                }
            }
        }
    }
}

/// A model or effort name as the CLIs spell them: `claude-opus-5-5`, `gpt-6.2`, `xhigh`.
pub(crate) fn valid_choice(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 80
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.:[]".contains(c))
}

/// A JSON-RPC id as the string key clients answer by.
fn request_key(id: &Value) -> String {
    id.as_str().map_or_else(|| id.to_string(), str::to_owned)
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn snapshot(inner: &Inner) -> Value {
    json!({"type":"snapshot","epoch":inner.epoch,"seq":inner.seq,"writer":inner.writer,"state":inner.state.to_json()})
}

/// The reducer: what each event changes in the state a snapshot carries.
fn apply(state: &mut State, kind: &str, p: &Value) {
    match kind {
        "run.state" => {
            if let Some(status) = p["status"].as_str() {
                state.status = match status {
                    "ready" => "ready",
                    "busy" => "busy",
                    "interrupting" => "interrupting",
                    "stopped" => "stopped",
                    "failed" => "failed",
                    _ => "starting",
                };
            }
            if let Some(e) = p["error"].as_str() {
                state.error = Some(e.to_owned());
            }
        }
        "run.info" => {
            if let Some(s) = p["sessionId"].as_str() {
                s.clone_into(&mut state.session);
            }
            state.model = p["model"]
                .as_str()
                .map(str::to_owned)
                .or(state.model.take());
            state.mode = p["mode"].as_str().map(str::to_owned).or(state.mode.take());
            if let Some(e) = p["effort"].as_str() {
                state.effort = Some(e.to_owned());
            }
            if let Some(models) = p["models"].as_array() {
                models.clone_into(&mut state.models);
            }
        }
        "turn.started" => {
            state.turn += 1;
            state.status = "busy";
            state.partial.clear();
        }
        "turn.finished" => {
            state.status = "ready";
            state.partial.clear();
        }
        "interaction.requested" => state.interactions.push(p.clone()),
        "inbox.queued" => state.queued += 1,
        "inbox.delivered" => state.queued = state.queued.saturating_sub(1),
        "interaction.resolved" | "interaction.cancelled" => {
            state
                .interactions
                .retain(|i| i["requestId"] != p["requestId"]);
        }
        "item.delta" => state
            .partial
            .push_str(p["text"].as_str().unwrap_or_default()),
        "item.completed" => {
            if p["kind"] == "assistant" {
                state.partial.clear();
            }
            state.items.push_back(p.clone());
            if state.items.len() > ITEMS {
                state.items.pop_front();
                state.dropped += 1;
            }
        }
        _ => {}
    }
}

/// Read one newline-terminated line into `buf`: `Some(true)` for a line, `Some(false)` when it
/// exceeded `MAX_LINE` and was dropped, `None` at end of stream.
async fn next_line<R: AsyncBufRead + Unpin>(
    r: &mut R,
    buf: &mut Vec<u8>,
) -> std::io::Result<Option<bool>> {
    buf.clear();
    let mut over = false;
    loop {
        let chunk = r.fill_buf().await?;
        if chunk.is_empty() {
            return Ok((over || !buf.is_empty()).then_some(!over));
        }
        if let Some(i) = chunk.iter().position(|&b| b == b'\n') {
            if !over {
                buf.extend_from_slice(&chunk[..i]);
            }
            r.consume(i + 1);
            if buf.len() > MAX_LINE {
                buf.clear();
                over = true;
            }
            return Ok(Some(!over));
        }
        let n = chunk.len();
        if !over {
            buf.extend_from_slice(chunk);
            if buf.len() > MAX_LINE {
                over = true;
                buf.clear();
            }
        }
        r.consume(n);
    }
}

async fn write_stdin(mut stdin: tokio::process::ChildStdin, mut rx: mpsc::Receiver<String>) {
    while let Some(line) = rx.recv().await {
        if stdin.write_all(line.as_bytes()).await.is_err() || stdin.write_all(b"\n").await.is_err()
        {
            return;
        }
        if stdin.flush().await.is_err() {
            return;
        }
    }
    // every sender dropped: closing stdin tells the CLI to finish
}

async fn read_stderr(run: Arc<Run>, stderr: tokio::process::ChildStderr) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let mut inner = run.inner.lock().unwrap();
        inner.state.stderr.push_back(line);
        if inner.state.stderr.len() > STDERR_LINES {
            inner.state.stderr.pop_front();
        }
    }
}

#[allow(unsafe_code, reason = "libc::kill on the child's own process group")]
fn signal_group(pid: i32, sig: i32) {
    if pid > 1 {
        unsafe { libc::kill(-pid, sig) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn next_line_splits_caps_and_keeps_a_last_unterminated_line() {
        let big = "x".repeat(MAX_LINE + 1);
        let input = format!("a\n{big}\nb\nc");
        let mut r = BufReader::with_capacity(8, input.as_bytes());
        let mut buf = Vec::new();
        let mut got = Vec::new();
        while let Some(ok) = next_line(&mut r, &mut buf).await.unwrap() {
            got.push((ok, String::from_utf8_lossy(&buf).into_owned()));
        }
        let want: Vec<(bool, String)> = vec![
            (true, "a".into()),
            (false, String::new()),
            (true, "b".into()),
            (true, "c".into()),
        ];
        assert_eq!(got, want);
    }
}
