mod common;
use common::TestDb;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::Duration;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, protocol::frame::coding::CloseCode},
};
use trame_local::pty::{CLOSE_AUTH, CLOSE_SUPERSEDED, TOKEN_HEADER};

const CARD: &str = "12345678-1234-4234-8234-123456789abc";

type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

struct Frames {
    output: Vec<u8>,
    control: Vec<Value>,
    close: Option<u16>,
}

/// Read until `done` holds or the socket closes; output, control frames and the close code.
async fn read_until(ws: &mut Ws, done: impl Fn(&Frames) -> bool) -> Frames {
    let mut frames = Frames {
        output: Vec::new(),
        control: Vec::new(),
        close: None,
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while !done(&frames) {
        let next = tokio::time::timeout_at(deadline, ws.next()).await;
        match next.expect("timed out waiting for terminal frames") {
            Some(Ok(Message::Binary(b))) => frames.output.extend_from_slice(&b),
            Some(Ok(Message::Text(t))) => frames.control.push(serde_json::from_str(&t).unwrap()),
            Some(Ok(Message::Close(frame))) => {
                frames.close = frame.map(|f| u16::from(f.code));
                break;
            }
            Some(Ok(_)) => {}
            Some(Err(_)) | None => break,
        }
    }
    frames
}

fn has(frames: &Frames, needle: &str) -> bool {
    String::from_utf8_lossy(&frames.output).contains(needle)
}

async fn attach(base: &str, id: &str, token: &str, from: Option<u64>) -> Ws {
    let url = format!("{}/api/term/{id}/ws", base.replacen("http", "ws", 1));
    let (mut ws, _) = connect_async(url).await.unwrap();
    let auth = json!({"type":"auth","token":token,"from":from,"cols":100,"rows":30});
    ws.send(Message::Text(auth.to_string().into()))
        .await
        .unwrap();
    ws
}

#[test]
fn terminal_requires_token_and_streams_reattaches_and_closes() {
    // the server inherits an agent host's env, which its shells must not
    let t = TestDb::with_env(&[
        ("SHELL", "/bin/sh"),
        ("CLAUDECODE", "1"),
        ("ANTHROPIC_BASE_URL", "http://127.0.0.1:9"),
        ("CODEX_THREAD_ID", "x"),
    ]);
    let base = t.base_url();
    let cwd = t.root.to_str().unwrap().to_owned();
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let client = reqwest::Client::new();
        let token = client
            .get(format!("{base}/api/term/token"))
            .send()
            .await
            .unwrap();
        assert_eq!(token.headers()["cache-control"], "no-store");
        let token = token.json::<Value>().await.unwrap()["token"]
            .as_str()
            .unwrap()
            .to_owned();

        // the token endpoint is not readable from another local origin
        let cross = client
            .get(format!("{base}/api/term/token"))
            .header("sec-fetch-site", "same-site")
            .header("origin", "http://localhost:3000")
            .send()
            .await
            .unwrap();
        assert_eq!(cross.status(), 403);

        for (header, body, status) in [
            (None, json!({"cwd":cwd}), 401),
            (Some("wrong"), json!({"cwd":cwd}), 401),
            (Some(token.as_str()), json!({"cwd":"relative/dir"}), 400),
            (
                Some(token.as_str()),
                json!({"cwd":"/nonexistent-trame-test/missing"}),
                400,
            ),
            (Some(token.as_str()), json!({"cwd":cwd,"card":"not-a-card"}), 400),
            (Some(token.as_str()), json!({"cwd":cwd,"card":7}), 400),
        ] {
            let mut req = client.post(format!("{base}/api/term")).json(&body);
            if let Some(h) = header {
                req = req.header(TOKEN_HEADER, h);
            }
            assert_eq!(
                req.send().await.unwrap().status(),
                status,
                "{header:?} {body}"
            );
        }

        let created: Value = client
            .post(format!("{base}/api/term"))
            .header(TOKEN_HEADER, &token)
            .json(&json!({"cwd":cwd,"command":"printf 'ready-%s%s%s%s\\n' $((40+2)) \"$CLAUDECODE\" \"$ANTHROPIC_BASE_URL\" \"$CODEX_THREAD_ID\"","title":"probe","card":CARD}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let id = created["id"].as_str().unwrap().to_owned();
        assert_eq!(created["title"], "probe");
        assert_eq!(created["card"], CARD);

        let mut bad = attach(&base, &id, "wrong", None).await;
        assert_eq!(
            read_until(&mut bad, |_| false).await.close,
            Some(CLOSE_AUTH)
        );

        // the command runs, then the shell stays for input
        let mut first = attach(&base, &id, &token, None).await;
        let frames = read_until(&mut first, |f| has(f, "ready-42\r\n")).await;
        assert_eq!(frames.control[0]["type"], "attach");
        assert_eq!(frames.control[0]["reset"], true);
        first
            .send(Message::Binary(b"echo typed-$((6*7))\n".to_vec().into()))
            .await
            .unwrap();
        assert!(has(
            &read_until(&mut first, |f| has(f, "typed-42")).await,
            "typed-42"
        ));

        let listed: Value = client
            .get(format!("{base}/api/term"))
            .header(TOKEN_HEADER, &token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(listed[0]["id"], id.as_str());
        assert_eq!(listed[0]["exited"], false);
        assert_eq!(listed[0]["card"], CARD);

        // a second attachment from offset 0 replays everything and supersedes the first
        let mut second = attach(&base, &id, &token, Some(0)).await;
        let replay = read_until(&mut second, |f| has(f, "typed-42")).await;
        assert!(has(&replay, "ready-42"));
        assert_eq!(replay.control[0]["reset"], false);
        assert_eq!(
            read_until(&mut first, |_| false).await.close,
            Some(CLOSE_SUPERSEDED)
        );

        let killed = client
            .delete(format!("{base}/api/term/{id}"))
            .header(TOKEN_HEADER, &token)
            .send()
            .await
            .unwrap();
        assert_eq!(killed.status(), 200);
        let end = read_until(&mut second, |_| false).await;
        assert!(end.control.iter().any(|c| c["type"] == "exit"));
        assert_eq!(end.close, Some(u16::from(CloseCode::Normal)));
        let again = client
            .delete(format!("{base}/api/term/{id}"))
            .header(TOKEN_HEADER, &token)
            .send()
            .await
            .unwrap();
        assert_eq!(again.status(), 404);
    });
}
