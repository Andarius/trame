use std::{
    future::Future,
    net::SocketAddr,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use super::{api::Api, *};
use crate::agent::{
    bots,
    connector::{self, Connector, Timing, http, protocol::Hello},
    runner::{self, Failure, Local, Offered, Transport},
};
use axum::{
    Json, Router,
    extract::{
        Path as RoutePath, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    routing::{get, post},
};
use tokio::{sync::mpsc, task::JoinHandle};

const MESSAGE: &str = "1700000000.000001";

/// Run `exercise` in a child test process with fake Claude: runs live in a process-wide registry.
fn in_child<F: Future<Output = ()>>(name: &str, exercise: impl FnOnce(PathBuf) -> F) {
    const TEST_ROOT: &str = "TRAME_SLACK_E2E_ROOT";
    if let Some(dir) = env::var_os(TEST_ROOT) {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            tokio::time::timeout(Duration::from_secs(30), exercise(PathBuf::from(dir)))
                .await
                .unwrap();
        });
        return;
    }
    let root = env::temp_dir().join(format!("trame-slack-e2e-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let status = std::process::Command::new(env::current_exe().unwrap())
        .args([
            "--exact",
            &format!("agent::slack::e2e::{name}"),
            "--nocapture",
        ])
        .env(TEST_ROOT, &root)
        .env("TRAME_AGENT_VIEW", "1")
        .env(
            "TRAME_CLAUDE_BIN",
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fake-claude.py"),
        )
        .env("FAKE_LOG", root.join("started"))
        .status();
    std::fs::remove_dir_all(root).unwrap();
    assert!(status.unwrap().success());
}

struct FakeSlack {
    addr: SocketAddr,
    socket: WebSocket,
    posted: mpsc::Receiver<Value>,
    server: JoinHandle<()>,
}

impl FakeSlack {
    async fn envelope(&mut self, id: &str, kind: &str, payload: Value) {
        let frame = json!({"envelope_id":id,"type":kind,"payload":payload});
        self.socket
            .send(Message::Text(frame.to_string().into()))
            .await
            .unwrap();
        let ack = self
            .socket
            .recv()
            .await
            .unwrap()
            .unwrap()
            .into_text()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&ack).unwrap()["envelope_id"],
            id
        );
    }

    async fn mention(&mut self, event: &str, text: &str) {
        let mention = json!({"type":"event_callback","team_id":"T1","event_id":event,
            "event_time":SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs(),
            "event":{"type":"app_mention","channel":"C1","user":"U1","text":format!("<@U2> {text}"),"ts":"1700000000.000000"}});
        self.envelope(event, "events_api", mention).await;
    }

    async fn click(&mut self, id: &str, card: &Value) {
        let button = &card["blocks"][2]["elements"][0];
        let action = json!({"type":"block_actions","team":{"id":"T1"},"user":{"id":"U1"},"channel":{"id":"C1"},
            "container":{"type":"message","channel_id":"C1","message_ts":MESSAGE},
            "message":{"bot_id":"B1","ts":MESSAGE},"actions":[button]});
        self.envelope(id, "interactive", action).await;
    }

    /// The first post whose text is `text`, skipping the others.
    async fn posted(&mut self, text: &str) -> Value {
        loop {
            let msg = self.posted.recv().await.unwrap();
            if msg["text"] == text {
                return msg;
            }
        }
    }
}

