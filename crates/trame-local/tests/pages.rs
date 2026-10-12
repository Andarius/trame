mod common;

use common::TestDb;
use serde_json::{Value, json};
use trame_local::pages;

#[allow(
    clippy::needless_pass_by_value,
    reason = "callers pass json! temporaries"
)]
fn create(t: &mut TestDb, body: Value) -> String {
    pages::create(&mut t.db, &body)
        .unwrap()
        .as_str()
        .unwrap()
        .into()
}

fn get(t: &mut TestDb, id: &str) -> Value {
    pages::get(&mut t.db, id).unwrap()
}

fn card(t: &mut TestDb, id: &Value) -> Value {
    t.db.query(
        "select * from sessions where id=$1",
        std::slice::from_ref(id),
    )
    .unwrap()
    .remove(0)
}

#[allow(
    clippy::needless_pass_by_value,
    reason = "callers pass json! temporaries"
)]
fn post(t: &TestDb, path: &str, body: Value) -> Value {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .post(format!("{}{path}", t.base_url()))
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        serde_json::from_str(&response.text().await.unwrap()).unwrap()
    })
}

fn roles() {
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        pages::add_mark_roles(vec![
            pages::MarkRule {
                mark: "tracker_us".into(),
                value: regex::Regex::new(r"^US-\d+$").unwrap(),
                role: "linked-story".into(),
            },
            pages::MarkRule {
                mark: "tracker_ref".into(),
                value: regex::Regex::new(r"^GEN-\d+$").unwrap(),
                role: "ticket".into(),
            },
        ]);
    });
}

#[test]
fn creates_content_and_resolves_home_projects_and_links() {
    let mut t = TestDb::new();
    let content = json!([
        {"type":"heading","text":"Plan","id":uuid::Uuid::new_v4().to_string()},
        {"type":"todo","text":"Ship it","done":false,"id":uuid::Uuid::new_v4().to_string()}
    ]);
    let id = create(
        &mut t,
        json!({"title":"Atomic page","kind":"page","content":content}),
    );
    let page = get(&mut t, &id);
    assert_eq!(page["title"], "Atomic page");
    assert_eq!(page["content"], content);
    let project = create(&mut t, json!({"title":"Acme","kind":"project"}));
    t.db.query("insert into sessions(title,status,client_id,repo_path) values('acme api','active',$1,'/repos/acme-api')", &[json!(project)]).unwrap();
    for path in [
        "/repos/acme-api/worktrees/feature",
        "/home/dev/Acme/other-repo",
    ] {
        let id = create(&mut t, json!({"title":"Plan","repo_path":path}));
        assert_eq!(get(&mut t, &id)["parent_id"], project);
    }
    let id = create(
        &mut t,
        json!({"title":"Sibling","repo_path":"/repos/acme-api-docs"}),
    );
    let parent = get(&mut t, &id)["parent_id"].as_str().unwrap().to_owned();
    assert_ne!(parent, project);
    assert_eq!(get(&mut t, &parent)["title"], "Side-projects");
    let id = create(
        &mut t,
        json!({"title":"Cross-project note","parent_id":null,"repo_path":"/repos/acme-api"}),
    );
    assert_eq!(get(&mut t, &id)["parent_id"], Value::Null);

    let block = uuid::Uuid::new_v4().to_string();
    let page = create(
        &mut t,
        json!({"title":"70.3 goal","kind":"story","content":[{"type":"todo","text":"Restart the pool","done":false,"id":block}]}),
    );
    let session = t.db.query("insert into sessions(title,status,repo_path) values('pool block','blocked','/repos/tri') returning id",&[]).unwrap()[0]["id"].clone();
    t.db.query("insert into session_links(session_id,page_id,block_id,anchor) values($1,$2,$3,'Restart the pool')",&[session.clone(),json!(page),json!(block)]).unwrap();
    let page = get(&mut t, &page);
    let links = page["links"].as_array().unwrap();
    assert_eq!(links.len(), 1);
    assert_eq!(links[0]["block_id"], block);
    assert_eq!(links[0]["anchor"], "Restart the pool");
    assert_eq!(links[0]["session_id"], session);
    assert_eq!(links[0]["session_title"], "pool block");
    assert_eq!(links[0]["session_status"], "blocked");
}

