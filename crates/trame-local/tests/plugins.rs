#![allow(unsafe_code, reason = "tests mutate env vars (set_var/remove_var)")]

mod common;
use common::TestDb;
use serde_json::{Value, json};
use trame_local::{
    plugins::{self, ships},
    settings,
};
static FIXTURE_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn gitlab_auth_never_lends_ambient_token_to_unsaved_host() {
    unsafe {
        std::env::set_var("GITLAB_TOKEN", "fixture-env-secret");
    }
    let saved = plugins::auth::gitlab(&json!({}), "https://gitlab.com", true);
    assert_eq!(saved.source, "env");
    assert_eq!(saved.token, "fixture-env-secret");
    let unsaved = plugins::auth::gitlab(&json!({}), "http://attacker.example", false);
    assert_eq!(unsaved.source, "none");
    assert!(unsaved.token.is_empty());
    let supplied = plugins::auth::gitlab(
        &json!({"gitlabToken":"pat-123"}),
        "http://attacker.example",
        false,
    );
    assert_eq!(supplied.source, "settings");
    assert_eq!(supplied.token, "pat-123");
    unsafe {
        std::env::remove_var("GITLAB_TOKEN");
    }
}

#[test]
fn forge_actions_require_watched_targets_and_valid_ids() {
    let slice = json!({"githubRepos":["acme/webapp"],"gitlabProjects":["acme/api"]});
    for action in [
        json!({"kind":"github-approve","repo":"other/repo","runId":1,"environmentId":2}),
        json!({"kind":"gitlab-play","project":"other/project","jobId":1}),
    ] {
        assert!(plugins::live::action_precondition(&slice, &action).is_some());
    }
    assert_eq!(
        plugins::live::action_precondition(
            &slice,
            &json!({"kind":"github-reject","repo":"acme/webapp","runId":"bad","environmentId":2})
        )
        .unwrap()["error"],
        "bad action"
    );
    assert_eq!(
        plugins::live::action_precondition(&slice, &json!({"kind":"bogus"})).unwrap()["error"],
        "unknown action"
    );
    assert!(
        plugins::live::action_precondition(
            &slice,
            &json!({"kind":"github-approve","repo":"acme/webapp","runId":1,"environmentId":2})
        )
        .is_none()
    );
    assert!(
        plugins::live::action_precondition(
            &slice,
            &json!({"kind":"gitlab-reject","project":"acme/api","deploymentId":3})
        )
        .is_none()
    );
}

