#![allow(unsafe_code, reason = "tests mutate env vars (set_var/remove_var)")]
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
    // installed desktop apps vary per machine
    let probe = (probe.0, {
        let mut body = probe.1;
        body.as_object_mut().unwrap().remove("desktop");
        body
    });
    assert_eq!(
        probe,
        (
            200,
            json!({"local":true,"homeNode":null,"cmd":format!("cd '/scratch/a'\\''b' && codex resume {id}"),"repo":"/scratch/a'b","agent":"codex","fresh":false,"ok":true,"launched":false})
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

#[test]
fn open_in_agent_resumes_own_transcript_else_starts_with_card_context() {
    let mut t = TestDb::new();
    // a HOME without the trame skill; the skill case installs it there below
    let home = t.root.join("home");
    let real_home = std::env::var_os("HOME");
    unsafe { std::env::set_var("HOME", &home) };
    let id = "12345678-1234-4234-8234-123456789abd";
    t.request("POST","/api/sessions",json!({"id":id,"title":"Fix it's login","repo_path":"/scratch/repo","agent":"claude","branch":"fix/login","next_step":"add\n a test","no_event":true}));
    let probe = |t: &mut TestDb, open: &str| {
        platform::handle(
            &mut t.db,
            0,
            "/api/resume",
            &json!({"id":id,"probe":true,"open":open}),
        )
        .unwrap()
        .1
    };
    let prompt = format!(
        "'Work on the Trame card \"Fix it'\\''s login\" (id {id}). Next step: add a test Branch: fix/login'"
    );
    for (open, cmd) in [
        ("codex", format!("cd '/scratch/repo' && codex {prompt}")),
        ("claude", format!("cd '/scratch/repo' && claude {prompt}")),
    ] {
        let r = probe(&mut t, open);
        assert_eq!(
            (
                r["cmd"].as_str().unwrap(),
                &r["agent"],
                &r["fresh"],
                &r["ok"]
            ),
            (cmd.as_str(), &json!(open), &json!(true), &json!(true))
        );
    }
    let project = t.root.join("claude-projects/-scratch-repo");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(project.join(format!("{id}.jsonl")), "").unwrap();
    let r = probe(&mut t, "claude");
    assert_eq!(
        (r["cmd"].as_str().unwrap(), &r["fresh"]),
        (
            format!("cd '/scratch/repo' && claude --resume {id}").as_str(),
            &json!(false)
        )
    );
    assert_eq!(probe(&mut t, "codex")["fresh"], true);
    // desktop apps: Claude Desktop can't resume a CLI transcript, so it gets the card instead
    for (open, base, folder, text) in [
        ("claude", "claude://code/new", "folder", "q"),
        ("codex", "codex://threads/new", "path", "prompt"),
    ] {
        let r = platform::handle(
            &mut t.db,
            0,
            "/api/resume",
            &json!({"id":id,"probe":true,"open":open,"mode":"desktop"}),
        )
        .unwrap()
        .1;
        let url = reqwest::Url::parse(r["url"].as_str().unwrap()).unwrap();
        let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(url.as_str().split('?').next().unwrap(), base);
        assert_eq!(query[folder], "/scratch/repo");
        assert!(query[text].starts_with("Work on the Trame card \"Fix it's login\""));
        assert!(!url.as_str().contains('+'));
        assert_eq!(r["fresh"], true);
    }
    // with the trame skill installed, the agent gets `/trame <id>` (`$trame` for Codex) instead
    for dir in [".claude/skills/trame", ".agents/skills/trame"] {
        std::fs::create_dir_all(home.join(dir)).unwrap();
        std::fs::write(home.join(dir).join("SKILL.md"), "").unwrap();
    }
    let skilled = [probe(&mut t, "codex")["cmd"].clone(), {
        let r = platform::handle(
            &mut t.db,
            0,
            "/api/resume",
            &json!({"id":id,"probe":true,"open":"claude","mode":"desktop"}),
        )
        .unwrap()
        .1;
        r["url"].clone()
    }];
    if let Some(real_home) = real_home {
        unsafe { std::env::set_var("HOME", real_home) };
    }
    assert_eq!(
        skilled[0],
        format!("cd '/scratch/repo' && codex '$trame {id}'")
    );
    assert!(
        skilled[1]
            .as_str()
            .unwrap()
            .ends_with(&format!("&q=%2Ftrame%20{id}"))
    );
}
