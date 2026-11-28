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

/// Send a command and return the server's reply to it.
async fn command(ws: &mut Ws, id: &str, epoch: &str, kind: &str, text: &str) -> Value {
    let cmd =
        json!({"type":"command","commandId":id,"epoch":epoch,"kind":kind,"payload":{"text":text}});
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
fn agent_view_is_off_without_the_development_flag() {
    let t = TestDb::new();
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
        ("TRAME_AGENT_VIEW", "1"),
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

        // a blocking request the view can't answer yet is denied, not left hanging
        command(&mut w, "c3", &epoch, "prompt", "write").await;
        let turn = until(&mut w, kind("turn.finished")).await;
        let denied = turn.iter().find(|v| v["kind"] == "interaction.denied").unwrap();
        assert_eq!(denied["payload"]["tool"], "Write");
        assert_eq!(assistant_texts(&turn), ["tool deny"]);

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