#[test]
fn ships_rules_refs_and_card_matching_retain_source_cases() {
    let gh = ships::defaults("github");
    let gl = ships::defaults("gitlab");
    for (message, pattern, want) in [
        (
            "[master] fix(ci): retry (#3922) (#3923)",
            gh["pattern"].as_str().unwrap(),
            vec![3922, 3923],
        ),
        (
            "feat: checkout revamp (#120)",
            gh["pattern"].as_str().unwrap(),
            vec![120],
        ),
        (
            "Merge pull request #57 from acme/feat",
            gh["pattern"].as_str().unwrap(),
            vec![57],
        ),
        (
            "Merge branch 'chore/x' into 'master'\n\nchore: drop map\n\nSee merge request obitrain/obiapp!200",
            gl["pattern"].as_str().unwrap(),
            vec![200],
        ),
        ("PROJ-12: fix login (PR-88)", "PR-(\\d+)", vec![88]),
        ("chore: bump deps", gh["pattern"].as_str().unwrap(), vec![]),
    ] {
        assert_eq!(ships::ref_numbers(message, pattern), want);
    }
    let fixture: Value = serde_json::from_slice(
        &std::fs::read(
            trame_local::workspace().join("app/plugins/deployments/fixture.sample.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let commits = fixture["changelogs"]["https://github.com/acme/webapp/actions/runs/123456789"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            ships::ref_numbers(
                c["title"].as_str().unwrap(),
                gh["pattern"].as_str().unwrap(),
            )
        })
        .collect::<Vec<_>>();
    let card =
        |id: &str, url: Option<&str>| json!({"id":id,"title":id,"status":"active","pr_url":url});
    for (forge, refs, c, backport, want) in [
        (
            "github",
            commits.clone(),
            card("a", Some("https://github.com/acme/webapp/pull/3928")),
            true,
            Some((3928, Some(3931))),
        ),
        (
            "github",
            commits.clone(),
            card("a", Some("https://github.com/acme/webapp/pull/3928")),
            false,
            Some((3928, None)),
        ),
        (
            "github",
            commits.clone(),
            card(
                "b",
                Some(
                    "https://github.com/acme/webapp/pull/1\nhttps://github.com/acme/webapp/pull/3931",
                ),
            ),
            true,
            Some((3931, Some(3928))),
        ),
        (
            "github",
            commits.clone(),
            card("c", Some("https://github.com/acme/api/pull/3928")),
            true,
            None,
        ),
        (
            "github",
            commits.clone(),
            card("d", Some("https://github.com/acme/webapp/pull/392")),
            true,
            None,
        ),
        (
            "gitlab",
            vec![vec![200]],
            card(
                "e",
                Some("https://gitlab.com/acme/webapp/-/merge_requests/200"),
            ),
            true,
            Some((200, None)),
        ),
        (
            "gitlab",
            vec![vec![200]],
            card(
                "f",
                Some("https://git.corp/acme/webapp/-/merge_requests/200"),
            ),
            true,
            None,
        ),
        ("github", commits, card("g", None), true, None),
    ] {
        let hit = ships::match_cards(
            forge,
            "https://gitlab.com",
            "acme/webapp",
            &refs,
            &[c],
            backport,
        );
        assert_eq!(
            hit.first()
                .map(|h| (h["pr"].as_i64().unwrap(), h["via"].as_i64())),
            want
        );
    }
    let stored = json!({"acme/webapp":{"pattern":"PR-(\\d+)","environments":["production"],"backport":false},"acme/api":{"pattern":"(unclosed"}});
    assert_eq!(
        ships::rule_for(&stored, "acme/webapp", "github"),
        stored["acme/webapp"]
    );
    assert_eq!(ships::rule_for(&stored, "acme/api", "gitlab"), gl);
    assert_eq!(ships::rule_for(&stored, "acme/other", "github"), gh);
    assert_eq!(
        ships::sanitize_rules(
            &json!({"acme/webapp":stored["acme/webapp"],"acme/api":stored["acme/api"],"evil/unwatched":{"backport":false},"acme/x":{"pattern":"no-group"}}),
            &["acme/webapp".into(), "acme/api".into(), "acme/x".into()]
        ),
        json!({"acme/webapp":stored["acme/webapp"]})
    );
}

