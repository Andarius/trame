mod common;
use common::TestDb;
use serde_json::json;
use trame_local::platform;

#[test]
fn platform_routes_validate_shell_boundaries_before_launch() {
    let mut t = TestDb::new();
    for (route, body, message) in [
        (
            "/api/resume",
            json!({"id":"x; touch /tmp/escaped"}),
            "invalid id",
        ),
        (
            "/api/open",
            json!({"target":"javascript:alert(1)"}),
            "invalid target",
        ),
        ("/api/resume-all", json!({"sessions":[]}), "no sessions"),
        (
            "/api/resume-all",
            json!({"sessions":[{"id":"bad","repoPath":"/"}]}),
            "no resumable sessions",
        ),
        (
            "/api/watcher/start",
            json!({"agent":"x;bad"}),
            "invalid agent",
        ),
        (
            "/api/watcher/start",
            json!({"agent":"codex","model":"x;bad"}),
            "invalid model",
        ),
    ] {
        assert_eq!(
            platform::handle(&mut t.db, 0, route, &body).unwrap(),
            (400, json!({"error":message}))
        );
    }
}

#[test]
fn resume_probe_preserves_locality_agent_and_shell_quoting() {
    let mut t = TestDb::new();
    let id = "12345678-1234-4234-8234-123456789abc";
    let probe = platform::handle(
        &mut t.db,
        0,
        "/api/resume",
        &json!({"id":id,"repoPath":"/scratch/a'b","agent":"codex","probe":true}),
    )
    .unwrap();
    assert_eq!(
        probe,
        (
            200,
            json!({"local":true,"homeNode":null,"cmd":format!("cd '/scratch/a'\\''b' && codex resume {id}"),"repo":"/scratch/a'b","agent":"codex","ok":true,"launched":false})
        )
    );
    let missing = platform::handle(&mut t.db, 0, "/api/resume", &json!({"id":id,"probe":true}))
        .unwrap()
        .1;
    assert_eq!(missing["local"], false);
    assert_eq!(missing["ok"], false);
    assert_eq!(missing["launched"], false);
    assert!(missing.get("repo").is_none());
    assert!(trame_local::sessions::handle(&mut t.db,"POST","/api/sessions","",&json!({"id":id,"title":"Resume probe","repo_path":"/scratch/repo","claude_id":"malicious; command","agent":"codex","no_event":true})).unwrap().is_err());
    t.request("POST","/api/sessions",json!({"id":id,"title":"Resume probe","repo_path":"/scratch/repo","agent":"codex","no_event":true}));
    let probe = platform::handle(&mut t.db, 0, "/api/resume", &json!({"id":id,"probe":true}))
        .unwrap()
        .1;
    assert_eq!(
        probe["cmd"],
        format!("cd '/scratch/repo' && codex resume {id}")
    );
    assert_eq!(probe["local"], false);
}
