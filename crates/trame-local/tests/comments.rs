mod common;

use base64::{Engine, engine::general_purpose::STANDARD};
use common::TestDb;
use serde_json::{Value, json};
use trame_local::{comments, pages};

const SEED_USER: &str = "00000000-0000-4000-8000-000000000101";

#[allow(
    clippy::needless_pass_by_value,
    reason = "callers pass json! temporaries"
)]
fn page(t: &mut TestDb, title: &str, content: Value) -> String {
    pages::create(&mut t.db, &json!({"title": title, "content": content}))
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned()
}

fn seed_thread(t: &mut TestDb) -> (String, String, String) {
    let block = uuid::Uuid::new_v4().to_string();
    let page = page(
        t,
        "thread",
        json!([{"type":"text","text":"the block text","id":block}]),
    );
    let agent = comments::create(
        &mut t.db,
        &json!({
            "page_id":page,"block_id":block,"body":"agent question","agent":"codex"
        }),
    )
    .unwrap();
    let reply = comments::create(
        &mut t.db,
        &json!({
            "page_id":page,"block_id":block,"body":"human reply"
        }),
    )
    .unwrap();
    t.db.query(
        "update page_comments set updated_at=updated_at-interval '1 second' where id=$1",
        &[json!(agent)],
    )
    .unwrap();
    (page, block, reply)
}

fn find(items: &Value, id: &str) -> Option<Value> {
    items
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["comment"]["id"] == id)
        .cloned()
}

fn pending(t: &mut TestDb, id: &str) -> Option<Value> {
    find(&comments::inbox(&mut t.db, 600.0, &[], false).unwrap(), id)
}

fn status(t: &mut TestDb, id: &str, value: &str) {
    comments::set_status(&mut t.db, id, &json!({"status":value,"agent":"codex"})).unwrap();
}

#[test]
fn comment_targets_resolve_without_guessing() {
    // app/agent_comments_test.ts:16–42
    let content = json!([
        {"type":"heading","text":"Plan","id":"b1"},
        {"type":"text","text":"Ship the first release safely.","id":"b2"},
        {"type":"todo","text":"Ship the first release","id":"b3"},
        {"type":"folder","path":"/tmp","id":"not-commentable"}
    ]);
    for (target, expected) in [
        (json!({"block_id":"b1"}), json!({"id":"b1","text":"Plan"})),
        (
            json!({"block_text":"Ship the first release"}),
            json!({"id":"b3","text":"Ship the first release"}),
        ),
        (
            json!({"block_text":"safely"}),
            json!({"id":"b2","text":"Ship the first release safely."}),
        ),
    ] {
        assert_eq!(
            comments::resolve_block(&content, &target).unwrap(),
            expected
        );
    }
    for (target, expected) in [
        (json!({"block_text":"Ship"}), "matches multiple blocks"),
        (json!({}), "block_id or unique block_text is required"),
    ] {
        assert!(
            comments::resolve_block(&content, &target)
                .unwrap_err()
                .to_string()
                .contains(expected)
        );
    }
}

#[test]
fn canonical_and_unbranded_agent_identities() {
    // app/agent_comments_test.ts:44–71
    let prefix = "data:image/svg+xml;base64,";
    for (agent, title, name) in [
        ("codex", "OpenAI", "Codex"),
        ("claude", "Anthropic", "Claude"),
        ("glm", "Z.ai", "GLM"),
    ] {
        let identity = comments::agent_identity(agent).unwrap();
        assert_eq!(identity["name"], name);
        let avatar = identity["avatar"].as_str().unwrap();
        assert!(avatar.contains(prefix));
        let svg = String::from_utf8(STANDARD.decode(&avatar[prefix.len()..]).unwrap()).unwrap();
        assert!(svg.contains(&format!("<title>{title}</title>")));
        assert!(svg.contains("<circle"));
        assert!(svg.contains("fill=\"white\""));
    }
    let qwen = comments::agent_identity("qwen").unwrap();
    assert_eq!(qwen["name"], "QWEN");
    assert_eq!(
        comments::agent_identity("gemini").unwrap()["name"],
        "Gemini"
    );
    let svg = String::from_utf8(
        STANDARD
            .decode(&qwen["avatar"].as_str().unwrap()[prefix.len()..])
            .unwrap(),
    )
    .unwrap();
    assert!(svg.contains("<circle"));
    assert!(svg.contains(">Q</text>"));
    assert_eq!(comments::agent_identity("QWEN").unwrap()["name"], "QWEN");
}

