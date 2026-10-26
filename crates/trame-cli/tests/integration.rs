#![allow(unsafe_code, reason = "tests mutate env vars / probe pids via libc")]

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{HeaderMap, Request, StatusCode, header},
    routing::any,
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    process::Command,
    time::timeout,
};
use trame_cli::{
    comment, page,
    target::{Target, resolve_target},
};

#[derive(Clone, Debug)]
struct Hit {
    method: String,
    path: String,
    query: String,
    headers: HeaderMap,
    body: Value,
}
#[derive(Default)]
struct State {
    hits: Vec<Hit>,
    inbox_polls: usize,
    comment_polls: usize,
    page_writer: bool,
    page_tree: bool,
    watch_quiet: bool,
    comments_fail_once: bool,
    comments_invalid_once: bool,
    sessions_status: Option<StatusCode>,
    sessions_invalid_json: bool,
    sessions_error_body: Option<String>,
    specs_page_missing_id: bool,
    redirect_to: Option<String>,
    card_faces: bool,
}
async fn fixture(
    request: Request<Body>,
    state: Arc<Mutex<State>>,
) -> (StatusCode, HeaderMap, Body) {
    let method = request.method().as_str().to_owned();
    let path = request.uri().path().to_owned();
    let query = request.uri().query().unwrap_or("").to_owned();
    let request_headers = request.headers().clone();
    let bytes = to_bytes(request.into_body(), 1024 * 1024)
        .await
        .unwrap_or_default();
    let body = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
    let mut state = state.lock().unwrap();
    state.hits.push(Hit {
        method: method.clone(),
        path: path.clone(),
        query: query.clone(),
        headers: request_headers,
        body: body.clone(),
    });
    let value = match (method.as_str(), path.as_str()) {
        ("GET", "/api/status") => json!({"version":env!("CARGO_PKG_VERSION"),"ok":true}),
        ("GET", "/api/pages") if state.page_tree => json!([
            {"id":"p1","parent_id":null,"title":"Plan: tramecli"},
            {"id":"p2","parent_id":"p1","title":"Specs"},
            {"id":"p3","parent_id":null,"title":"Unrelated"}
        ]),
        ("GET", "/api/pages") => json!([
            {"id":"page1","title":"Release plan","parent_id":null},
            {"id":"parent","title":"Project","parent_id":null}
        ]),
        ("GET", "/api/pages/page1") if state.page_writer => {
            json!({"id":"page1","title":"Release plan","content":[
                {"id":"keep0001","type":"heading","text":"Checklist"},
                {"id":"html0001","type":"html","html":"<b>picker</b>"},
                {"id":"old00002","type":"text","text":"Old paragraph."}
            ]})
        }
        ("GET", "/api/pages/page1") => json!({"id":"page1","title":"Release plan","content":[
            {"id":"keep0001","type":"text","text":"Keep this."},
            {"id":"old00002","type":"text","text":"Old paragraph."}
        ]}),
        ("POST", "/api/pages/page1") => json!({"ok":true}),
        ("POST", "/api/comments") => json!({"id":"comment-1"}),
        ("POST", p) if p.starts_with("/api/comments/") => json!({"ok":true}),
        ("POST", "/api/sessions") => {
            json!({"id":"session-1","specs_page_id":"spec-1","note":"keep specs","story_note":"matched"})
        }
        ("POST", "/api/sessions/session-1/specs-page") if state.specs_page_missing_id => json!({}),
        ("POST", "/api/sessions/session-1/specs-page") => json!({"page_id":"page1"}),
        ("GET", "/api/board") => {
            json!({"sessions":[],"stories":[],"statuses":[],"pages":[],"projects":[]})
        }
        ("GET", "/api/plugins") => json!([
            {"id":"deployments","enabled":true},
            {"id":"cockpit","enabled":state.card_faces,"cardFaces":"/assigners"},
            {"id":"off","enabled":false,"cardFaces":"/faces"}
        ]),
        ("GET", "/api/plugins/cockpit/assigners") => {
            json!({"s1":{"name":"Carlo Rossi","avatar":null}})
        }
        ("GET", "/api/stories/similar") => json!([]),
        ("POST", "/api/presence") => json!({"ok":true}),
        ("GET", "/api/comments/inbox") => {
            state.inbox_polls += 1;
            if query.contains("mode=all") && state.inbox_polls < 2 && !state.watch_quiet {
                json!([])
            } else {
                json!([{"comment":{"id":"comment-1","body":"Why?","updated_at":"2025-01-01T00:00:00Z"},
                    "page":{"id":"page1","title":"Release plan"},"block":{"id":"keep0001","text":"Keep this."},
                    "agent":"codex","thread":[]}])
            }
        }
        ("GET", "/api/comments") => {
            state.comment_polls += 1;
            if state.comments_invalid_once && state.comment_polls == 1 {
                return (StatusCode::OK, HeaderMap::new(), Body::from("{}"));
            }
            let at = if state.watch_quiet && state.comment_polls <= 2 {
                chrono::Utc::now().to_rfc3339()
            } else {
                "2025-01-01T00:00:00Z".into()
            };
            json!([{"id":"comment-1","author_id":"human","updated_at":at,"body":"Why?"}])
        }
        _ => json!({"error":"missing fixture"}),
    };
    let mut headers = HeaderMap::new();
    let status =
        if let (true, Some(redirect)) = (path == "/api/sessions", state.redirect_to.as_ref()) {
            headers.insert(header::LOCATION, redirect.parse().unwrap());
            StatusCode::TEMPORARY_REDIRECT
        } else if path == "/api/comments"
            && method == "GET"
            && state.comments_fail_once
            && state.comment_polls == 1
        {
            StatusCode::SERVICE_UNAVAILABLE
        } else if path == "/api/sessions" {
            state.sessions_status.unwrap_or(StatusCode::OK)
        } else {
            StatusCode::OK
        };
    let body = if path == "/api/sessions" && state.sessions_invalid_json {
        Body::from("not-json")
    } else if path == "/api/sessions"
        && status != StatusCode::OK
        && state.sessions_error_body.is_some()
    {
        Body::from(
            state
                .sessions_error_body
                .as_deref()
                .unwrap_or_default()
                .to_owned(),
        )
    } else {
        Body::from(value.to_string())
    };
    (status, headers, body)
}
async fn server() -> (String, Arc<Mutex<State>>, tokio::task::JoinHandle<()>) {
    let state = Arc::new(Mutex::new(State::default()));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let fixture_state = state.clone();
    let app = Router::new().fallback(any(move |request| fixture(request, fixture_state.clone())));
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://127.0.0.1:{}", address.port()), state, task)
}
struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("cli-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("settings.json"), "{}").unwrap();
        Self(root)
    }
    fn command(&self, port: Option<u16>) -> Command {
        if let Some(port) = port {
            std::fs::write(self.0.join("port.json"), json!({"port":port}).to_string()).unwrap();
        }
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_tramecli"));
        cmd.env("HOME", &self.0)
            .env("XDG_DATA_HOME", &self.0)
            .env("TRAME_LOCAL_DIR", &self.0)
            .env("TRACKER_PORT_FILE", self.0.join("port.json"))
            .env("TRACKER_SETTINGS_FILE", self.0.join("settings.json"))
            .env("TRACKER_OUTBOX", self.0.join("outbox.jsonl"))
            .env("TRACKER_HUB_API", "")
            .env("TRACKER_HUB_API_TOKEN", "")
            .env_remove("TRAME_OFFLINE")
            .env_remove("CODEX_THREAD_ID")
            .env_remove("CLAUDE_CODE_SESSION_ID");
        cmd
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn page_update_keeps_ids_and_posts_only_changed_content() {
    let (base, state, server) = server().await;
    state.lock().unwrap().page_writer = true;
    let port = base.rsplit(':').next().unwrap().parse().unwrap();
    let target = Target::local(base);
    let result = page::write_page(
        &json!({"page_title":"Release plan","markdown":"## Checklist\n\nNew paragraph."}),
        &target,
    )
    .await
    .unwrap();
    assert_eq!(result["action"], "updated");
    assert_eq!(result["kept"], 1);
    assert_eq!(result["total"], 2);
    {
        let state = state.lock().unwrap();
        let post = state
            .hits
            .iter()
            .find(|h| h.method == "POST" && h.path == "/api/pages/page1")
            .unwrap();
        assert_eq!(
            post.body.as_object().unwrap().keys().collect::<Vec<_>>(),
            vec!["content"]
        );
        assert_eq!(post.body["content"][0]["id"], "keep0001");
        assert_eq!(post.body["content"][0]["text"], "Checklist");
        assert_eq!(
            post.body["content"][1],
            json!({"id":"html0001","type":"html","html":"<b>picker</b>"})
        );
        assert_eq!(post.body["content"][2]["text"], "New paragraph.");
        assert!(uuid::Uuid::parse_str(post.body["content"][2]["id"].as_str().unwrap()).is_ok());
    }
    let scratch = Scratch::new();
    let input = json!({"page_title":"Release plan","markdown":"## Checklist\n\nNew paragraph."})
        .to_string();
    let output = scratch
        .command(Some(port))
        .args(["page", &input])
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("page page1 updated"));
    assert!(stdout.contains("kept 1 of 2 block ids"));
    server.abort();
}
#[tokio::test]
async fn comment_writer_resolves_title_quote_and_brackets_reply() {
    let (base, state, server) = server().await;
    let target = Target::local(base);
    let result = comment::add_comment(
        &json!({"page_title":"Release plan","block_text":"Keep this.","body":"  Please revise.  ",
        "agent":"codex","meta":{"model":"gpt-5.6-sol","in":10,"out":20,"ms":300},
        "in_reply_to":"human-1"}),
        &target,
    )
    .await
    .unwrap();
    assert_eq!(result["id"], "comment-1");
    let state = state.lock().unwrap();
    let calls = state
        .hits
        .iter()
        .filter(|h| h.method == "POST")
        .collect::<Vec<_>>();
    assert_eq!(
        calls.iter().map(|h| h.path.as_str()).collect::<Vec<_>>(),
        vec![
            "/api/comments/human-1/agent-status",
            "/api/comments",
            "/api/comments/human-1/agent-status"
        ]
    );
    assert_eq!(calls[0].body["status"], "answering");
    assert_eq!(
        calls[1].body,
        json!({"page_id":"page1","block_id":"keep0001","anchor":"Keep this.",
        "body":"Please revise.","agent":"codex","meta":{"model":"gpt-5.6-sol","in":10,"out":20,"ms":300}})
    );
    assert_eq!(calls[2].body["status"], "answered");
    server.abort();
}
#[tokio::test]
async fn comment_cli_detects_codex_session_from_environment() {
    let (base, state, server) = server().await;
    let port = base.rsplit(':').next().unwrap().parse().unwrap();
    let scratch = Scratch::new();
    let output = scratch.command(Some(port)).env("CODEX_THREAD_ID", "00000000-0000-4000-8000-000000000001")
        .args(["comment", r#"{"page_title":"Release plan","block_text":"Keep this.","body":"Clarify rollback.","meta":{"model":"gpt-5.6-sol","in":12894,"out":512,"ms":8300}}"#])
        .output().await.unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("comment-1"));
    let state = state.lock().unwrap();
    let post = state
        .hits
        .iter()
        .find(|h| h.method == "POST" && h.path == "/api/comments")
        .unwrap();
    assert_eq!(
        post.body,
        json!({"page_id":"page1","block_id":"keep0001","anchor":"Keep this.","body":"Clarify rollback.","agent":"codex","meta":{"model":"gpt-5.6-sol","in":12894,"out":512,"ms":8300}})
    );
    server.abort();
}
#[tokio::test]
async fn cli_track_uses_port_file_and_outbox_on_failure() {
    let (base, state, server) = server().await;
    let port = base.rsplit(':').next().unwrap().parse().unwrap();
    let scratch = Scratch::new();
    let output = scratch
        .command(Some(port))
        .args([
            "track",
            "--json",
            r#"{"title":"Ship","story":"Release","summary":"Done"}"#,
        ])
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["id"], "session-1");
    assert_eq!(response["specs_page_id"], "spec-1");
    assert!(
        state
            .lock()
            .unwrap()
            .hits
            .iter()
            .any(|h| h.method == "POST" && h.path == "/api/sessions" && h.body["title"] == "Ship")
    );
    server.abort();
    std::fs::remove_file(scratch.0.join("port.json")).unwrap();
    let queued = scratch
        .command(None)
        .args(["track", "--json", r#"{"title":"Offline","story":"Later"}"#])
        .output()
        .await
        .unwrap();
    assert!(queued.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&queued.stdout).unwrap()["queued"],
        true
    );
    let line = std::fs::read_to_string(scratch.0.join("outbox.jsonl")).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(line.trim()).unwrap()["title"],
        "Offline"
    );
}
#[tokio::test]
async fn track_hub_accepts_rejects_and_queues_only_network_failures() {
    for (mode, status, queued, success) in [
        ("accept", Some(StatusCode::OK), false, true),
        ("reject", Some(StatusCode::FORBIDDEN), false, false),
        ("unreachable", None, true, true),
        ("no hub", None, true, true),
    ] {
        let scratch = Scratch::new();
        let mut live = None;
        let url = if status.is_some() {
            let (base, state, server) = self::server().await;
            state.lock().unwrap().sessions_status = status;
            live = Some(server);
            base
        } else {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            drop(listener);
            format!("http://127.0.0.1:{port}")
        };
        if mode != "no hub" {
            std::fs::write(
                scratch.0.join("settings.json"),
                json!({"hubApi":url,"hubApiToken":"test"}).to_string(),
            )
            .unwrap();
        }
        let output = scratch
            .command(None)
            .args(["track", "--json", r#"{"title":"card","repo_path":"/r"}"#])
            .output()
            .await
            .unwrap();
        assert_eq!(
            output.status.success(),
            success,
            "{mode}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        if mode == "reject" {
            assert!(String::from_utf8_lossy(&output.stderr).contains("the hub rejected the track"));
        }
        let outbox = std::fs::read_to_string(scratch.0.join("outbox.jsonl")).unwrap_or_default();
        assert_eq!(!outbox.is_empty(), queued, "{mode}");
        if queued {
            assert_eq!(
                serde_json::from_str::<Value>(outbox.trim()).unwrap()["title"],
                "card"
            );
            assert!(scratch.0.join("outbox.jsonl.lock").exists());
        }
        if let Some(server) = live {
            server.abort();
        }
    }
}
#[tokio::test]
async fn accepted_track_with_invalid_json_is_not_replayed() {
    let (base, state, server) = self::server().await;
    state.lock().unwrap().sessions_invalid_json = true;
    let port = base.rsplit(':').next().unwrap().parse().unwrap();
    let scratch = Scratch::new();
    let output = scratch
        .command(Some(port))
        .args([
            "track",
            "--json",
            r#"{"title":"accepted","story":"Release"}"#,
        ])
        .output()
        .await
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("invalid JSON"));
    assert!(!scratch.0.join("outbox.jsonl").exists());
    assert_eq!(
        state
            .lock()
            .unwrap()
            .hits
            .iter()
            .filter(|h| h.path == "/api/sessions" && h.method == "POST")
            .count(),
        1
    );
    server.abort();
}
#[tokio::test]
async fn hub_rejection_body_cannot_masquerade_as_transport_failure() {
    let (base, state, server) = self::server().await;
    {
        let mut state = state.lock().unwrap();
        state.sessions_status = Some(StatusCode::FORBIDDEN);
        state.sessions_error_body = Some("is not reachable".into());
    }
    let scratch = Scratch::new();
    std::fs::write(
        scratch.0.join("settings.json"),
        json!({"hubApi":base,"hubApiToken":"test"}).to_string(),
    )
    .unwrap();
    let output = scratch
        .command(None)
        .args(["track", "--json", r#"{"title":"rejected"}"#])
        .output()
        .await
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("hub rejected"));
    assert!(!scratch.0.join("outbox.jsonl").exists());
    server.abort();
}
#[tokio::test]
async fn hub_settings_token_is_trimmed_before_authentication() {
    let (base, state, server) = self::server().await;
    let scratch = Scratch::new();
    std::fs::write(
        scratch.0.join("settings.json"),
        json!({"hubApi":base,"hubApiToken":"  test-token  "}).to_string(),
    )
    .unwrap();
    let output = scratch
        .command(None)
        .args(["track", "--json", r#"{"title":"card","story":"Release"}"#])
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let state = state.lock().unwrap();
    let post = state
        .hits
        .iter()
        .find(|h| h.path == "/api/sessions" && h.method == "POST")
        .unwrap();
    assert_eq!(
        post.headers.get("authorization").unwrap(),
        "Bearer test-token"
    );
    assert_eq!(post.headers.get("x-trame-protocol").unwrap(), "8");
    server.abort();
}
#[tokio::test]
async fn empty_codex_env_does_not_suppress_claude_attribution() {
    let (base, state, server) = self::server().await;
    let port = base.rsplit(':').next().unwrap().parse().unwrap();
    let scratch = Scratch::new();
    let output = scratch
        .command(Some(port))
        .env("CODEX_THREAD_ID", "")
        .env("CLAUDE_CODE_SESSION_ID", "claude-session")
        .args(["track", "--json", r#"{"title":"card","story":"Release"}"#])
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let state = state.lock().unwrap();
    let post = state
        .hits
        .iter()
        .find(|h| h.path == "/api/sessions" && h.method == "POST")
        .unwrap();
    assert_eq!(post.body["agent"], "claude");
    assert_eq!(post.body["agent_id"], "claude-session");
    server.abort();
}
#[tokio::test]
async fn custom_root_does_not_inherit_home_hub_when_server_is_down() {
    let (hub, hub_state, server) = self::server().await;
    let scratch = Scratch::new();
    let custom = scratch.0.join("custom");
    std::fs::create_dir_all(&custom).unwrap();
    let home_settings = scratch.0.join("trame/settings.json");
    std::fs::create_dir_all(home_settings.parent().unwrap()).unwrap();
    std::fs::write(
        home_settings,
        json!({"hubApi":hub,"hubApiToken":"test"}).to_string(),
    )
    .unwrap();
    let output = scratch
        .command(None)
        .env("TRAME_LOCAL_DIR", &custom)
        .env_remove("TRACKER_PORT_FILE")
        .env_remove("TRACKER_SETTINGS_FILE")
        .env_remove("TRACKER_OUTBOX")
        .args([
            "track",
            "--json",
            r#"{"title":"isolated","story":"Release"}"#,
        ])
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap()["queued"],
        true
    );
    assert!(custom.join("outbox.jsonl").exists());
    assert!(hub_state.lock().unwrap().hits.is_empty());
    server.abort();
}
#[tokio::test]
async fn missing_specs_page_id_is_an_error_without_creating_a_page() {
    let (base, state, server) = self::server().await;
    state.lock().unwrap().specs_page_missing_id = true;
    let result = page::write_page(
        &json!({"session_id":"session-1","markdown":"## Specs\nText"}),
        &Target::local(base),
    )
    .await;
    assert!(result.unwrap_err().to_string().contains("missing page_id"));
    assert_eq!(
        state
            .lock()
            .unwrap()
            .hits
            .iter()
            .filter(|h| h.method == "POST")
            .count(),
        1
    );
    server.abort();
}
#[tokio::test]
async fn list_assigner_query_reads_enabled_plugin_card_faces() {
    let (base, state, server) = self::server().await;
    let target = Target::local(base);
    let list =
        async |q: &str| trame_cli::board::list(&["-q".into(), q.into()], true, &target).await;
    list("status:active").await.unwrap();
    assert!(
        list("has:assigner")
            .await
            .unwrap_err()
            .to_string()
            .contains("no enabled plugin provides card assigners")
    );
    state.lock().unwrap().card_faces = true;
    list("assigner:carlo").await.unwrap();
    let paths: Vec<_> = state
        .lock()
        .unwrap()
        .hits
        .iter()
        .filter(|h| h.path.starts_with("/api/plugins"))
        .map(|h| h.path.clone())
        .collect();
    assert_eq!(
        paths,
        [
            "/api/plugins",
            "/api/plugins",
            "/api/plugins/cockpit/assigners"
        ]
    );
    let faces = trame_cli::board::load_assigners(&target).await.unwrap();
    assert_eq!(faces["s1"]["name"], "Carlo Rossi");
    server.abort();
}
#[tokio::test]
async fn list_stories_and_convert_keep_cli_query_and_wire_contracts() {
    let (base, state, server) = self::server().await;
    let target = Target::local(base);
    assert!(
        trame_cli::board::list(&["-q".into(), String::new()], false, &target)
            .await
            .unwrap_err()
            .to_string()
            .contains("needs a query")
    );
    trame_cli::board::stories(
        &[
            "-q".into(),
            "first".into(),
            "--query".into(),
            "second".into(),
            "--client".into(),
            "fixture".into(),
        ],
        false,
        &target,
    )
    .await
    .unwrap();
    trame_cli::board::convert(&["page1".into()], true, &target)
        .await
        .unwrap();
    let state = state.lock().unwrap();
    let similar = state
        .hits
        .iter()
        .find(|hit| hit.path == "/api/stories/similar")
        .unwrap();
    assert!(similar.query.contains("q=first"), "{}", similar.query);
    let convert = state
        .hits
        .iter()
        .find(|hit| hit.path == "/api/pages/page1/session")
        .unwrap();
    assert!(convert.body.is_null(), "convert should send no JSON body");
    server.abort();
}
#[tokio::test]
async fn move_reparents_or_moves_to_top_after_checking_pages() {
    let (base, state, server) = self::server().await;
    let target = Target::local(base);
    let page = "11111111-1111-4111-8111-111111111111";
    let parent = "22222222-2222-4222-8222-222222222222";
    let parent_url = format!("http://localhost/?page={parent}");
    for args in [
        vec![page],
        vec![page, parent, "--top"],
        vec![page, parent, parent],
        vec![page, "not-a-page"],
    ] {
        let args = args.into_iter().map(str::to_owned).collect::<Vec<_>>();
        assert!(
            trame_cli::board::move_page(&args, false, &target)
                .await
                .unwrap_err()
                .to_string()
                .contains("usage")
        );
    }
    trame_cli::board::move_page(&[page.into(), parent_url], true, &target)
        .await
        .unwrap();
    trame_cli::board::move_page(&[page.into(), "--top".into()], true, &target)
        .await
        .unwrap();
    let state = state.lock().unwrap();
    let checked = state
        .hits
        .iter()
        .filter(|h| h.method == "GET")
        .map(|h| h.path.as_str())
        .collect::<Vec<_>>();
    assert!(checked.contains(&format!("/api/pages/{parent}").as_str()));
    let moves = state
        .hits
        .iter()
        .filter(|h| h.path == format!("/api/pages/{page}/move"))
        .map(|h| h.body.clone())
        .collect::<Vec<_>>();
    assert_eq!(
        moves,
        vec![json!({"parent_id":parent}), json!({"parent_id":null})]
    );
    server.abort();
}
#[tokio::test]
async fn invalid_writer_input_precedes_target_resolution() {
    let scratch = Scratch::new();
    for command in ["page", "comment"] {
        let output = scratch
            .command(None)
            .args([command, "{bad-json"])
            .output()
            .await
            .unwrap();
        assert!(!output.status.success());
        let error = String::from_utf8_lossy(&output.stderr);
        assert!(error.contains("line 1 column"), "{command}: {error}");
        assert!(!error.contains("not running"), "{command}: {error}");
    }
}
#[tokio::test]
async fn watch_and_answer_reject_unknown_or_stray_arguments() {
    let scratch = Scratch::new();
    for args in [
        vec!["watch", "--page", "page1", "--bogus"],
        vec!["watch", "--page", "page1", "stray"],
        vec!["answer", "--once", "stray"],
        vec!["answer", "--once", "--bogus"],
    ] {
        let output = scratch.command(None).args(&args).output().await.unwrap();
        assert!(!output.status.success(), "{args:?}");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("unknown flag"),
            "{args:?}"
        );
    }
}
#[tokio::test]
async fn repeated_watch_page_flag_uses_last_value() {
    let (base, _state, server) = self::server().await;
    let port = base.rsplit(':').next().unwrap().parse().unwrap();
    let scratch = Scratch::new();
    let output = timeout(
        Duration::from_secs(5),
        scratch
            .command(Some(port))
            .args([
                "watch",
                "--page",
                "missing",
                "--page",
                "page1",
                "--agent",
                "codex",
                "--quiet",
                "0",
                "--interval",
                "0.01",
            ])
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("feedback ready"));
    server.abort();
}
#[tokio::test]
async fn offline_mode_queues_without_contacting_configured_hub() {
    let (hub, hub_state, server) = server().await;
    let scratch = Scratch::new();
    std::fs::write(
        scratch.0.join("settings.json"),
        json!({"hubApi":hub,"hubApiToken":"copied-token"}).to_string(),
    )
    .unwrap();
    let output = scratch
        .command(None)
        .env("TRAME_OFFLINE", "1")
        .args([
            "track",
            "--json",
            r#"{"title":"offline card","story":"Later"}"#,
        ])
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["queued"], true);
    assert!(
        response["error"]
            .as_str()
            .unwrap()
            .contains("TRAME_OFFLINE=1")
    );
    assert!(hub_state.lock().unwrap().hits.is_empty());
    assert_eq!(
        serde_json::from_str::<Value>(
            std::fs::read_to_string(scratch.0.join("outbox.jsonl"))
                .unwrap()
                .trim()
        )
        .unwrap()["title"],
        "offline card"
    );
    server.abort();
}
#[tokio::test]
async fn authenticated_hub_requests_never_follow_redirects() {
    let (sink, sink_state, sink_server) = server().await;
    let (hub, hub_state, hub_server) = server().await;
    hub_state.lock().unwrap().redirect_to = Some(format!("{sink}/leak"));
    let scratch = Scratch::new();
    std::fs::write(
        scratch.0.join("settings.json"),
        json!({"hubApi":hub,"hubApiToken":"test-token"}).to_string(),
    )
    .unwrap();
    let output = scratch
        .command(None)
        .args(["track", "--json", r#"{"title":"card","story":"Release"}"#])
        .output()
        .await
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("the hub rejected the track"));
    assert_eq!(
        hub_state
            .lock()
            .unwrap()
            .hits
            .iter()
            .filter(|h| h.path == "/api/sessions")
            .count(),
        1
    );
    assert!(sink_state.lock().unwrap().hits.is_empty());
    assert!(!scratch.0.join("outbox.jsonl").exists());
    hub_server.abort();
    sink_server.abort();
}
struct EnvGuard(Vec<(String, Option<std::ffi::OsString>)>);
impl EnvGuard {
    fn set(pairs: &[(&str, &std::ffi::OsStr)]) -> Self {
        let old = pairs
            .iter()
            .map(|(key, _)| ((*key).to_owned(), std::env::var_os(key)))
            .collect();
        for (key, value) in pairs {
            unsafe {
                std::env::set_var(key, value);
            }
        }
        Self(old)
    }
}
impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (key, old) in &self.0 {
            if let Some(value) = old {
                unsafe {
                    std::env::set_var(key, value);
                }
            } else {
                unsafe {
                    std::env::remove_var(key);
                }
            }
        }
    }
}
#[tokio::test]
async fn returning_from_hub_syncs_local_once_before_reads() {
    let scratch = Scratch::new();
    let (hub_base, _, hub_server) = server().await;
    let (local_base, local_state, local_server) = server().await;
    std::fs::write(
        scratch.0.join("settings.json"),
        json!({"hubApi":hub_base,"hubApiToken":"test"}).to_string(),
    )
    .unwrap();
    let _env = EnvGuard::set(&[
        ("TRAME_OFFLINE", std::ffi::OsStr::new("0")),
        ("TRACKER_PORT_FILE", scratch.0.join("port.json").as_os_str()),
        (
            "TRACKER_SETTINGS_FILE",
            scratch.0.join("settings.json").as_os_str(),
        ),
    ]);
    assert!(resolve_target().await.unwrap().hub);
    let port: u16 = local_base.rsplit(':').next().unwrap().parse().unwrap();
    std::fs::write(
        scratch.0.join("port.json"),
        json!({"port":port}).to_string(),
    )
    .unwrap();
    assert!(!resolve_target().await.unwrap().hub);
    assert!(!resolve_target().await.unwrap().hub);
    let syncs = local_state
        .lock()
        .unwrap()
        .hits
        .iter()
        .filter(|hit| hit.method == "POST" && hit.path == "/api/sync")
        .count();
    assert_eq!(syncs, 1);
    hub_server.abort();
    local_server.abort();
}
#[tokio::test]
async fn watcher_page_selectors_include_subpages() {
    let (base, state, server) = server().await;
    state.lock().unwrap().page_tree = true;
    let target = Target::local(base);
    let tree = trame_cli::watch::resolve_pages(
        &target,
        &["plan: TRAMECLI".to_owned()].into_iter().collect(),
    )
    .await
    .unwrap();
    assert_eq!(
        tree,
        ["p1".to_owned(), "p2".to_owned()].into_iter().collect()
    );
    assert_eq!(
        trame_cli::watch::resolve_pages(&target, &["p3".to_owned()].into_iter().collect())
            .await
            .unwrap(),
        ["p3".to_owned()].into_iter().collect()
    );
    assert!(
        trame_cli::watch::resolve_pages(&target, &["nope".to_owned()].into_iter().collect())
            .await
            .unwrap()
            .is_empty()
    );
    server.abort();
}
#[tokio::test]
async fn answer_once_dry_run_prints_prompt_without_agent_or_comment_writes() {
    let (base, state, server) = server().await;
    let port = base.rsplit(':').next().unwrap().parse().unwrap();
    let scratch = Scratch::new();
    let output = scratch
        .command(Some(port))
        .args([
            "answer",
            "--once",
            "--dry-run",
            "--agents",
            "codex",
            "--page",
            "page1",
        ])
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("[dry-run] would answer comment-1 as codex"));
    assert!(stdout.contains("Output ONLY the comment body"));
    let state = state.lock().unwrap();
    assert!(state.hits.iter().any(|h| h.path == "/api/comments/inbox"));
    assert!(
        state
            .hits
            .iter()
            .all(|h| h.path != "/api/comments" || h.method != "POST")
    );
    assert!(
        state
            .hits
            .iter()
            .all(|h| !h.path.ends_with("/agent-status"))
    );
    server.abort();
}
#[tokio::test]
async fn answer_once_uses_stub_agent_and_posts_attributed_reply() {
    let (base, state, server) = server().await;
    let port = base.rsplit(':').next().unwrap().parse().unwrap();
    let scratch = Scratch::new();
    let script = scratch.0.join("stub-agent.sh");
    std::fs::write(
        &script,
        "#!/bin/sh\ncat >/dev/null\nprintf 'Fixed answer\\n'\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let output = scratch
        .command(Some(port))
        .env("TRAME_WATCH_GLM_CMD", &script)
        .args(["answer", "--once", "--force-agent", "glm"])
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("answered comment-1"));
    let state = state.lock().unwrap();
    let statuses = state
        .hits
        .iter()
        .filter(|h| h.path == "/api/comments/comment-1/agent-status")
        .map(|h| h.body["status"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(statuses, vec!["seen", "answering", "answered"]);
    let reply = state
        .hits
        .iter()
        .find(|h| h.path == "/api/comments" && h.method == "POST")
        .unwrap();
    assert_eq!(reply.body["agent"], "glm");
    assert_eq!(reply.body["body"], "Fixed answer");
    assert_eq!(reply.body["meta"]["model"], "glm");
    assert!(reply.body["meta"]["ms"].is_number());
    server.abort();
}
#[tokio::test]
async fn setup_relinks_embeds_skills_and_respects_git_hooks_path() {
    let scratch = Scratch::new();
    let bin = env!("CARGO_BIN_EXE_tramecli");
    let path = format!("{}/.local/bin:/usr/bin:/bin", scratch.0.display());
    let output = scratch
        .command(None)
        .env("PATH", &path)
        .args(["setup", "--claude", "--codex"])
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let linked = scratch.0.join(".local/bin/tramecli");
    assert_eq!(
        std::fs::canonicalize(&linked).unwrap(),
        std::fs::canonicalize(bin).unwrap()
    );
    for relative in [
        ".claude/skills/trame-track/SKILL.md",
        ".claude/skills/trame-page/SKILL.md",
        ".claude/skills/trame-watch/SKILL.md",
        ".claude/skills/trame/SKILL.md",
        ".claude/skills/trame-plugin/SKILL.md",
        ".claude/skills/trame-plugin/references/templates.md",
        ".agents/skills/trame-track/SKILL.md",
        ".agents/skills/trame-track/agents/openai.yaml",
        ".agents/skills/trame-page/SKILL.md",
        ".agents/skills/trame-watch/SKILL.md",
        ".agents/skills/trame-plugin/SKILL.md",
    ] {
        assert!(scratch.0.join(relative).exists(), "{relative}");
    }
    assert!(
        std::fs::read_to_string(scratch.0.join(".claude/skills/trame-track/SKILL.md"))
            .unwrap()
            .contains("tramecli track --help")
    );
    let legacy = scratch.0.join(".claude/commands/trame");
    std::fs::create_dir_all(&legacy).unwrap();
    std::fs::write(legacy.join("track.md"), "old").unwrap();
    let again = scratch
        .command(None)
        .env("PATH", &path)
        .args(["setup", "--claude"])
        .output()
        .await
        .unwrap();
    assert!(again.status.success());
    assert!(!legacy.exists());
    let shadow = scratch.0.join("shadow");
    std::fs::create_dir_all(&shadow).unwrap();
    std::fs::write(shadow.join("tramecli"), "other").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            shadow.join("tramecli"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
    }
    let output = scratch
        .command(None)
        .env("PATH", format!("{}:{path}", shadow.display()))
        .args(["setup", "--claude"])
        .output()
        .await
        .unwrap();
    assert!(
        String::from_utf8_lossy(&output.stderr).contains(
            &std::fs::canonicalize(shadow.join("tramecli"))
                .unwrap()
                .display()
                .to_string()
        )
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            shadow.join("tramecli"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        let output = scratch
            .command(None)
            .env("PATH", format!("{}:{path}", shadow.display()))
            .args(["setup", "--claude"])
            .output()
            .await
            .unwrap();
        assert!(output.status.success());
        assert!(!String::from_utf8_lossy(&output.stderr).contains("still resolves"));
    }

    let init = Command::new("git")
        .arg("init")
        .arg("-q")
        .current_dir(&scratch.0)
        .output()
        .await
        .unwrap();
    assert!(init.status.success());
    let output = scratch
        .command(None)
        .current_dir(&scratch.0)
        .env("PATH", &path)
        .args(["setup", "--hook"])
        .output()
        .await
        .unwrap();
    assert!(output.status.success());
    let hook = scratch.0.join(".git/hooks/pre-push");
    assert!(
        std::fs::read_to_string(&hook)
            .unwrap()
            .contains("tramecli list --json")
    );
    let installed = std::fs::read_to_string(&hook).unwrap();
    let again = scratch
        .command(None)
        .current_dir(&scratch.0)
        .env("PATH", &path)
        .args(["setup", "--hook"])
        .output()
        .await
        .unwrap();
    assert!(again.status.success());
    assert_eq!(std::fs::read_to_string(&hook).unwrap(), installed);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&hook).unwrap().permissions().mode() & 0o111,
            0o111
        );
    }
    let custom = scratch.0.join(".githooks");
    std::fs::create_dir_all(&custom).unwrap();
    let config = Command::new("git")
        .args(["config", "core.hooksPath", ".githooks"])
        .current_dir(&scratch.0)
        .output()
        .await
        .unwrap();
    assert!(config.status.success());
    let output = scratch
        .command(None)
        .current_dir(&scratch.0)
        .env("PATH", &path)
        .args(["setup", "--hook"])
        .output()
        .await
        .unwrap();
    assert!(output.status.success());
    let custom_hook = custom.join("pre-push");
    assert!(custom_hook.exists());
    std::fs::write(&custom_hook, "#!/bin/sh\nsomeone else\n").unwrap();
    let output = scratch
        .command(None)
        .current_dir(&scratch.0)
        .env("PATH", &path)
        .args(["setup", "--hook"])
        .output()
        .await
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("not ours"));
    assert_eq!(
        std::fs::read_to_string(&custom_hook).unwrap(),
        "#!/bin/sh\nsomeone else\n"
    );
}
#[tokio::test]
async fn watch_marks_seen_then_answering_after_quiet() {
    let (base, state, server) = server().await;
    state.lock().unwrap().watch_quiet = true;
    let port = base.rsplit(':').next().unwrap().parse().unwrap();
    let scratch = Scratch::new();
    let child = scratch
        .command(Some(port))
        .args([
            "watch",
            "--page",
            "page1",
            "--agent",
            "codex",
            "--quiet",
            "30",
            "--interval",
            "0.01",
        ])
        .output();
    let output = timeout(Duration::from_secs(5), child)
        .await
        .unwrap()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("feedback ready"));
    let state = state.lock().unwrap();
    assert!(state.inbox_polls >= 2);
    assert!(state.comment_polls >= 2);
    let statuses = state
        .hits
        .iter()
        .filter(|h| h.path == "/api/comments/comment-1/agent-status")
        .map(|h| h.body["status"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(statuses, vec!["seen", "answering"]);
    server.abort();
}
#[tokio::test]
async fn watch_retries_after_comment_fetch_failure_before_claiming() {
    let (base, state, server) = self::server().await;
    {
        let mut state = state.lock().unwrap();
        state.watch_quiet = true;
        state.comments_fail_once = true;
    }
    let port = base.rsplit(':').next().unwrap().parse().unwrap();
    let scratch = Scratch::new();
    let output = timeout(
        Duration::from_secs(5),
        scratch
            .command(Some(port))
            .args([
                "watch",
                "--page",
                "page1",
                "--agent",
                "codex",
                "--quiet",
                "30",
                "--interval",
                "0.01",
            ])
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let state = state.lock().unwrap();
    assert!(
        state.comment_polls >= 3,
        "a failed fetch must not satisfy quiet time"
    );
    let statuses = state
        .hits
        .iter()
        .filter(|h| h.path == "/api/comments/comment-1/agent-status")
        .map(|h| h.body["status"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(statuses, vec!["seen", "answering"]);
    server.abort();
}
#[tokio::test]
async fn watch_retries_after_malformed_comment_list_before_claiming() {
    let (base, state, server) = self::server().await;
    {
        let mut state = state.lock().unwrap();
        state.watch_quiet = true;
        state.comments_invalid_once = true;
    }
    let port = base.rsplit(':').next().unwrap().parse().unwrap();
    let scratch = Scratch::new();
    let output = timeout(
        Duration::from_secs(5),
        scratch
            .command(Some(port))
            .args([
                "watch",
                "--page",
                "page1",
                "--agent",
                "codex",
                "--quiet",
                "30",
                "--interval",
                "0.01",
            ])
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let state = state.lock().unwrap();
    assert!(state.comment_polls >= 3);
    assert!(state.hits.iter().any(
        |h| h.path == "/api/comments/comment-1/agent-status" && h.body["status"] == "answering"
    ));
    server.abort();
}
#[cfg(unix)]
#[tokio::test]
async fn timed_out_agent_and_its_child_are_killed() {
    use std::os::unix::fs::PermissionsExt;
    let (base, state, server) = self::server().await;
    let port = base.rsplit(':').next().unwrap().parse().unwrap();
    let scratch = Scratch::new();
    let stub = scratch.0.join("agent.sh");
    let pids = scratch.0.join("agent-pids");
    std::fs::write(
        &stub,
        format!(
            "#!/bin/sh\nsleep 10 &\nprintf '%s %s\\n' \"$$\" \"$!\" >> '{}'\nwait\n",
            pids.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
    let output = timeout(
        Duration::from_secs(5),
        scratch
            .command(Some(port))
            .env("TRAME_WATCH_GLM_CMD", &stub)
            // long enough for the stub to record its pids before the kill, even on a loaded runner
            .env("TRAME_WATCH_TIMEOUT", "0.5")
            .args(["answer", "--once", "--force-agent", "glm"])
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let lines = std::fs::read_to_string(pids).unwrap();
    assert_eq!(lines.lines().count(), 3);
    tokio::time::sleep(Duration::from_millis(100)).await;
    for pid in lines.split_whitespace().map(|s| s.parse::<i32>().unwrap()) {
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "orphan process {pid}");
    }
    assert!(
        state
            .lock()
            .unwrap()
            .hits
            .iter()
            .any(|h| h.path == "/api/comments/comment-1/agent-status"
                && h.body["status"] == "failed")
    );
    server.abort();
}
#[tokio::test]
async fn rust_claude_hook_records_and_prunes_cwd_map() {
    let scratch = Scratch::new();
    let map = scratch.0.join("claude-sessions.json");
    std::fs::write(
        &map,
        json!({"stale":{"id":"old","at":"2020-01-01T00:00:00Z"}}).to_string(),
    )
    .unwrap();
    for (cwd, id) in [("/repo/one", "session-1"), ("/repo/two", "session-2")] {
        let mut child = scratch
            .command(None)
            .arg("hook")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(
                json!({"session_id":id,"cwd":cwd,"transcript_path":"/scratch/transcript.jsonl"})
                    .to_string()
                    .as_bytes(),
            )
            .await
            .unwrap();
        assert!(child.wait().await.unwrap().success());
    }
    let value: Value = serde_json::from_str(&std::fs::read_to_string(map).unwrap()).unwrap();
    assert!(value.get("stale").is_none());
    assert_eq!(value["/repo/one"]["id"], "session-1");
    assert_eq!(
        value["/repo/two"]["transcript"],
        "/scratch/transcript.jsonl"
    );
}
#[tokio::test]
async fn concurrent_claude_hooks_keep_every_cwd() {
    let scratch = Scratch::new();
    let mut children = Vec::new();
    for i in 0..12 {
        let mut child = scratch
            .command(None)
            .arg("hook")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(
                json!({"session_id":format!("session-{i}"),"cwd":format!("/repo/{i}")})
                    .to_string()
                    .as_bytes(),
            )
            .await
            .unwrap();
        children.push(child);
    }
    for mut child in children {
        assert!(child.wait().await.unwrap().success());
    }
    let map: Value = serde_json::from_str(
        &std::fs::read_to_string(scratch.0.join("claude-sessions.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(map.as_object().unwrap().len(), 12);
    for i in 0..12 {
        assert_eq!(map[format!("/repo/{i}")]["id"], format!("session-{i}"));
    }
}
#[tokio::test]
async fn presence_finds_name_before_long_transcript_tail() {
    let (base, state, server) = self::server().await;
    let port = base.rsplit(':').next().unwrap().parse().unwrap();
    let scratch = Scratch::new();
    let transcript = scratch.0.join("transcript.jsonl");
    std::fs::write(
        &transcript,
        format!(
            "{{\"type\":\"agent-name\",\"agentName\":\"Release Reader\"}}\n{}",
            "{}\n".repeat(150_000)
        ),
    )
    .unwrap();
    let mut child = scratch
        .command(Some(port))
        .args(["presence", "--hook", "claude"])
        .stdin(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(json!({"session_id":"session-1","hook_event_name":"UserPromptSubmit","transcript_path":transcript}).to_string().as_bytes()).await.unwrap();
    assert!(child.wait().await.unwrap().success());
    let state = state.lock().unwrap();
    let post = state
        .hits
        .iter()
        .find(|h| h.path == "/api/sessions/session-1/presence")
        .unwrap();
    assert_eq!(post.body["name"], "Release Reader");
    server.abort();
}
async fn rpc(
    reader: &mut BufReader<tokio::process::ChildStdout>,
    writer: &mut tokio::process::ChildStdin,
    id: i64,
    method: &str,
    params: Value,
) -> Value {
    let request = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
    writer
        .write_all(format!("{request}\n").as_bytes())
        .await
        .unwrap();
    let mut line = String::new();
    loop {
        line.clear();
        timeout(Duration::from_secs(5), reader.read_line(&mut line))
            .await
            .unwrap()
            .unwrap();
        assert!(!line.is_empty(), "MCP closed stdout");
        let response: Value = serde_json::from_str(&line).unwrap();
        if response["id"] == id {
            return response;
        }
    }
}
#[tokio::test]
async fn mcp_initialize_lists_and_calls_real_tools() {
    let (base, state, server) = server().await;
    let port = base.rsplit(':').next().unwrap().parse().unwrap();
    let scratch = Scratch::new();
    let mut child = scratch
        .command(Some(port))
        .arg("mcp")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut writer = child.stdin.take().unwrap();
    let mut reader = BufReader::new(child.stdout.take().unwrap());
    let init = rpc(
        &mut reader,
        &mut writer,
        1,
        "initialize",
        json!({"protocolVersion":"2025-06-18",
        "capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}),
    )
    .await;
    assert_eq!(init["result"]["serverInfo"]["name"], "trame");
    writer
        .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n")
        .await
        .unwrap();
    let list = rpc(&mut reader, &mut writer, 2, "tools/list", json!({})).await;
    let names = list["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    for name in [
        "trame_capabilities",
        "trame_board",
        "trame_due",
        "trame_session",
        "trame_track",
        "trame_set_status",
        "trame_new_story",
        "trame_create_page",
        "trame_update_page",
        "trame_move_page",
        "trame_add_comment",
        "trame_html",
        "trame_html_data",
        "trame_report",
        "trame_reports",
        "trame_sync",
    ] {
        assert!(names.contains(&name), "{name}");
    }
    let track_schema = list["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "trame_track")
        .unwrap();
    assert_eq!(
        track_schema["inputSchema"]["properties"]["status"]["enum"],
        json!(["todo", "active", "paused", "blocked", "done"])
    );
    assert_eq!(track_schema["inputSchema"]["required"], json!(["title"]));
    assert!(
        track_schema["description"]
            .as_str()
            .unwrap()
            .contains("One agent session + story = one card")
    );
    assert!(
        track_schema["inputSchema"]["properties"]["tags"]["description"]
            .as_str()
            .unwrap()
            .contains("Omit to preserve")
    );
    let session_schema = list["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "trame_session")
        .unwrap();
    assert!(
        session_schema["inputSchema"]["properties"]["session"]["description"]
            .as_str()
            .unwrap()
            .contains("pasted Trame URL")
    );
    let invalid = rpc(
        &mut reader,
        &mut writer,
        7,
        "tools/call",
        json!({"name":"trame_track","arguments":{"title":"x","status":"nonsense"}}),
    )
    .await;
    assert_eq!(invalid["result"]["isError"], true);
    let board = rpc(
        &mut reader,
        &mut writer,
        3,
        "tools/call",
        json!({"name":"trame_board","arguments":{}}),
    )
    .await;
    assert!(!board["result"]["isError"].as_bool().unwrap_or(false));
    let content = board["result"]["content"][0]["text"].as_str().unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(content).unwrap()["sessions"],
        json!([])
    );
    let cap = rpc(
        &mut reader,
        &mut writer,
        4,
        "tools/call",
        json!({"name":"trame_capabilities","arguments":{}}),
    )
    .await;
    assert!(
        cap["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Page Markdown dialect")
    );
    assert!(
        state
            .lock()
            .unwrap()
            .hits
            .iter()
            .any(|h| h.path == "/api/board")
    );
    let moved = rpc(
        &mut reader,
        &mut writer,
        5,
        "tools/call",
        json!({"name":"trame_move_page","arguments":{"page_id":"page1","before_id":"other"}}),
    )
    .await;
    assert!(!moved["result"]["isError"].as_bool().unwrap_or(false));
    let moved = rpc(
        &mut reader,
        &mut writer,
        6,
        "tools/call",
        json!({"name":"trame_move_page","arguments":{"page_id":"page1","parent_id":null}}),
    )
    .await;
    assert!(!moved["result"]["isError"].as_bool().unwrap_or(false));
    let moves = state
        .lock()
        .unwrap()
        .hits
        .iter()
        .filter(|h| h.path == "/api/pages/page1/move")
        .map(|h| h.body.clone())
        .collect::<Vec<_>>();
    assert_eq!(
        moves,
        vec![json!({"before_id":"other"}), json!({"parent_id":null})]
    );
    child.kill().await.unwrap();
    server.abort();
}
#[tokio::test]
async fn open_without_app_prints_the_link_and_exits_1() {
    let scratch = Scratch::new();
    let id = "0b5c1d2e-3f40-4a51-8b62-7c83d94ea5f6";
    for (input, url) in [
        (id.to_owned(), format!("trame://card/{id}")),
        (
            format!("http://127.0.0.1:8787/?page={id}"),
            format!("trame://page/{id}"),
        ),
    ] {
        // no port file, and no xdg-mime/open on PATH: nothing can show it
        let output = scratch
            .command(None)
            .env("PATH", &scratch.0)
            .args(["open", &input])
            .output()
            .await
            .unwrap();
        assert_eq!(output.status.code(), Some(1), "{input}");
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), url);
    }
}