#[test]
#[allow(
    clippy::many_single_char_names,
    reason = "a/b/c/d are short fixture page names"
)]
fn moves_preserve_project_chips_and_reject_cycles_and_bad_anchors() {
    let mut t = TestDb::new();
    let a = create(&mut t, json!({"title":"Proj A","kind":"project"}));
    let b = create(&mut t, json!({"title":"Proj B","kind":"project"}));
    let s = create(
        &mut t,
        json!({"title":"Story","kind":"story","parent_id":a,"client_id":a}),
    );
    pages::move_page(&mut t.db, &s, &json!({"parent_id":b})).unwrap();
    let page = get(&mut t, &s);
    assert_eq!(page["parent_id"], b);
    assert_eq!(page["client_id"], b);
    let sub = create(&mut t, json!({"title":"Sub","parent_id":a}));
    pages::move_page(&mut t.db, &s, &json!({"parent_id":sub})).unwrap();
    let page = get(&mut t, &s);
    assert_eq!(page["parent_id"], sub);
    assert_eq!(page["client_id"], a);
    pages::move_page(&mut t.db, &s, &json!({"parent_id":null})).unwrap();
    let page = get(&mut t, &s);
    assert_eq!(page["parent_id"], Value::Null);
    assert_eq!(page["client_id"], Value::Null);
    let p = create(&mut t, json!({"title":"Doc","parent_id":a,"client_id":a}));
    pages::move_page(&mut t.db, &p, &json!({"parent_id":b})).unwrap();
    let page = get(&mut t, &p);
    assert_eq!(page["parent_id"], b);
    assert_eq!(page["client_id"], a);
    assert_eq!(get(&mut t, "null"), Value::Null);
    for (id, to, error) in [
        (
            &a,
            json!({"parent_id":sub}),
            "cannot move a page under itself",
        ),
        (
            &p,
            json!({"before_id":uuid::Uuid::new_v4().to_string()}),
            "anchor page not found",
        ),
    ] {
        assert_eq!(
            pages::move_page(&mut t.db, id, &to)
                .unwrap_err()
                .to_string(),
            error
        );
    }
    let x = create(&mut t, json!({"title":"X","parent_id":b}));
    let y = create(&mut t, json!({"title":"Y","parent_id":b}));
    pages::move_page(&mut t.db, &y, &json!({"before_id":x})).unwrap();
    assert!(
        get(&mut t, &y)["sort_key"].as_str().unwrap()
            < get(&mut t, &x)["sort_key"].as_str().unwrap()
    );
    pages::move_page(&mut t.db, &y, &json!({"after_id":x})).unwrap();
    assert!(
        get(&mut t, &y)["sort_key"].as_str().unwrap()
            > get(&mut t, &x)["sort_key"].as_str().unwrap()
    );
}