#[test]
fn fixture_routes_preserve_gate_actions_ignores_and_redaction() {
    let _guard = FIXTURE_ENV_LOCK.lock().unwrap();
    unsafe {
        std::env::set_var(
            "TRACKER_DEPLOYMENTS_FIXTURE",
            trame_local::workspace().join("app/plugins/deployments/fixture.sample.json"),
        );
    }
    let mut t = TestDb::new();
    let path = t.root.join("settings.json");
    let call = |t: &mut TestDb, method: &str, path_: &str, body: Value| {
        plugins::handle(&mut t.db, &path, method, path_, "", &body).unwrap()
    };
    assert_eq!(
        call(&mut t, "GET", "/api/plugins/deployments/state", Value::Null).0,
        403
    );
    let (_, s) = call(
        &mut t,
        "POST",
        "/api/plugins/deployments/settings",
        json!({"gitlabBaseUrl":"https://gl.example.com","gitlabToken":"secret-glpat","githubRepos":["acme/webapp"]}),
    );
    assert_eq!(s["gitlabHasToken"], true);
    assert!(!s.to_string().contains("secret-glpat"));
    let (_, s) = call(
        &mut t,
        "POST",
        "/api/plugins/deployments/settings",
        json!({"gitlabBaseUrl":"https://attacker.example.com"}),
    );
    assert_eq!(s["gitlabHasToken"], false);
    assert_eq!(settings::plugin(&path, "deployments")["gitlabToken"], "");
    let (_, s) = call(
        &mut t,
        "POST",
        "/api/plugins/deployments/enable",
        json!({"enabled":true}),
    );
    assert_eq!(s["enabled"], true);
    let (_, s) = call(
        &mut t,
        "POST",
        "/api/plugins/deployments/refresh",
        Value::Null,
    );
    assert_eq!(s["items"].as_array().unwrap().len(), 5);
    assert_eq!(
        call(&mut t, "GET", "/api/plugins", Value::Null).1[0]["badge"],
        5
    );
    let item = s["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["environment"] == "live")
        .unwrap()
        .clone();
    let body = json!({"url":item["url"],"environment":item["environment"],"ignored":true});
    assert_eq!(
        call(
            &mut t,
            "POST",
            "/api/plugins/deployments/ignore",
            body.clone()
        )
        .1["state"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|i| i["ignored"] == true)
            .count(),
        1
    );
    assert_eq!(
        call(
            &mut t,
            "POST",
            "/api/plugins/deployments/refresh",
            Value::Null
        )
        .1["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|i| i["ignored"] == true)
            .count(),
        1
    );
    let (_, change) = call(
        &mut t,
        "POST",
        "/api/plugins/deployments/changelog",
        json!({"url":"https://github.com/acme/webapp/actions/runs/123456789"}),
    );
    assert_eq!(change["commits"].as_array().unwrap().len(), 3);
    let (_, res) = call(
        &mut t,
        "POST",
        "/api/plugins/deployments/approve",
        json!({"url":item["url"],"environment":item["environment"],"action":item["action"]}),
    );
    assert_eq!(res["state"]["items"].as_array().unwrap().len(), 4);
    assert_eq!(
        call(
            &mut t,
            "POST",
            "/api/plugins/deployments/test",
            json!({"forge":"github"})
        )
        .1["ok"],
        true
    );
    call(
        &mut t,
        "POST",
        "/api/plugins/deployments/enable",
        json!({"enabled":false}),
    );
    assert_eq!(
        call(&mut t, "GET", "/api/plugins/deployments/state", Value::Null).0,
        403
    );
    unsafe {
        std::env::remove_var("TRACKER_DEPLOYMENTS_FIXTURE");
    }
}

#[test]
#[allow(
    clippy::async_yields_async,
    reason = "the poller JoinHandle is aborted by the test, not awaited"
)]
fn boot_poll_starts_without_request_and_stops_before_database_shutdown() {
    let _guard = FIXTURE_ENV_LOCK.lock().unwrap();
    unsafe {
        std::env::set_var(
            "TRACKER_DEPLOYMENTS_FIXTURE",
            trame_local::workspace().join("app/plugins/deployments/fixture.sample.json"),
        );
    }
    let mut t = TestDb::new();
    let settings_path = t.root.join("settings.json");
    settings::save_plugin(&settings_path, "deployments", &json!({"enabled":true})).unwrap();
    let state = trame_local::routes::Native {
        root: t.root.clone(),
        web_dir: t.root.join("web"),
        origin: "rust-slice2-test".into(),
        settings: settings_path.clone(),
        sync: trame_local::sync::Sync::new(
            t.root.clone(),
            settings_path.clone(),
            "rust-slice2-test".into(),
            true,
        ),
        port: 0,
        desktop: false,
        demo: trame_local::demo::Demo::default(),
    };
    let rt = tokio::runtime::Runtime::new().unwrap();
    let poller = rt.block_on(async { plugins::start(state.clone()).expect("fixture poller") });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let (_, value) = plugins::handle(
            &mut t.db,
            &settings_path,
            "GET",
            "/api/plugins/deployments/state",
            "",
            &Value::Null,
        )
        .unwrap();
        if value["items"]
            .as_array()
            .is_some_and(|items| items.len() == 5)
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "boot poll did not populate state"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    rt.block_on(async {
        poller.abort();
        let _ = poller.await;
    });
    unsafe {
        std::env::remove_var("TRACKER_DEPLOYMENTS_FIXTURE");
    }
    assert!(plugins::start(state.clone()).is_none());
    let (_, reset) = plugins::handle(
        &mut t.db,
        &settings_path,
        "GET",
        "/api/plugins/deployments/state",
        "",
        &Value::Null,
    )
    .unwrap();
    assert_eq!(reset["items"], json!([]));
    let mut live_state = state;
    live_state.sync.offline = false;
    let live_poller = rt.block_on(async { plugins::start(live_state).expect("live poller") });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let (_, value) = plugins::handle(
            &mut t.db,
            &settings_path,
            "GET",
            "/api/plugins/deployments/state",
            "",
            &Value::Null,
        )
        .unwrap();
        if value["polledAt"].is_string() {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "live boot poll did not populate state"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    rt.block_on(async {
        live_poller.abort();
        let _ = live_poller.await;
    });
    drop(t);
}

#[tokio::test]
async fn gitlab_live_adapter_maps_latest_environment_and_compare() {
    use axum::{Json, Router, http::Uri};
    let router=Router::new().fallback(|uri:Uri|async move {
        let path=uri.path();let query=uri.query().unwrap_or("");
        let body=if path.ends_with("/pipelines"){json!([{"status":"running"}])}
        else if path.ends_with("/deployments") && query.contains("status=success"){json!([{"sha":"base123456789"}])}
        else if path.ends_with("/deployments") {json!([
            {"id":1,"ref":"main","sha":"head123456","created_at":"2026-07-01T00:00:00Z","status":"blocked","user":{"username":"writer"},"environment":{"id":7,"name":"production"},"deployable":{"id":10,"name":"deploy prod","status":"manual","web_url":"https://gl.invalid/job/10"}},
            {"id":2,"ref":"old","sha":"old123","created_at":"2026-06-01T00:00:00Z","status":"blocked","environment":{"id":7,"name":"production"}},
            {"id":3,"ref":"main","sha":"head123456","created_at":"2026-07-01T00:00:00Z","status":"running","environment":{"id":8,"name":"staging"},"deployable":{"id":11,"name":"deploy staging","status":"running"}},
            {"id":4,"ref":"main","sha":"head123456","created_at":"2020-01-01T00:00:00Z","updated_at":"2020-01-01T01:00:00Z","status":"failed","environment":{"id":9,"name":"old-failed"}},
            {"id":5,"ref":"main","sha":"head123456","created_at":"2026-07-01T00:00:00Z","status":"success","environment":{"id":10,"name":"success"}}
        ])}
        else if path.ends_with("/repository/compare"){json!({"commits":[{"id":"fullsha","short_id":"full","title":"Ship!","message":"Ship! !12","author_name":"Writer","created_at":"2026-07-01T00:00:00Z"}]})}
        else if path.ends_with("/merge_requests"){json!([{"iid":12}])}
        else{json!({"default_branch":"main"})};Json(body)
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let client = reqwest::Client::new();
    let auth = plugins::auth::Auth {
        token: "fixture-token".into(),
        source: "settings",
    };
    let items = plugins::gitlab::pending(&client, "acme/api", &base, &auth)
        .await
        .unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["action"]["kind"], "gitlab-play");
    assert_eq!(items[1]["cancel"]["kind"], "gitlab-cancel");
    assert!(
        plugins::gitlab::active_pipeline(&client, "acme/api", &base, &auth)
            .await
            .unwrap()
    );
    let change = plugins::gitlab::changelog(
        &client,
        "acme/api",
        &base,
        &auth,
        "production",
        "head123456",
    )
    .await
    .unwrap();
    assert_eq!(change["baseline"], "base1234");
    assert_eq!(change["commits"][0]["title"], "Ship!");
    let refs = plugins::gitlab::shipped_mrs(
        &client,
        "acme/api",
        &base,
        &auth,
        "production",
        "head123456",
        "!(\\d+)\\b",
    )
    .await
    .unwrap();
    assert_eq!(refs, vec![vec![12]]);
    server.abort();
}
