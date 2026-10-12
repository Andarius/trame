mod common;
use common::TestDb;
use serde_json::{Value, json};
use trame_local::imports::{self, transcript};

fn jsonl(items: &[Value]) -> String {
    items
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}
fn codex_meta() -> Value {
    json!({"timestamp":"2026-09-03T14:11:10.515Z","type":"session_meta","payload":{"id":"01a0679a-ddad-73b0-bfbc-2f62ba0c0f86","cwd":"/home/julien/LLMS/Divers","thread_source":"user","git":{"branch":"main"}}})
}
fn context() -> Value {
    json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions\n\n<INSTRUCTIONS>..."},{"type":"input_text","text":"<environment_context>"}]}})
}
fn prompt_old() -> Value {
    json!({"timestamp":"2026-09-03T14:11:12.000Z","type":"event_msg","payload":{"type":"user_message","message":"can i host this in dedicated scaleway"}})
}
fn prompt_new() -> Value {
    json!({"timestamp":"2026-09-03T14:11:12.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"can i host this in dedicated scaleway\nmore details"}]}})
}

#[test]
fn codex_parser_keeps_original_prompt_and_activity_contract() {
    for prompt in [prompt_old(), prompt_new()] {
        let text = jsonl(&[codex_meta(), context(), prompt]);
        let meta = transcript::codex_meta(&text, &text);
        assert_eq!(meta["hasActivity"], true);
        assert_eq!(meta["firstPrompt"], "can i host this in dedicated scaleway");
        assert_eq!(meta["id"], "01a0679a-ddad-73b0-bfbc-2f62ba0c0f86");
        assert_eq!(meta["cwd"], "/home/julien/LLMS/Divers");
        assert_eq!(meta["branch"], "main");
    }
    let head = jsonl(&[codex_meta(), context()]);
    let meta = transcript::codex_meta(&head, &head);
    assert_eq!(meta["hasActivity"], false);
    assert_eq!(meta["firstPrompt"], Value::Null);
    let tail = jsonl(&[prompt_new()]);
    let meta = transcript::codex_meta(&head, &tail);
    assert_eq!(meta["hasActivity"], true);
    assert_eq!(meta["firstPrompt"], Value::Null);
    assert_eq!(meta["lastTs"], "2026-09-03T14:11:12.000Z");
}

#[test]
fn import_is_create_only_and_ignore_is_device_local() {
    let mut t = TestDb::new();
    let id = "11111111-1111-4111-8111-111111111111";
    let item = json!({"claudeId":id,"title":"alpha — Ship","repoPath":"/repo/alpha","branch":"feat/import","client":"Side-projects","project":null,"status":"active","lastActive":"2026-09-03T14:11:12.000Z"});
    let path = "/api/import/claude";
    let body = json!({"items":[item.clone(),{"claudeId":"bad","title":"invalid"}]});
    let (status, result) = imports::handle(&mut t.db, "POST", path, "", &body)
        .unwrap()
        .unwrap();
    assert_eq!(status, 200);
    assert_eq!(result, json!({"imported":1,"skipped":1,"ids":[id]}));
    let stored =
        t.db.query(
            "select title,status,claude_id,agent,last_touched from sessions where id=$1",
            &[json!(id)],
        )
        .unwrap()
        .remove(0);
    assert_eq!(stored["title"], "alpha — Ship");
    assert_eq!(stored["status"], "active");
    assert_eq!(stored["claude_id"], id);
    assert_eq!(stored["agent"], "claude");
    assert_eq!(stored["last_touched"], "2026-09-03T14:11:12.000Z");
    let events =
        t.db.query(
            "select summary from session_events where session_id=$1 and kind='import'",
            &[json!(id)],
        )
        .unwrap();
    assert_eq!(events.len(), 1);
    assert!(
        events[0]["summary"]
            .as_str()
            .unwrap()
            .contains("Imported from Claude Code")
    );
    let changed = json!({"items":[{"claudeId":id,"title":"overwrite"}]});
    assert_eq!(
        imports::handle(&mut t.db, "POST", path, "", &changed)
            .unwrap()
            .unwrap()
            .1,
        json!({"imported":0,"skipped":1,"ids":[]})
    );
    assert_eq!(
        t.db.query("select title from sessions where id=$1", &[json!(id)])
            .unwrap()[0]["title"],
        "alpha — Ship"
    );
    let ignored = imports::handle(
        &mut t.db,
        "POST",
        "/api/import/claude/ignore",
        "",
        &json!({"claudeId":id,"ignored":true,"source":"codex"}),
    )
    .unwrap()
    .unwrap()
    .1;
    assert_eq!(ignored, json!({"ignored":true}));
    assert_eq!(
        trame_local::settings::read(&t.root.join("settings.json"))["sessionIgnored"],
        json!([format!("codex:{id}")])
    );
}

#[test]
fn scan_uses_only_scratch_transcripts_and_filters_windows_and_subagents() {
    use std::{
        fs,
        time::{Duration, SystemTime},
    };
    let mut t = TestDb::new();
    let claude = t.root.join("claude-projects/-repo-alpha");
    let codex = t.root.join("codex-sessions/2026/05/20");
    fs::create_dir_all(claude.join("subagents")).unwrap();
    fs::create_dir_all(&codex).unwrap();
    let recent = "11111111-1111-4111-8111-111111111111";
    let old = "22222222-2222-4222-8222-222222222222";
    fs::write(claude.join(format!("{recent}.jsonl")),jsonl(&[
        json!({"cwd":"/repo/alpha","gitBranch":"feat/import","timestamp":chrono::Utc::now().to_rfc3339()}),
        json!({"type":"user","message":{"content":"build import"}}),
        json!({"type":"ai-title","aiTitle":"First title"}),
        json!({"type":"ai-title","aiTitle":"Ship the import feature"}),
    ])).unwrap();
    let old_path = claude.join(format!("{old}.jsonl"));
    fs::write(
        &old_path,
        jsonl(&[
            json!({"cwd":"/repo/alpha"}),
            json!({"type":"user","message":{"content":"fix flaky retry test"}}),
        ]),
    )
    .unwrap();
    let old_time = SystemTime::now() - Duration::from_hours(480);
    fs::File::options()
        .write(true)
        .open(&old_path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(old_time))
        .unwrap();
    fs::write(
        claude.join("subagents/33333333-3333-4333-8333-333333333333.jsonl"),
        jsonl(&[json!({"cwd":"/repo/alpha","type":"user","message":{"content":"subagent"}})]),
    )
    .unwrap();
    let codex_id = "66666666-6666-4666-8666-666666666666";
    let codex_path = codex.join(format!("rollout-2026-05-20-{codex_id}.jsonl"));
    fs::write(&codex_path,jsonl(&[
        json!({"type":"session_meta","payload":{"id":codex_id,"cwd":"/repo/codex-project","thread_source":"user","git":{"branch":"feat/codex-import"}}}),
        json!({"type":"event_msg","timestamp":chrono::Utc::now().to_rfc3339(),"payload":{"type":"user_message","message":"parse rollout sessions"}})
    ])).unwrap();
    assert!(imports::transcript_is_local(&t.db, "claude", recent).unwrap());
    assert!(imports::transcript_is_local(&t.db, "codex", codex_id).unwrap());
    assert!(!imports::transcript_is_local(&t.db, "claude", codex_id).unwrap());
    assert!(!imports::transcript_is_local(&t.db, "codex", "../bad").unwrap());
    let scan = |t: &mut TestDb, days: &str| {
        imports::handle(
            &mut t.db,
            "GET",
            "/api/import/claude",
            &format!("days={days}"),
            &Value::Null,
        )
        .unwrap()
        .unwrap()
        .1
    };
    let seven = scan(&mut t, "7");
    assert_eq!(seven["total"], 2);
    let thirty = scan(&mut t, "30");
    assert_eq!(thirty["total"], 3);
    let items: Vec<&Value> = thirty["groups"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|g| g["sessions"].as_array().unwrap())
        .collect();
    assert!(
        items
            .iter()
            .any(|s| s["title"] == "alpha — Ship the import feature")
    );
    assert!(
        items
            .iter()
            .any(|s| s["title"] == "alpha — fix flaky retry test")
    );
    assert!(items.iter().any(|s| s["claudeId"] == codex_id));
    assert!(
        !items
            .iter()
            .any(|s| s["claudeId"] == "33333333-3333-4333-8333-333333333333")
    );
    assert!(
        thirty["dir"]
            .as_str()
            .unwrap()
            .starts_with(t.root.to_str().unwrap())
    );
}

#[test]
fn scan_preserves_utf16_titles_equal_time_order_and_common_date_formats() {
    use std::fs;
    let mut t = TestDb::new();
    let claude = t.root.join("claude-projects/-repo-claude");
    let codex = t.root.join("codex-sessions/2026/10/12");
    fs::create_dir_all(&claude).unwrap();
    fs::create_dir_all(&codex).unwrap();
    let now = chrono::Utc::now();
    let same = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let codex_id = "11111111-1111-4111-8111-111111111111";
    fs::write(codex.join(format!("rollout-{codex_id}.jsonl")), jsonl(&[
        json!({"type":"session_meta","payload":{"id":codex_id,"cwd":"/repo/codex","thread_source":"user"}}),
        json!({"type":"event_msg","timestamp":same,"payload":{"type":"user_message","message":"Codex task"}}),
    ])).unwrap();
    let aligned = format!("{}😀xx", "a".repeat(77));
    let split = format!("{}😀x", "b".repeat(78));
    let fixtures = [
        (
            "22222222-2222-4222-8222-222222222222",
            same.clone(),
            aligned,
            format!("{}😀…", "a".repeat(77)),
        ),
        (
            "33333333-3333-4333-8333-333333333333",
            now.format("%Y-%m-%d").to_string(),
            split,
            format!("{}…", "b".repeat(78)),
        ),
        (
            "44444444-4444-4444-8444-444444444444",
            now.format("%Y-%m-%dT%H:%M:%S%z").to_string(),
            "offset time".into(),
            "offset time".into(),
        ),
        (
            "55555555-5555-4555-8555-555555555555",
            now.with_timezone(&chrono::Local)
                .format("%Y-%m-%dT%H:%M:%S")
                .to_string(),
            "local time".into(),
            "local time".into(),
        ),
    ];
    for (id, timestamp, title, _) in &fixtures {
        fs::write(claude.join(format!("{id}.jsonl")), jsonl(&[
            json!({"cwd":"/repo/claude","type":"user","timestamp":timestamp,"message":{"content":"Claude task"}}),
            json!({"type":"ai-title","aiTitle":title}),
        ])).unwrap();
    }
    let (_, response) = imports::handle(
        &mut t.db,
        "GET",
        "/api/import/claude",
        "days=7",
        &Value::Null,
    )
    .unwrap()
    .unwrap();
    assert_eq!(response["total"], 5);
    let groups = response["groups"].as_array().unwrap();
    assert_eq!(groups[0]["repoPath"], "/repo/codex");
    assert_eq!(groups[1]["repoPath"], "/repo/claude");
    let sessions = groups[1]["sessions"].as_array().unwrap();
    let by_id = |id: &str| sessions.iter().find(|s| s["claudeId"] == id).unwrap();
    for (id, _, _, expected) in &fixtures[..2] {
        assert_eq!(by_id(id)["title"], format!("claude — {expected}"));
    }
    assert_eq!(
        by_id(fixtures[1].0)["lastActive"],
        now.format("%Y-%m-%dT00:00:00.000Z").to_string()
    );
    assert_eq!(
        by_id(fixtures[2].0)["lastActive"],
        now.format("%Y-%m-%dT%H:%M:%S.000Z").to_string()
    );
    assert_eq!(
        by_id(fixtures[3].0)["lastActive"],
        now.format("%Y-%m-%dT%H:%M:%S.000Z").to_string()
    );
}
