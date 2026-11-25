use serde_json::{Value, json};
use std::{
    collections::{HashSet, VecDeque},
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

use super::claude::{self, Frame};
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

/// One live agent run: its child, its reduced state and the clients following it.
pub struct Run {
    pub id: String,
    pub cwd: PathBuf,
    bin: String,
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
}

#[derive(Default)]
struct State {
    status: &'static str,
    session: String,
    model: Option<String>,
    mode: Option<String>,
    turn: u64,
    items: VecDeque<Value>,
    dropped: u64,
    partial: String,
    error: Option<String>,
    stderr: VecDeque<String>,
}

impl State {
    fn to_json(&self) -> Value {
        json!({
            "status": self.status,
            "sessionId": self.session,
            "model": self.model,
            "mode": self.mode,
            "turn": self.turn,
            "items": self.items,
            "droppedItems": self.dropped,
            "partial": self.partial,
            "error": self.error,
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
    /// Start a run in `cwd`: a fresh conversation, or `resume` an existing one by its provider ID.
    pub fn start(
        id: String,
        cwd: PathBuf,
        bin: String,
        resume: Option<String>,
    ) -> std::io::Result<Arc<Self>> {
        let (tx, _) = broadcast::channel(1024);
        let resumed = resume.is_some();
        let session = resume.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let run = Arc::new(Self {
            id,
            cwd,
            bin,
            tx,
            inner: Mutex::new(Inner {
                epoch: String::new(),
                seq: 0,
                ring: VecDeque::new(),
                state: State {
                    session,
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
            }),
        });
        run.spawn(resumed)?;
        Ok(run)
    }

    /// Restart a stopped or failed run, resuming its conversation under a new epoch.
    pub fn restart(self: &Arc<Self>) -> Result<(), &'static str> {
        if self.inner.lock().unwrap().stdin.is_some() {
            return Err("still running");
        }
        self.spawn(true).map_err(|_| "spawn failed")
    }

    fn spawn(self: &Arc<Self>, resume: bool) -> std::io::Result<()> {
        let session = self.inner.lock().unwrap().state.session.clone();
        let mut cmd = Command::new(&self.bin);
        cmd.args(claude::args(resume.then_some(session.as_str()), &session))
            .current_dir(&self.cwd)
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
            let snapshot = snapshot(&inner);
            let _ = self.tx.send(snapshot);
        }
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let init = self.next_request();
        let _ = stdin_tx.try_send(claude::initialize(&init).to_string());
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
    pub fn command(&self, lease: u64, cmd: &Value) -> Reply {
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
                (Some("stop"), _) => {}
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
                if !self.send(&claude::user_message(&text)) {
                    return Err("input queue full");
                }
                self.publish("turn.started", json!({}));
                self.publish(
                    "item.completed",
                    json!({"kind":"user","text":text,"truncated":false}),
                );
            }
            Some("interrupt") => {
                let id = self.next_request();
                if !self.send(&claude::interrupt(&id)) {
                    return Err("input queue full");
                }
                self.status("interrupting");
            }
            _ => self.stop(),
        }
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

    pub fn summary(&self) -> Value {
        let inner = self.inner.lock().unwrap();
        json!({"id":self.id,"cwd":self.cwd,"epoch":inner.epoch,"status":inner.state.status,"sessionId":inner.state.session})
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
                    match claude::decode(&line) {
                        None => {
                            self.publish(
                                "run.warning",
                                json!({"text":"skipped a malformed frame"}),
                            );
                        }
                        Some(frame) => self.frame(frame, &mut init_id),
                    }
                }
            }
        }
        let code = child.wait().await.ok().and_then(|s| s.code());
        // the exit reason is usually the last thing on stderr
        let _ = tokio::time::timeout(Duration::from_secs(1), errors).await;
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
                self.publish(
                    "run.info",
                    json!({"sessionId":session,"model":model,"mode":mode}),
                );
            }
            Frame::Delta(text) => self.publish("item.delta", json!({"text":text})),
            Frame::Message(event) => {
                for item in claude_items(&event) {
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
            Frame::Request { id, subtype, body } => {
                // decisions arrive in a later PR: deny rather than leave the turn hanging
                let reason = "Trame's agent view can't answer this yet";
                let reply = if subtype == "can_use_tool" {
                    claude::respond(&id, &json!({"behavior":"deny","message":reason}))
                } else {
                    claude::refuse(&id, reason)
                };
                self.send(&reply);
                self.publish(
                    "interaction.denied",
                    json!({"requestId":id,"subtype":subtype,"tool":body["tool_name"],"input":body["input"]}),
                );
            }
            Frame::Response { id, error } => {
                if init_id.as_deref() == Some(id.as_str()) {
                    *init_id = None;
                    match error {
                        None => self.status("ready"),
                        Some(e) => self.publish("run.state", json!({"status":"failed","error":e})),
                    }
                } else if let Some(e) = error {
                    self.publish("run.warning", json!({"text":e,"requestId":id}));
                }
            }
            Frame::Cancel(id) => self.publish("interaction.cancelled", json!({"requestId":id})),
            Frame::Other(_) => {}
        }
    }
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
