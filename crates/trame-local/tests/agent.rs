mod common;
use common::TestDb;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::Duration;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async, tungstenite::Message};
use trame_local::pty::TOKEN_HEADER;

type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

/// Frames received until `done` holds on the last one; panics on timeout.
async fn until(ws: &mut Ws, done: impl Fn(&Value) -> bool) -> Vec<Value> {
    let mut seen = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let next = tokio::time::timeout_at(deadline, ws.next()).await;
        match next.expect("timed out waiting for agent frames") {
            Some(Ok(Message::Text(t))) => {
                let v: Value = serde_json::from_str(&t).unwrap();
                let stop = done(&v);
                seen.push(v);
                if stop {
                    return seen;
                }
            }
            Some(Ok(_)) => {}
            other => panic!("socket ended: {other:?}; seen {seen:?}"),
        }
    }
}

fn kind(k: &'static str) -> impl Fn(&Value) -> bool {
    move |v| v["kind"] == k
}

fn status(s: &'static str) -> impl Fn(&Value) -> bool {
    move |v| v["kind"] == "run.state" && v["payload"]["status"] == s
}

async fn attach(base: &str, run: &str, hello: Value) -> Ws {
    let url = format!("{}/api/agent/runs/{run}/ws", base.replacen("http", "ws", 1));
    let (mut ws, _) = connect_async(url).await.unwrap();
    ws.send(Message::Text(hello.to_string().into()))
        .await
        .unwrap();
    ws
}

/// Send a prompt-style command and return the server's reply to it.
async fn command(ws: &mut Ws, id: &str, epoch: &str, kind: &str, text: &str) -> Value {
    send(ws, id, epoch, kind, json!({"text":text})).await
}

async fn send(ws: &mut Ws, id: &str, epoch: &str, kind: &str, payload: Value) -> Value {
    let cmd = json!({"type":"command","commandId":id,"epoch":epoch,"kind":kind,"payload":payload});
    ws.send(Message::Text(cmd.to_string().into()))
        .await
        .unwrap();
    let frames = until(ws, |v| v["type"] == "reply" && v["commandId"] == id).await;
    frames.last().unwrap().clone()
}