/// Serve a fake Slack and hold its Slack app on `connector` until the socket opens.
async fn fake_slack(connector: Arc<Connector>) -> (FakeSlack, JoinHandle<()>) {
    let tcp = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = tcp.local_addr().unwrap();
    let (connections, mut incoming) = mpsc::channel(1);
    let (posts, posted) = mpsc::channel::<Value>(16);
    let app = Router::new()
        .route(
            "/socket",
            get(move |ws: WebSocketUpgrade| async move {
                ws.on_upgrade(move |socket| async move {
                    let _ = connections.send(socket).await;
                })
            }),
        )
        .route(
            "/api/{method}",
            post(
                move |RoutePath(method): RoutePath<String>, Json(body): Json<Value>| {
                    let posts = posts.clone();
                    async move {
                        Json(match method.as_str() {
                            "auth.test" => {
                                json!({"ok":true,"user_id":"U2","bot_id":"B1","team_id":"T1"})
                            }
                            "apps.connections.open" => {
                                json!({"ok":true,"url":format!("ws://{addr}/socket")})
                            }
                            "chat.postMessage" | "chat.update" => {
                                posts.send(body).await.unwrap();
                                json!({"ok":true,"channel":"C1","ts":MESSAGE})
                            }
                            _ => panic!("unexpected method {method}"),
                        })
                    }
                },
            ),
        );
    let server = tokio::spawn(async move {
        axum::serve(tcp, app).await.unwrap();
    });
    let config = Arc::new(Config {
        app_token: "fixture".into(),
        bot_token: "fixture".into(),
        team: "T1".into(),
        channel: "C1".into(),
        user: "U1".into(),
    });
    let api = Arc::new(Api::new(config.clone()).unwrap().with_test_endpoint(addr));
    let slack = tokio::spawn(connector::hold_slack(
        api,
        config,
        connector,
        Ledger::memory(),
    ));
    let socket = incoming.recv().await.unwrap();
    let fake = FakeSlack {
        addr,
        socket,
        posted,
        server,
    };
    (fake, slack)
}

fn bot(name: &str, cwd: &Path) -> bots::Bot {
    bots::Bot {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.into(),
        provider: crate::agent::run::Provider::Claude,
        cwd: Some(cwd.to_owned()),
        mode: Some("auto".into()),
        model: None,
        effort: None,
        slack: true,
        hook: "0".repeat(32),
        role: None,
        face: None,
        hue: None,
        has_image: false,
    }
}

fn offering(bot: bots::Bot) -> Offered {
    Arc::new(move || vec![bot.clone()])
}

fn started(root: &Path) -> usize {
    std::fs::read_to_string(root.join("started"))
        .unwrap_or_default()
        .lines()
        .count()
}