#[test]
fn watcher_backend_assertions() {
    let mut t = TestDb::new();

    // app/comment_watch_test.ts:62 — inbox identity, block text and thread.
    let (_, _, reply) = seed_thread(&mut t);
    let item = pending(&mut t, &reply);
    assert!(item.is_some());
    let item = item.unwrap();
    assert_eq!(item["agent"], "codex");
    assert_eq!(item["block"]["text"], "the block text");
    assert_eq!(item["thread"].as_array().unwrap().len(), 2);

    // app/comment_watch_test.ts:71 — agents never enter their own inbox.
    let p = page(
        &mut t,
        "agent-only",
        json!([{"type":"text","text":"x","id":"blk"}]),
    );
    let id = comments::create(
        &mut t.db,
        &json!({"page_id":p,"block_id":"blk","body":"just an agent note","agent":"claude"}),
    )
    .unwrap();
    assert_eq!(pending(&mut t, &id), None);

    // app/comment_watch_test.ts:88 — human first contact needs all mode.
    let p = page(
        &mut t,
        "human-only",
        json!([{"type":"text","text":"x","id":"blk"}]),
    );
    let id = comments::create(
        &mut t.db,
        &json!({"page_id":p,"block_id":"blk","body":"hi"}),
    )
    .unwrap();
    assert_eq!(pending(&mut t, &id), None);

    // app/comment_watch_test.ts:103 — all mode and page scopes.
    let p = page(
        &mut t,
        "watch-all",
        json!([{"type":"text","text":"the section","id":"blk"}]),
    );
    let id = comments::create(
        &mut t.db,
        &json!({"page_id":p,"block_id":"blk","body":"please rework this section"}),
    )
    .unwrap();
    assert_eq!(pending(&mut t, &id), None);
    let item = find(&comments::inbox(&mut t.db, 600.0, &[], true).unwrap(), &id);
    assert!(item.is_some());
    assert_eq!(item.unwrap()["agent"], "claude");
    assert_eq!(
        find(
            &comments::inbox(&mut t.db, 600.0, &[uuid::Uuid::new_v4().to_string()], true).unwrap(),
            &id
        ),
        None
    );
    assert!(find(&comments::inbox(&mut t.db, 600.0, &[p], true).unwrap(), &id).is_some());

    // app/comment_watch_test.ts:133 — a newer agent answer hides the reply.
    let (p, b, reply) = seed_thread(&mut t);
    assert!(pending(&mut t, &reply).is_some());
    comments::create(
        &mut t.db,
        &json!({"page_id":p,"block_id":b,"body":"agent answer","agent":"codex"}),
    )
    .unwrap();
    assert_eq!(pending(&mut t, &reply), None);

    // app/comment_watch_test.ts:145 — only the newest human reply remains.
    let (p, b, h1) = seed_thread(&mut t);
    let h2 = comments::create(
        &mut t.db,
        &json!({"page_id":p,"block_id":b,"body":"a second question"}),
    )
    .unwrap();
    let inbox = comments::inbox(&mut t.db, 600.0, &[], false).unwrap();
    let on_block: Vec<_> = inbox
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["comment"]["block_id"] == b)
        .collect();
    assert_eq!(on_block.len(), 1);
    assert_eq!(on_block[0]["comment"]["id"], h2);
    assert_eq!(pending(&mut t, &h1), None);

    // app/comment_watch_test.ts:170 — custom display author keeps human identity.
    let p = page(&mut t, "custom-author", json!([]));
    let id = comments::create(
        &mut t.db,
        &json!({"page_id":p,"block_id":"b","body":"hi","author":"Some Bot"}),
    )
    .unwrap();
    let row =
        t.db.query(
            "select author,author_id from page_comments where id=$1",
            &[json!(id)],
        )
        .unwrap()
        .remove(0);
    assert_eq!(row["author"], "Some Bot");
    assert_ne!(row["author_id"], comments::AGENT_AUTHOR_ID);

    // app/comment_watch_test.ts:190 — reopen retains the answered body hash.
    let (p, b, reply) = seed_thread(&mut t);
    comments::create(
        &mut t.db,
        &json!({"page_id":p,"block_id":b,"body":"agent answer","agent":"codex"}),
    )
    .unwrap();
    status(&mut t, &reply, "answered");
    assert_eq!(pending(&mut t, &reply), None);
    comments::update(&mut t.db, &reply, &json!({"resolved":true})).unwrap();
    comments::update(&mut t.db, &reply, &json!({"resolved":false})).unwrap();
    assert_eq!(pending(&mut t, &reply), None);

    // app/comment_watch_test.ts:216 — seen, edited, claimed, stale lifecycle.
    let (_, _, reply) = seed_thread(&mut t);
    status(&mut t, &reply, "seen");
    assert!(pending(&mut t, &reply).is_some());
    comments::update(&mut t.db, &reply, &json!({"body":"human reply, edited"})).unwrap();
    assert!(pending(&mut t, &reply).is_some());
    status(&mut t, &reply, "answering");
    assert_eq!(pending(&mut t, &reply), None);
    t.db.query("update comment_agent_status set updated_at=now()-interval '30 minutes' where comment_id=$1", &[json!(reply)]).unwrap();
    assert!(pending(&mut t, &reply).is_some());

    // app/comment_watch_test.ts:240 — resolving without an edit stays answered.
    let (_, _, reply) = seed_thread(&mut t);
    status(&mut t, &reply, "answered");
    comments::update(&mut t.db, &reply, &json!({"resolved":true})).unwrap();
    assert_eq!(pending(&mut t, &reply), None);
    comments::update(&mut t.db, &reply, &json!({"resolved":false})).unwrap();
    assert_eq!(pending(&mut t, &reply), None);

    // app/comment_watch_test.ts:253 — list joins and clear status tombstone.
    let (p, _, reply) = seed_thread(&mut t);
    status(&mut t, &reply, "answering");
    let listed = comments::list(&mut t.db, &p).unwrap();
    let row = listed
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == reply)
        .unwrap();
    assert_eq!(row["agent_status"], "answering");
    assert_eq!(row["agent_status_agent"], "codex");
    comments::set_status(&mut t.db, &reply, &json!({"status":"clear"})).unwrap();
    let listed = comments::list(&mut t.db, &p).unwrap();
    assert_eq!(
        listed
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == reply)
            .unwrap()["agent_status"],
        Value::Null
    );

    // app/comment_watch_test.ts:270 — nonexistent comments cannot be claimed.
    assert!(
        comments::set_status(
            &mut t.db,
            &uuid::Uuid::new_v4().to_string(),
            &json!({"status":"seen"})
        )
        .is_err()
    );
}