fn assistant_texts(frames: &[Value]) -> Vec<String> {
    frames
        .iter()
        .filter(|v| v["kind"] == "item.completed" && v["payload"]["kind"] == "assistant")
        .map(|v| v["payload"]["text"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn agent_view_can_be_turned_off() {
    let t = TestDb::with_env(&[("TRAME_AGENT_VIEW", "0")]);
    let rt = tokio::runtime::Runtime::new().unwrap();
    let status = rt.block_on(async {
        reqwest::get(format!("{}/api/agent/runs", t.base_url()))
            .await
            .unwrap()
            .status()
    });
    assert_eq!(status, 404);
}

#[test]
fn supervisor_runs_turns_denies_decisions_and_reconnects() {
    let fake = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fake-claude.py");
    let log = trame_local::workspace().join(format!(
        ".scratch/agent-argv-{}.log",
        uuid::Uuid::new_v4().simple()
    ));
    let t = TestDb::with_env(&[
        ("TRAME_CLAUDE_BIN", fake),
        ("FAKE_LOG", log.to_str().unwrap()),
        // the launching agent's own session must not leak into the child
        ("CLAUDE_CODE_ENTRYPOINT", "cli"),
    ]);
    let base = t.base_url();
    let cwd = t.root.to_str().unwrap().to_owned();
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let http = reqwest::Client::new();
        let token = http.get(format!("{base}/api/term/token")).send().await.unwrap().json::<Value>().await.unwrap()["token"]
            .as_str()
            .unwrap()
            .to_owned();
        let unauthorized = http.post(format!("{base}/api/agent/runs")).json(&json!({"cwd":cwd})).send().await.unwrap();
        assert_eq!(unauthorized.status(), 401);
        let created = http
            .post(format!("{base}/api/agent/runs"))
            .header(TOKEN_HEADER, &token)
            .json(&json!({"cwd":cwd}))
            .send()
            .await
            .unwrap();
        assert_eq!(created.status(), 201);
        let created: Value = created.json().await.unwrap();
        let run = created["id"].as_str().unwrap().to_owned();
        let epoch = created["epoch"].as_str().unwrap().to_owned();

        let bad = attach(&base, &run, json!({"type":"attach","token":"nope","role":"writer"})).await;
        drop(bad);
        let mut w = attach(&base, &run, json!({"type":"attach","token":token,"role":"writer"})).await;
        let hello = until(&mut w, |v| v["type"] == "snapshot").await;
        assert_eq!(hello[0]["type"], "attached");
        until(&mut w, status("ready")).await;

        // two turns on one child
        assert_eq!(command(&mut w, "c1", &epoch, "prompt", "hello").await["accepted"], true);
        let turn = until(&mut w, kind("turn.finished")).await;
        assert!(turn.iter().any(|v| v["kind"] == "item.delta"));
        assert_eq!(assistant_texts(&turn), ["echo: hello"]);
        assert_eq!(turn.last().unwrap()["payload"]["outcome"], "success");
        for (id, ep, reason) in [("c1", epoch.as_str(), "duplicate command"), ("c2", "old", "stale epoch")] {
            let r = command(&mut w, id, ep, "prompt", "again").await;
            assert_eq!((r["accepted"].clone(), r["reason"].clone()), (json!(false), json!(reason)));
        }

        // a tool the CLI asks about waits for the user's decision
        command(&mut w, "c3", &epoch, "prompt", "write").await;
        let asked = until(&mut w, kind("interaction.requested")).await;
        let request = asked.last().unwrap()["payload"]["requestId"].clone();
        let r = send(&mut w, "c3b", &epoch, "answer", json!({"requestId":request,"decision":"deny","message":"no"})).await;
        assert_eq!(r["accepted"], true);
        let turn = until(&mut w, kind("turn.finished")).await;
        assert_eq!(assistant_texts(&turn), ["Write deny: no"]);

        // a malformed frame is reported and skipped
        command(&mut w, "c4", &epoch, "prompt", "garbage").await;
        let turn = until(&mut w, kind("turn.finished")).await;
        assert!(turn.iter().any(|v| v["kind"] == "run.warning"));
        assert_eq!(assistant_texts(&turn), ["echo: garbage"]);

        // busy, then interrupted
        command(&mut w, "c5", &epoch, "prompt", "hang").await;
        assert_eq!(command(&mut w, "c6", &epoch, "prompt", "more").await["reason"], "busy");
        assert_eq!(command(&mut w, "c7", &epoch, "interrupt", "").await["accepted"], true);
        let turn = until(&mut w, kind("turn.finished")).await;
        assert_eq!(turn.last().unwrap()["payload"]["outcome"], "interrupted");
        let last_seq = turn.last().unwrap()["seq"].as_u64().unwrap();

        // a watcher reconnecting from a cursor gets the missed events, not a snapshot
        let mut watcher = attach(
            &base,
            &run,
            json!({"type":"attach","token":token,"role":"watcher","epoch":epoch,"afterSeq":last_seq - 2}),
        )
        .await;
        let replay = until(&mut watcher, |v| v["seq"].as_u64() == Some(last_seq)).await;
        assert_eq!(replay.iter().filter(|v| v["type"] == "event").count(), 2);
        assert!(replay.iter().all(|v| v["type"] != "snapshot"));
        assert_eq!(command(&mut watcher, "c8", &epoch, "prompt", "hi").await["reason"], "not the writer");

        // a stale cursor gets a snapshot with the whole state
        let mut stale = attach(&base, &run, json!({"type":"attach","token":token,"role":"watcher","epoch":"gone","afterSeq":1})).await;
        let snap = until(&mut stale, |v| v["type"] == "snapshot").await;
        let state = &snap.last().unwrap()["state"];
        assert_eq!(state["status"], "ready");
        assert_eq!(state["turn"], 4);
        assert_eq!(state["model"], "fake-model");

        // a second writer takes the lease over
        let mut w2 = attach(&base, &run, json!({"type":"attach","token":token,"role":"writer"})).await;
        until(&mut w2, |v| v["type"] == "snapshot").await;
        until(&mut w, |v| v["type"] == "lease").await;
        assert_eq!(command(&mut w, "c9", &epoch, "prompt", "hi").await["reason"], "not the writer");

        // a crash fails the run with the CLI's own message; a restart resumes the conversation
        command(&mut w2, "c10", &epoch, "prompt", "crash").await;
        let failed = until(&mut w2, status("failed")).await;
        assert!(failed.last().unwrap()["payload"]["error"].as_str().unwrap().contains("boom"));
        let session = state["sessionId"].as_str().unwrap().to_owned();
        let restarted = http
            .post(format!("{base}/api/agent/runs/{run}/restart"))
            .header(TOKEN_HEADER, &token)
            .send()
            .await
            .unwrap();
        assert_eq!(restarted.status(), 200);
        let snap = until(&mut w2, |v| v["type"] == "snapshot").await;
        let epoch2 = snap.last().unwrap()["epoch"].as_str().unwrap().to_owned();
        assert_ne!(epoch2, epoch);
        until(&mut w2, status("ready")).await;
        assert_eq!(command(&mut w2, "c11", &epoch2, "prompt", "back").await["accepted"], true);
        assert_eq!(assistant_texts(&until(&mut w2, kind("turn.finished")).await), ["echo: back"]);
        let runs: Vec<Value> = std::fs::read_to_string(&log)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        let argv = |i: usize| serde_json::from_value::<Vec<String>>(runs[i]["args"].clone()).unwrap();
        assert_eq!(runs.len(), 2);
        assert!(argv(0).windows(2).any(|w| w == ["--session-id", session.as_str()]));
        assert!(argv(1).windows(2).any(|w| w == ["--resume", session.as_str()]));
        assert_eq!(runs[0]["leaked"], json!([]));

        // stopping ends the child and the run
        let stopped = http
            .delete(format!("{base}/api/agent/runs/{run}"))
            .header(TOKEN_HEADER, &token)
            .send()
            .await
            .unwrap();
        assert_eq!(stopped.status(), 200);
        until(&mut w2, status("stopped")).await;
    });
    let _ = std::fs::remove_file(&log);
}

/// Start a run of the fake CLI and attach a writer once it is ready.
async fn ready_run(base: &str, token: &str, body: Value) -> (String, String, Ws) {
    let created: Value = reqwest::Client::new()
        .post(format!("{base}/api/agent/runs"))
        .header(TOKEN_HEADER, token)
        .json(&body)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let run = created["id"].as_str().unwrap().to_owned();
    let epoch = created["epoch"].as_str().unwrap().to_owned();
    let mut ws = attach(
        base,
        &run,
        json!({"type":"attach","token":token,"role":"writer"}),
    )
    .await;
    until(&mut ws, status("ready")).await;
    (run, epoch, ws)
}

/// Prompt `text`, wait for the request it raises and return its ID.
async fn ask(ws: &mut Ws, epoch: &str, id: &str, text: &str, want: &str) -> Value {
    command(ws, id, epoch, "prompt", text).await;
    let asked = until(ws, kind("interaction.requested")).await;
    let payload = &asked.last().unwrap()["payload"];
    assert_eq!(payload["kind"], want, "{text}");
    payload["requestId"].clone()
}

#[test]
fn decisions_reach_the_cli_once_and_expire_with_it() {
    let fake = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fake-claude.py");
    let log = trame_local::workspace().join(format!(
        ".scratch/agent-argv-{}.log",
        uuid::Uuid::new_v4().simple()
    ));
    let t = TestDb::with_env(&[
        ("TRAME_CLAUDE_BIN", fake),
        ("FAKE_LOG", log.to_str().unwrap()),
    ]);
    let base = t.base_url();
    let cwd = t.root.to_str().unwrap().to_owned();
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let token = reqwest::get(format!("{base}/api/term/token")).await.unwrap().json::<Value>().await.unwrap()["token"]
            .as_str()
            .unwrap()
            .to_owned();
        let bad_mode = reqwest::Client::new()
            .post(format!("{base}/api/agent/runs"))
            .header(TOKEN_HEADER, &token)
            .json(&json!({"cwd":cwd,"mode":"bypassPermissions"}))
            .send()
            .await
            .unwrap();
        assert_eq!(bad_mode.status(), 400);
        let (run, epoch, mut w) = ready_run(&base, &token, json!({"cwd":cwd,"mode":"plan"})).await;
        let argv = std::fs::read_to_string(&log).unwrap();
        assert!(argv.contains(r#""--permission-mode", "plan""#), "{argv}");

        // allow, once
        let req = ask(&mut w, &epoch, "p1", "write", "permission").await;
        assert_eq!(send(&mut w, "a1", &epoch, "answer", json!({"requestId":req,"decision":"allow"})).await["accepted"], true);
        assert_eq!(assistant_texts(&until(&mut w, kind("turn.finished")).await), ["Write allow"]);
        let again = send(&mut w, "a2", &epoch, "answer", json!({"requestId":req,"decision":"deny"})).await;
        assert_eq!(again["reason"], "no such request");

        // a question gets its answers in the tool input
        let req = ask(&mut w, &epoch, "p2", "ask", "question").await;
        let bad = send(&mut w, "a3", &epoch, "answer", json!({"requestId":req,"decision":"answer","answers":{"Which db?":1}})).await;
        assert_eq!(bad["accepted"], false);
        let ok = send(&mut w, "a4", &epoch, "answer", json!({"requestId":req,"decision":"answer","answers":{"Which db?":"pg"}})).await;
        assert_eq!(ok["accepted"], true);
        assert_eq!(assistant_texts(&until(&mut w, kind("turn.finished")).await), [r#"answered {"Which db?": "pg"}"#]);

        // a plan is revised with feedback, then accepted; the CLI reports the mode it left plan for
        let req = ask(&mut w, &epoch, "p3", "plan", "plan").await;
        send(&mut w, "a5", &epoch, "answer", json!({"requestId":req,"decision":"revise","message":"smaller"})).await;
        assert_eq!(
            assistant_texts(&until(&mut w, kind("turn.finished")).await),
            ["ExitPlanMode deny: The user wants changes to the plan: smaller"]
        );
        let req = ask(&mut w, &epoch, "p4", "plan", "plan").await;
        send(&mut w, "a6", &epoch, "answer", json!({"requestId":req,"decision":"accept"})).await;
        let turn = until(&mut w, kind("turn.finished")).await;
        assert!(turn.iter().any(|v| v["kind"] == "run.info" && v["payload"]["mode"] == "default"));
        assert_eq!(assistant_texts(&turn), ["ExitPlanMode allow"]);

        // switching mode waits for the CLI's acknowledgement
        assert_eq!(send(&mut w, "m1", &epoch, "setMode", json!({"mode":"acceptEdits"})).await["accepted"], true);
        until(&mut w, |v| v["kind"] == "run.info" && v["payload"]["mode"] == "acceptEdits").await;
        assert_eq!(send(&mut w, "m2", &epoch, "setMode", json!({"mode":"bypassPermissions"})).await["reason"], "unknown mode");

        // the CLI's models arrive with initialize; a switch waits for its answer
        let snap: Value = reqwest::Client::new()
            .get(format!("{base}/api/agent/runs/{run}"))
            .header(TOKEN_HEADER, &token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(snap["state"]["models"][1]["value"], "sonnet");
        assert_eq!(snap["state"]["models"][0]["efforts"], json!(["low", "high", "max"]));
        send(&mut w, "md1", &epoch, "setModel", json!({"model":"sonnet"})).await;
        until(&mut w, |v| v["kind"] == "run.info" && v["payload"]["model"] == "claude-sonnet").await;
        assert_eq!(send(&mut w, "md2", &epoch, "setModel", json!({"model":"a b"})).await["reason"], "unknown model");

        // effort is a launch flag: setting it resumes the same conversation with it
        assert_eq!(send(&mut w, "e1", &epoch, "setEffort", json!({"effort":"high"})).await["accepted"], true);
        let restarted = until(&mut w, |v| v["type"] == "snapshot").await;
        let epoch = restarted.last().unwrap()["epoch"].as_str().unwrap().to_owned();
        until(&mut w, status("ready")).await;
        let last = std::fs::read_to_string(&log).unwrap().lines().last().unwrap().to_owned();
        for flag in [r#""--effort", "high""#, r#""--model", "claude-sonnet""#, r#""--resume""#] {
            assert!(last.contains(flag), "{flag} in {last}");
        }

        // a withdrawn request can't be answered late
        command(&mut w, "p5", &epoch, "prompt", "cancelme").await;
        let turn = until(&mut w, kind("turn.finished")).await;
        let cancelled = turn.iter().find(|v| v["kind"] == "interaction.cancelled").unwrap();
        let late = send(&mut w, "a7", &epoch, "answer", json!({"requestId":cancelled["payload"]["requestId"],"decision":"allow"})).await;
        assert_eq!(late["reason"], "no such request");

        // interrupting a pending question withdraws it
        ask(&mut w, &epoch, "p6", "ask", "question").await;
        send(&mut w, "i1", &epoch, "interrupt", json!({})).await;
        let turn = until(&mut w, kind("turn.finished")).await;
        assert!(turn.iter().any(|v| v["kind"] == "interaction.cancelled"));
        assert_eq!(turn.last().unwrap()["payload"]["outcome"], "interrupted");

        // a client reconnecting while a decision is pending sees it in the snapshot; the old writer can't answer
        let req = ask(&mut w, &epoch, "p7", "write", "permission").await;
        let mut w2 = attach(&base, &run, json!({"type":"attach","token":token,"role":"writer"})).await;
        let snap = until(&mut w2, |v| v["type"] == "snapshot").await;
        let pending = &snap.last().unwrap()["state"]["interactions"];
        assert_eq!(pending.as_array().unwrap().len(), 1);
        assert_eq!(pending[0]["requestId"], req);
        let stale = send(&mut w, "a8", &epoch, "answer", json!({"requestId":req,"decision":"allow"})).await;
        assert_eq!(stale["reason"], "not the writer");

        // stopping the run expires what it was waiting on
        reqwest::Client::new()
            .delete(format!("{base}/api/agent/runs/{run}"))
            .header(TOKEN_HEADER, &token)
            .send()
            .await
            .unwrap();
        let end = until(&mut w2, status("stopped")).await;
        assert!(end.iter().any(|v| v["kind"] == "interaction.cancelled" && v["payload"]["reason"] == "exited"));
    });
    let _ = std::fs::remove_file(&log);
}

#[test]
fn runs_come_back_stopped_with_their_history_and_hand_off_to_a_terminal() {
    let fake = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fake-claude.py");
    let log = trame_local::workspace().join(format!(
        ".scratch/agent-argv-{}.log",
        uuid::Uuid::new_v4().simple()
    ));
    let session = "5f1c2b9a-7d3e-4c1a-9b2f-0e8d6a4c3b21";
    let cwd = trame_local::workspace().join(".scratch");
    let records =
        json!([{"id":"r1","provider":"claude","cwd":cwd,"sessionId":session,"mode":"plan"}])
            .to_string();
    let transcript = [
        json!({"type":"user","timestamp":"2026-11-25T10:00:00Z","message":{"role":"user","content":"fix the cart"}}),
        json!({"type":"assistant","timestamp":"2026-11-25T10:00:05Z","message":{"role":"assistant","content":[{"type":"text","text":"Fixed."}]}}),
    ]
    .map(|l| l.to_string())
    .join("\n")
        + "\n";
    let transcript_path = format!("claude-projects/-work-acme/{session}.jsonl");
    let t = TestDb::with_files(
        &[
            ("TRAME_CLAUDE_BIN", fake),
            ("FAKE_LOG", log.to_str().unwrap()),
            ("SHELL", "/bin/sh"),
        ],
        &[
            ("agent-runs.json", records.as_bytes()),
            (transcript_path.as_str(), transcript.as_bytes()),
        ],
    );
    let base = t.base_url();
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let http = reqwest::Client::new();
        let token = reqwest::get(format!("{base}/api/term/token"))
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap()["token"]
            .as_str()
            .unwrap()
            .to_owned();
        let get = |path: String| {
            http.get(format!("{base}{path}"))
                .header(TOKEN_HEADER, &token)
                .send()
        };
        let post = |path: String, body: Value| {
            http.post(format!("{base}{path}"))
                .header(TOKEN_HEADER, &token)
                .json(&body)
                .send()
        };

        // restored, not restarted: stopped, with the transcript's history and nothing spawned
        let listed: Value = get("/api/agent/runs".into())
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(listed[0]["status"], "stopped");
        let snap: Value = get("/api/agent/runs/r1".into())
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let texts: Vec<&str> = snap["state"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|i| i["text"].as_str())
            .collect();
        assert_eq!(texts, ["fix the cart", "Fixed."]);
        assert!(!log.exists(), "nothing runs until the user resumes");

        // resuming restores its mode, and a second writer for the same conversation is refused
        assert_eq!(
            post("/api/agent/runs/r1/restart".into(), json!({}))
                .await
                .unwrap()
                .status(),
            200
        );
        let mut w = attach(
            &base,
            "r1",
            json!({"type":"attach","token":token,"role":"writer"}),
        )
        .await;
        let hello = until(&mut w, status("ready")).await;
        let epoch = hello.iter().find(|v| v["type"] == "snapshot").unwrap()["epoch"]
            .as_str()
            .unwrap()
            .to_owned();
        let argv = std::fs::read_to_string(&log).unwrap();
        assert!(
            argv.contains(&format!(r#""--resume", "{session}""#))
                && argv.contains(r#""--permission-mode", "plan""#),
            "{argv}"
        );
        let twice = post(
            "/api/agent/runs".into(),
            json!({"cwd":cwd,"resume":session}),
        )
        .await
        .unwrap();
        assert_eq!(twice.status(), 409);
        assert_eq!(twice.json::<Value>().await.unwrap()["run"], "r1");

        // a busy run stays; an idle one moves to a Trame shell running the same conversation
        command(&mut w, "h1", &epoch, "prompt", "hang").await;
        assert_eq!(
            post("/api/agent/runs/r1/handoff".into(), json!({}))
                .await
                .unwrap()
                .status(),
            409
        );
        send(&mut w, "h2", &epoch, "interrupt", json!({})).await;
        until(&mut w, kind("turn.finished")).await;
        let moved = post("/api/agent/runs/r1/handoff".into(), json!({}))
            .await
            .unwrap();
        assert_eq!(moved.status(), 200);
        let term = moved.json::<Value>().await.unwrap()["term"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_ne!(term, "");
        assert_eq!(
            get("/api/agent/runs/r1".into()).await.unwrap().status(),
            404
        );
        let saved: Value =
            serde_json::from_slice(&std::fs::read(t.root.join("agent-runs.json")).unwrap())
                .unwrap();
        assert_eq!(saved, json!([]));

        // a shell without Claude in it has nothing to hand over
        let none = post("/api/agent/handoff".into(), json!({"term":term}))
            .await
            .unwrap();
        assert_eq!(none.status(), 404);
    });
    let _ = std::fs::remove_file(&log);
}

#[test]
fn codex_runs_turns_approvals_questions_and_resumes_its_thread() {
    let fake = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fake-codex.py");
    let log = trame_local::workspace().join(format!(
        ".scratch/agent-codex-{}.log",
        uuid::Uuid::new_v4().simple()
    ));
    let t = TestDb::with_env(&[
        ("TRAME_CODEX_BIN", fake),
        ("FAKE_LOG", log.to_str().unwrap()),
    ]);
    let base = t.base_url();
    let cwd = t.root.to_str().unwrap().to_owned();
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let token = reqwest::get(format!("{base}/api/term/token"))
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap()["token"]
            .as_str()
            .unwrap()
            .to_owned();
        let bad = reqwest::Client::new()
            .post(format!("{base}/api/agent/runs"))
            .header(TOKEN_HEADER, &token)
            .json(&json!({"cwd":cwd,"provider":"codex","mode":"plan"}))
            .send()
            .await
            .unwrap();
        assert_eq!(bad.status(), 400, "Codex has no permission modes");
        let created: Value = reqwest::Client::new()
            .post(format!("{base}/api/agent/runs"))
            .header(TOKEN_HEADER, &token)
            .json(&json!({"cwd":cwd,"provider":"codex"}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let run = created["id"].as_str().unwrap().to_owned();
        assert_eq!(created["provider"], "codex");
        let mut w = attach(
            &base,
            &run,
            json!({"type":"attach","token":token,"role":"writer"}),
        )
        .await;
        let hello = until(&mut w, status("ready")).await;
        let epoch = hello.iter().find(|v| v["type"] == "snapshot").unwrap()["epoch"]
            .as_str()
            .unwrap()
            .to_owned();
        let thread =
            hello.iter().find(|v| v["kind"] == "run.info").unwrap()["payload"]["sessionId"]
                .as_str()
                .unwrap()
                .to_owned();
        assert_eq!(hello[1]["state"]["capabilities"]["modes"], false);

        command(&mut w, "c1", &epoch, "prompt", "hello").await;
        let turn = until(&mut w, kind("turn.finished")).await;
        assert!(turn.iter().any(|v| v["kind"] == "item.delta"));
        assert_eq!(assistant_texts(&turn), ["echo: hello"]);

        // a command approval, allowed: its output lands as a tool result
        let req = ask(&mut w, &epoch, "c2", "run", "permission").await;
        send(
            &mut w,
            "a1",
            &epoch,
            "answer",
            json!({"requestId":req,"decision":"allow"}),
        )
        .await;
        let turn = until(&mut w, kind("turn.finished")).await;
        let result = turn
            .iter()
            .find(|v| v["payload"]["kind"] == "result")
            .unwrap();
        assert_eq!(result["payload"]["text"], "PASS 14 tests");
        assert_eq!(assistant_texts(&turn), ["ran tests"]);

        // a file change shows its diff in the approval; declined
        command(&mut w, "c3", &epoch, "prompt", "edit").await;
        let asked = until(&mut w, kind("interaction.requested")).await;
        let p = &asked.last().unwrap()["payload"];
        assert_eq!(
            p["input"]["input"],
            "*** Update File: src/a.ts\n-old\n+new\n"
        );
        send(
            &mut w,
            "a2",
            &epoch,
            "answer",
            json!({"requestId":p["requestId"],"decision":"deny"}),
        )
        .await;
        assert_eq!(
            assistant_texts(&until(&mut w, kind("turn.finished")).await),
            ["declined decline"]
        );

        // questions are answered by their Codex ids
        let req = ask(&mut w, &epoch, "c4", "ask", "question").await;
        send(
            &mut w,
            "a3",
            &epoch,
            "answer",
            json!({"requestId":req,"decision":"answer","answers":{"Which db?":"pg"}}),
        )
        .await;
        assert_eq!(
            assistant_texts(&until(&mut w, kind("turn.finished")).await),
            [r#"answered {"q1": {"answers": ["pg"]}}"#]
        );

        // interrupt names the running turn; there are no modes to switch
        command(&mut w, "c5", &epoch, "prompt", "hang").await;
        until(&mut w, kind("turn.started")).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(
            send(&mut w, "i1", &epoch, "interrupt", json!({})).await["accepted"],
            true
        );
        assert_eq!(
            until(&mut w, kind("turn.finished")).await.last().unwrap()["payload"]["outcome"],
            "interrupted"
        );
        let r = send(&mut w, "m1", &epoch, "setMode", json!({"mode":"plan"})).await;
        assert_eq!(r["reason"], "Codex has no permission modes to switch");

        // models come from model/list (hidden ones left out); a pick applies from the next turn
        let snap: Value = reqwest::Client::new()
            .get(format!("{base}/api/agent/runs/{run}"))
            .header(TOKEN_HEADER, &token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(
            (
                snap["state"]["models"].as_array().unwrap().len(),
                snap["state"]["effort"].clone()
            ),
            (1, json!("low"))
        );
        assert_eq!(
            send(
                &mut w,
                "md1",
                &epoch,
                "setModel",
                json!({"model":"gpt-other"})
            )
            .await["accepted"],
            true
        );
        assert_eq!(
            send(&mut w, "e1", &epoch, "setEffort", json!({"effort":"high"})).await["accepted"],
            true
        );
        command(&mut w, "c6", &epoch, "prompt", "again").await;
        until(&mut w, kind("turn.finished")).await;

        // stopped and resumed: the same thread, through thread/resume
        send(&mut w, "s1", &epoch, "stop", json!({})).await;
        until(&mut w, status("stopped")).await;
        let restarted = reqwest::Client::new()
            .post(format!("{base}/api/agent/runs/{run}/restart"))
            .header(TOKEN_HEADER, &token)
            .send()
            .await
            .unwrap();
        assert_eq!(restarted.status(), 200);
        until(&mut w, status("ready")).await;
        let calls: Vec<Value> = std::fs::read_to_string(&log)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        let resumed = calls
            .iter()
            .find(|c| c["method"] == "thread/resume")
            .unwrap();
        assert_eq!(resumed["params"]["threadId"], thread);
        let last_turn = calls
            .iter()
            .rev()
            .find(|c| c["method"] == "turn/start")
            .unwrap();
        assert_eq!(
            (
                last_turn["params"]["model"].clone(),
                last_turn["params"]["effort"].clone()
            ),
            (json!("gpt-other"), json!("high"))
        );
        let interrupt = calls
            .iter()
            .find(|c| c["method"] == "turn/interrupt")
            .unwrap();
        assert_eq!(interrupt["params"]["turnId"], "turn-5");
    });
    let _ = std::fs::remove_file(&log);
}