#[test]
fn sessions_adopt_specs_are_idempotent_and_resurrect_deterministic_cards() {
    let mut t = TestDb::new();
    let project = create(&mut t, json!({"title":"Convert Co","kind":"project"}));
    let story = create(
        &mut t,
        json!({"title":"Ship it","kind":"story","parent_id":project}),
    );
    let plan = create(
        &mut t,
        json!({"title":"  Star pages plan  ","parent_id":story}),
    );
    let converted = pages::session_from_page(&mut t.db, &plan).unwrap();
    assert_eq!(converted["created"], true);
    let row = card(&mut t, &converted["id"]);
    assert_eq!(row["specs_page_id"], plan);
    assert_eq!(row["page_id"], story);
    assert_eq!(row["client_id"], project);
    assert_eq!(get(&mut t, &plan)["kind"], "page");
    assert_eq!(row["title"], "Star pages plan");
    assert_eq!(
        post(
            &t,
            &format!(
                "/api/sessions/{}/specs-page",
                converted["id"].as_str().unwrap()
            ),
            json!({})
        )["page_id"],
        plan
    );
    assert_eq!(
        get(&mut t, &plan)["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["id"].clone())
            .collect::<Vec<_>>(),
        vec![converted["id"].clone()]
    );
    assert_eq!(
        pages::session_from_page(&mut t.db, &plan).unwrap(),
        json!({"id":converted["id"],"created":false})
    );
    t.db.query(
        "update sessions set deleted=true where id=$1",
        &[converted["id"].clone()],
    )
    .unwrap();
    assert_eq!(card(&mut t, &converted["id"])["deleted"], true);
    let revived = pages::session_from_page(&mut t.db, &plan).unwrap();
    assert_eq!(revived["id"], converted["id"]);
    assert_eq!(card(&mut t, &converted["id"])["deleted"], false);
    t.db.query(
        "delete from sessions where id=$1",
        &[converted["id"].clone()],
    )
    .unwrap();
    assert_eq!(
        pages::session_from_page(&mut t.db, &plan).unwrap()["id"],
        converted["id"]
    );
    let plan = create(&mut t, json!({"title":"Loose plan","parent_id":project}));
    let converted = pages::session_from_page(&mut t.db, &plan).unwrap();
    let row = card(&mut t, &converted["id"]);
    assert_eq!(row["page_id"], Value::Null);
    assert_eq!(row["client_id"], project);
    let orphan = create(&mut t, json!({"title":"Top-level plan","parent_id":null}));
    let converted = pages::session_from_page(&mut t.db, &orphan).unwrap();
    let row = card(&mut t, &converted["id"]);
    assert_eq!(row["page_id"], Value::Null);
    assert_eq!(row["client_id"], Value::Null);
    for id in [&project, &story] {
        assert!(
            pages::session_from_page(&mut t.db, id)
                .unwrap_err()
                .to_string()
                .contains("not a card's specs")
        );
    }
    assert!(
        pages::session_from_page(&mut t.db, &uuid::Uuid::new_v4().to_string())
            .unwrap_err()
            .to_string()
            .contains("unknown page")
    );
}

#[test]
fn hierarchy_roles_and_project_boundaries() {
    roles();
    for (kind, text, expected) in [
        ("story", "", true),
        ("story", "{{trame:tracker_ref=GEN-5}}", false),
        ("story", "{{trame:tracker_ref=OPS-5}}", true),
        ("page", "{{trame:tracker_us=US-3}}", true),
        ("page", "{{trame:tracker_us=story-3}}", false),
        ("page", "", false),
    ] {
        assert_eq!(
            pages::is_user_story(&json!({"kind":kind,"content":[{"text":text}]})),
            expected
        );
    }
    let mut t = TestDb::new();
    let project = create(&mut t, json!({"title":"Hierarchy","kind":"project"}));
    let us = create(
        &mut t,
        json!({"title":"Infra","kind":"story","parent_id":project}),
    );
    let doc = create(&mut t, json!({"title":"Plan","parent_id":us}));
    let deep = create(&mut t, json!({"title":"Notes","parent_id":doc}));
    for parent in [&us, &deep] {
        assert!(
            pages::create(
                &mut t.db,
                &json!({"title":"Nested US","kind":"story","parent_id":parent})
            )
            .unwrap_err()
            .to_string()
            .contains("cannot be nested")
        );
    }
    let other = create(
        &mut t,
        json!({"title":"Other US","kind":"story","parent_id":project}),
    );
    assert!(
        pages::move_page(&mut t.db, &other, &json!({"parent_id":deep}))
            .unwrap_err()
            .to_string()
            .contains("cannot be nested")
    );
    let folder = create(&mut t, json!({"title":"Folder","parent_id":project}));
    pages::move_page(&mut t.db, &other, &json!({"parent_id":folder})).unwrap();
    assert!(
        pages::move_page(&mut t.db, &folder, &json!({"parent_id":us}))
            .unwrap_err()
            .to_string()
            .contains("cannot be nested")
    );
    assert_eq!(get(&mut t, &folder)["parent_id"], project);
    let legacy = create(
        &mut t,
        json!({"title":"Legacy","kind":"story","parent_id":us,"content":[{"text":"{{trame:tracker_ref=GEN-900}}"}]}),
    );
    let converted = post(
        &t,
        "/api/sessions",
        json!({"title":"New ticket","page_id":deep}),
    );
    assert_eq!(card(&mut t, &converted["id"])["page_id"], us);
    assert_eq!(get(&mut t, &deep)["kind"], "page");
    pages::move_page(&mut t.db, &deep, &json!({"parent_id":legacy})).unwrap();
    assert_eq!(get(&mut t, &deep)["parent_id"], legacy);
    assert_eq!(pages::story_above(&mut t.db, &json!(deep)).unwrap(), us);
    let marked_us = create(
        &mut t,
        json!({"title":"Marked US","kind":"story","parent_id":project,"content":[{"text":"{{trame:tracker_us=US-7}}"}]}),
    );
    let marked_ticket = create(
        &mut t,
        json!({"title":"Marked ticket","kind":"story","parent_id":marked_us,"content":[{"text":"{{trame:tracker_ref=GEN-50}}"}]}),
    );
    let marked_doc = create(
        &mut t,
        json!({"title":"Marked doc","parent_id":marked_ticket}),
    );
    assert_eq!(
        pages::story_above(&mut t.db, &json!(marked_doc)).unwrap(),
        marked_us
    );
    let linked = create(
        &mut t,
        json!({"title":"Linked","parent_id":project,"content":[{"text":"{{trame:tracker_us=US-9}}"}]}),
    );
    t.db.query(
        "update pages set parent_id=$2 where id=$1",
        &[json!(linked), json!(us)],
    )
    .unwrap();
    let linked_doc = create(&mut t, json!({"title":"Linked doc","parent_id":linked}));
    assert_eq!(
        pages::story_above(&mut t.db, &json!(linked_doc)).unwrap(),
        linked
    );
    let inner = create(
        &mut t,
        json!({"title":"Inner","kind":"story","parent_id":project}),
    );
    t.db.query(
        "update pages set parent_id=$2 where id=$1",
        &[json!(inner), json!(us)],
    )
    .unwrap();
    let inner_doc = create(&mut t, json!({"title":"Inner doc","parent_id":inner}));
    assert_eq!(
        pages::story_above(&mut t.db, &json!(inner_doc)).unwrap(),
        us
    );
    let ticket = create(
        &mut t,
        json!({"title":"Ticket","kind":"story","parent_id":project,"content":[{"text":"{{trame:tracker_ref=GEN-51}}"}]}),
    );
    let ticket_doc = create(&mut t, json!({"title":"Ticket doc","parent_id":ticket}));
    assert_eq!(
        pages::story_above(&mut t.db, &json!(ticket_doc)).unwrap(),
        ticket
    );
    let boundary = create(
        &mut t,
        json!({"title":"Boundary","kind":"project","parent_id":us}),
    );
    let below = create(&mut t, json!({"title":"Below","parent_id":boundary}));
    assert_eq!(
        pages::story_above(&mut t.db, &json!(below)).unwrap(),
        Value::Null
    );
}

#[test]
fn updates_routes_story_conversion_events_and_recursive_deletion() {
    let mut t = TestDb::new();
    let project = create(&mut t, json!({"title":"Project","kind":"project"}));
    let parent = create(
        &mut t,
        json!({"title":"Folder","parent_id":project,"icon":"x","color":"red","tags":["one"]}),
    );
    let child = create(
        &mut t,
        json!({"title":"Child","parent_id":parent,"content":[{"type":"todo","done":true},{"type":"todo","done":false}]}),
    );
    for (path, body, error) in [
        (
            "/api/pages".to_owned(),
            Value::Null,
            "Cannot read properties of null (reading 'status')".to_owned(),
        ),
        (
            format!("/api/pages/{parent}"),
            Value::Null,
            "Cannot read properties of null (reading 'status')".to_owned(),
        ),
        (
            format!("/api/pages/{parent}/move"),
            Value::Null,
            "Cannot read properties of null (reading 'parent_id')".to_owned(),
        ),
        (
            format!("/api/pages/{parent}"),
            json!(true),
            "Cannot use 'in' operator to search for 'icon' in true".to_owned(),
        ),
        (
            format!("/api/pages/{parent}"),
            json!(3),
            "Cannot use 'in' operator to search for 'icon' in 3".to_owned(),
        ),
        (
            format!("/api/pages/{parent}"),
            json!("patch"),
            "Cannot use 'in' operator to search for 'icon' in patch".to_owned(),
        ),
    ] {
        assert_eq!(
            t.request("POST", &path, body),
            (400, json!({"error":error}))
        );
    }
    assert_eq!(get(&mut t, &parent)["children"][0]["todos"], 2);
    assert_eq!(get(&mut t, &parent)["children"][0]["todos_done"], 1);
    pages::update(
        &mut t.db,
        &parent,
        &json!({"icon":null,"color":null,"tags":null,"title":null,"status":"archived"}),
    )
    .unwrap();
    let row = get(&mut t, &parent);
    assert_eq!(row["icon"], Value::Null);
    assert_eq!(row["color"], Value::Null);
    assert_eq!(row["tags"], json!([]));
    assert_eq!(row["title"], "Folder");
    assert_eq!(row["status"], "archived");
    for status in [
        json!(""),
        json!("Archived"),
        json!("todo"),
        json!("in_progress"),
        json!(3),
        json!("done"),
    ] {
        assert!(pages::create(&mut t.db, &json!({"status":status})).is_err());
        assert!(pages::update(&mut t.db, &parent, &json!({"status":status})).is_err());
    }
    for content in [Value::Null, json!({}), json!("blocks")] {
        assert_eq!(
            pages::create(&mut t.db, &json!({"content":content}))
                .unwrap_err()
                .to_string(),
            "page content must be a block array"
        );
    }
    assert_eq!(
        t.request("PATCH", &format!("/api/pages/{parent}"), json!({})),
        (
            405,
            json!({"error":"PATCH not allowed; update a page with POST"})
        )
    );
    assert_eq!(
        t.request("GET", "/api/pages/null", Value::Null),
        (404, json!({"error":"not found"}))
    );
    let conversion = pages::story_from_page(&mut t.db, &parent).unwrap();
    assert_eq!(conversion, json!({"id":parent}));
    let row = get(&mut t, &parent);
    assert_eq!(row["kind"], "story");
    assert_eq!(row["parent_id"], project);
    assert_eq!(row["client_id"], project);
    assert_eq!(
        pages::story_from_page(&mut t.db, &parent).unwrap(),
        conversion
    );
    assert!(pages::story_from_page(&mut t.db, &project).is_err());
    let converted = pages::session_from_page(&mut t.db, &child).unwrap();
    assert!(
        pages::story_from_page(&mut t.db, &child)
            .unwrap_err()
            .to_string()
            .contains("card's specs")
    );
    let id = converted["id"].clone();
    t.db.query(
        "insert into session_links(session_id,page_id,block_id) values($1,$2,'one'),($1,$2,'two')",
        &[id.clone(), json!(child)],
    )
    .unwrap();
    t.db.query(
        "insert into session_events(session_id,summary) values($1,'work')",
        std::slice::from_ref(&id),
    )
    .unwrap();
    let events = pages::events(&mut t.db, &child).unwrap();
    assert_eq!(events.as_array().unwrap().len(), 1);
    assert_eq!(events[0]["summary"], "work");
    assert_eq!(events[0]["session_id"], id);
    t.db.query(
        "insert into page_comments(page_id,block_id,body) values($1,'one','note')",
        &[json!(child)],
    )
    .unwrap();
    t.db.query(
        "insert into udb_databases(page_id,name) values($1,'DB')",
        &[json!(child)],
    )
    .unwrap();
    pages::delete(&mut t.db, &parent).unwrap();
    assert_eq!(get(&mut t, &parent), Value::Null);
    assert_eq!(get(&mut t, &child), Value::Null);
    for table in ["page_comments", "udb_databases"] {
        assert_eq!(
            t.db.query(
                &format!("select deleted from {table} where page_id=$1"),
                &[json!(child)]
            )
            .unwrap()[0]["deleted"],
            true
        );
    }
    assert_eq!(card(&mut t, &id)["deleted"], false);
    assert_eq!(card(&mut t, &id)["specs_page_id"], child);
}