#[test]
fn backend_comment_identity_and_meta_assertions() {
    let mut t = TestDb::new();
    let p = page(&mut t, "identity page", json!([]));

    // app/identity_test.ts:44 — canonical human owner and display name.
    let id = comments::create(
        &mut t.db,
        &json!({"page_id":p,"block_id":"b1","body":"hello"}),
    )
    .unwrap();
    let row =
        t.db.query(
            "select author,author_id from page_comments where id=$1",
            &[json!(id)],
        )
        .unwrap()
        .remove(0);
    assert_eq!(row["author_id"], SEED_USER);
    assert!(!row["author"].as_str().unwrap().is_empty());

    // app/identity_test.ts:63 — agent snapshot and reserved identity.
    let id = comments::create(
        &mut t.db,
        &json!({"page_id":p,"block_id":"b-agent","body":"review note","agent":"codex"}),
    )
    .unwrap();
    let row =
        t.db.query(
            "select author,author_avatar,author_id from page_comments where id=$1",
            &[json!(id)],
        )
        .unwrap()
        .remove(0);
    assert_eq!(row["author"], "Codex");
    assert_eq!(row["author_id"], comments::AGENT_AUTHOR_ID);
    assert!(
        row["author_avatar"]
            .as_str()
            .unwrap()
            .starts_with("data:image/svg+xml;base64,")
    );

    // app/identity_test.ts:93 — agent model fallback, explicit stats, human null.
    let mut metas = Vec::new();
    for patch in [
        json!({"agent":"codex"}),
        json!({"agent":"claude","meta":{"model":"claude-opus-5","out":42}}),
        json!({}),
    ] {
        let mut body = json!({"page_id":p,"block_id":"b-meta","body":"note"});
        body.as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        let id = comments::create(&mut t.db, &body).unwrap();
        metas.push(
            t.db.query("select meta from page_comments where id=$1", &[json!(id)])
                .unwrap()
                .remove(0)["meta"]
                .clone(),
        );
    }
    assert_eq!(
        serde_json::from_str::<Value>(metas[0].as_str().unwrap()).unwrap(),
        json!({"model":"codex"})
    );
    assert_eq!(
        serde_json::from_str::<Value>(metas[1].as_str().unwrap()).unwrap(),
        json!({"model":"claude-opus-5","out":42})
    );
    assert_eq!(metas[2], Value::Null);
}