async fn until(mut ready: impl FnMut() -> bool) {
    while !ready() {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[test]
fn slack_mention_and_stop_drive_one_child() {
    in_child(
        "slack_mention_and_stop_drive_one_child",
        |root| async move {
            let connector = Arc::new(Connector::new(Timing::default()));
            let (mut slack, holder) = fake_slack(connector.clone()).await;
            let runner = tokio::spawn(runner::serve(
                Arc::new(Local::new(connector.clone(), "Workshop".into())),
                "Workshop".into(),
                offering(bot("fixture", &root)),
                (slack.addr.port(), root.clone()),
                runner::RETRY,
            ));
            until(|| !connector.inventory().is_empty()).await;
            slack.mention("Ev1", "hang").await;
            slack.mention("Ev1", "hang").await;
            let card = slack.posted("fixture is working").await;
            assert!(card.to_string().contains("fixture on Workshop"));
            slack.click("clicked", &card).await;
            let stopped = slack.posted("fixture stopped").await;
            assert_eq!(stopped["ts"], MESSAGE);
            assert_eq!(stopped["blocks"].as_array().unwrap().len(), 2);
            assert_eq!(started(&root), 1);
            for task in [holder, runner, slack.server] {
                task.abort();
            }
            crate::agent::shutdown();
        },
    );
}

/// The in-process transport, losing the first acks call and recording every polled delivery id.
struct LossyLocal {
    local: Local,
    lost: std::sync::atomic::AtomicBool,
    polled: Arc<Mutex<Vec<String>>>,
}

impl Transport for LossyLocal {
    async fn hello(&self, hello: &Hello) -> Result<(), Failure> {
        self.local.hello(hello).await
    }

    async fn poll(&self, rev: &str) -> Result<Vec<connector::protocol::Delivery>, Failure> {
        let deliveries = self.local.poll(rev).await?;
        let mut polled = self.polled.lock().unwrap();
        polled.extend(deliveries.iter().map(|d| d.id.clone()));
        Ok(deliveries)
    }

    async fn acks(&self, acks: &[connector::protocol::Ack]) -> Result<(), Failure> {
        if self.lost.swap(true, std::sync::atomic::Ordering::SeqCst) {
            self.local.acks(acks).await
        } else {
            Ok(())
        }
    }

    async fn events(&self, events: &[connector::protocol::Event]) -> Result<(), Failure> {
        self.local.events(events).await
    }
}

#[test]
fn one_connector_drives_two_machines() {
    in_child("one_connector_drives_two_machines", |root| async move {
        let connector = Arc::new(Connector::new(Timing {
            lease: Duration::from_millis(300),
            offline: Duration::from_millis(200),
            hold: Duration::from_millis(500),
            ..Timing::default()
        }));
        let (mut slack, holder) = fake_slack(connector.clone()).await;
        let port = slack.addr.port();
        let polled = Arc::new(Mutex::new(Vec::new()));
        let m1 = tokio::spawn(runner::serve(
            Arc::new(LossyLocal {
                local: Local::new(connector.clone(), "m1".into()),
                lost: false.into(),
                polled: polled.clone(),
            }),
            "m1".into(),
            offering(bot("alpha", &root)),
            (port, root.clone()),
            Duration::from_millis(50),
        ));
        // m2 said hello once and has not polled since
        let hello = Hello {
            version: connector::protocol::VERSION,
            machine: "m2".into(),
            bots: vec!["beta".into()],
            rev: "old".into(),
        };
        connector.hello("m2", hello).unwrap();
        until(|| connector.inventory().len() == 2).await;

        slack.mention("Ev1", "gamma: hi").await;
        let reply = slack.posted.recv().await.unwrap();
        assert!(reply["text"].as_str().unwrap().contains("alpha, beta"));

        // alpha runs on m1 once, though its first ack was lost and the start came back
        slack.mention("Ev2", "alpha: hang").await;
        let card = slack.posted("alpha is working").await;
        assert!(card.to_string().contains("alpha on m1"));
        until(|| polled.lock().unwrap().len() >= 2).await;
        let start = {
            let polled = polled.lock().unwrap();
            assert_eq!(polled[0], polled[1], "redelivered under the same id");
            polled[0].clone()
        };
        assert_eq!(started(&root), 1);

        slack.click("clicked", &card).await;
        let stopped = slack.posted("alpha stopped").await;
        let link = stopped["blocks"][1]["elements"][0]["text"]
            .as_str()
            .unwrap();
        let run = link
            .split("/open-agent/")
            .nth(1)
            .and_then(|rest| rest.split('|').next())
            .unwrap()
            .to_owned();

        // a Stop for a finished turn is refused by the connector and by the runner
        assert_eq!(connector.stop(&start).unwrap_err(), "this run is over");
        let epoch = crate::agent::get(&run).unwrap().snapshot()["epoch"]
            .as_str()
            .unwrap()
            .to_owned();
        let refused = connector.stop_turn("m1", run, epoch, 1).await.unwrap();
        assert_eq!(refused.as_deref(), Some("this turn is no longer running"));

        // beta waits for m2, then runs once m2 polls over HTTP
        slack.mention("Ev3", "beta: hello").await;
        let waiting = slack.posted.recv().await.unwrap();
        assert_eq!(waiting["text"], "beta is waiting for m2");
        let tcp = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", tcp.local_addr().unwrap());
        let tokens = http::server::Tokens::from([("token-m2".to_owned(), "m2".to_owned())]);
        let server = tokio::spawn(async move {
            axum::serve(tcp, http::server::router(connector, tokens))
                .await
                .unwrap();
        });
        let client = reqwest::Client::new();
        for (token, status) in [("wrong", 401), ("token-m2", 409)] {
            let response = client
                .post(format!("{url}v1/connector/poll"))
                .bearer_auth(token)
                .json(&json!({"rev":"stale"}))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), status, "{token}");
        }
        let m2 = tokio::spawn(runner::serve(
            Arc::new(http::Remote::new(&url, "token-m2".into()).unwrap()),
            "m2".into(),
            offering(bot("beta", &root)),
            (port, root.clone()),
            Duration::from_millis(50),
        ));
        let finished = slack.posted("beta finished").await;
        assert!(finished.to_string().contains("beta on m2"));
        assert_eq!(started(&root), 2);
        for task in [holder, m1, m2, server, slack.server] {
            task.abort();
        }
        crate::agent::shutdown();
    });
}