#[test]
fn comment_routes_and_get_inbox_cleanup_log_their_writes() {
    let mut t = TestDb::new();
    let p = page(
        &mut t,
        "route thread",
        json!([{"type":"text","id":"b","text":"section"}]),
    );
    assert_eq!(
        t.request("GET", "/api/comments", Value::Null),
        (200, json!([]))
    );
    let (code, body) = t.request(
        "POST",
        "/api/comments",
        json!({"page_id":p,"block_id":"b","body":"review"}),
    );
    assert_eq!(code, 200);
    let id = body["id"].as_str().unwrap();
    assert_eq!(
        t.request(
            "POST",
            &format!("/api/comments/{id}/agent-status"),
            json!({"status":"bogus"})
        ),
        (400, json!({"error":"invalid status"}))
    );
    assert_eq!(
        t.request(
            "POST",
            &format!("/api/comments/{id}/agent-status"),
            json!({"status":"answering","agent":"codex"})
        ),
        (200, json!({"ok":true}))
    );
    let (code, listed) = t.request("GET", &format!("/api/comments?page={p}"), Value::Null);
    assert_eq!(code, 200);
    assert_eq!(listed[0]["agent_status"], "answering");
    assert_eq!(listed[0]["agent_status_agent"], "codex");
    assert_eq!(
        t.request("POST", &format!("/api/comments/{id}/delete"), Value::Null),
        (200, json!({"ok":true}))
    );
    let before =
        t.db.query("select max(rev) as rev from change_log", &[])
            .unwrap()[0]["rev"]
            .as_i64()
            .unwrap();
    assert_eq!(
        t.request(
            "GET",
            &format!("/api/comments/inbox?mode=all&page={p}&stale=bad"),
            Value::Null
        ),
        (200, json!([]))
    );
    let rows =
        t.db.query(
            "select deleted,origin from comment_agent_status where id=$1",
            &[json!(id)],
        )
        .unwrap();
    assert_eq!(rows[0]["deleted"], true);
    assert_eq!(rows[0]["origin"], "rust-slice2-test");
    let log =
        t.db.query(
            "select entity,op from change_log where rev>$1 order by rev",
            &[json!(before)],
        )
        .unwrap();
    assert_eq!(
        log,
        vec![json!({"entity":"comment_agent_status","op":"delete"})]
    );
    let (code, _) = t.request(
        "GET",
        &format!("/api/comments/inbox?mode=all&page={p}"),
        Value::Null,
    );
    assert_eq!(code, 200);
    assert_eq!(
        t.db.query(
            "select entity,op from change_log where rev>$1 order by rev",
            &[json!(before)]
        )
        .unwrap(),
        log
    );
}
