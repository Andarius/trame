mod common;

use common::TestDb;
use serde_json::{Value, json};
use trame_local::{pages, sessions};

fn card(t: &mut TestDb, id: &str) -> Value {
    t.db.query("select * from sessions where id=$1", &[json!(id)])
        .unwrap()
        .remove(0)
}

fn create(t: &mut TestDb, body: Value) -> String {
    sessions::upsert(&mut t.db, &body, None)
        .unwrap()
        .as_str()
        .unwrap()
        .into()
}

#[test]
fn planned_cards_adopt_only_their_story_and_keep_partial_fields() {
    let mut t = TestDb::new();
    let project = pages::resolve_client(&mut t.db, "Adopt Project").unwrap();
    let story = sessions::resolve_story(&mut t.db, "Card sweep", &project, &[], None).unwrap();
    let plan = create(
        &mut t,
        json!({"title":"planned","status":"paused","client_id":project,"page_id":story,"repo_path":"/tmp/adopt-sessions-rust","next_step":"keep me"}),
    );
    let other = create(
        &mut t,
        json!({"title":"other","repo_path":"/tmp/adopt-sessions-rust","branch":"fix/other","story":"Unrelated goal"}),
    );
    assert_ne!(other, plan);
    assert!(card(&mut t, &plan)["branch"].is_null());
    let adopted = create(
        &mut t,
        json!({"title":"Card sweep","repo_path":"/tmp/adopt-sessions-rust","branch":"feat/sweep","client":"Adopt Project","story":"card sweep"}),
    );
    assert_eq!(adopted, plan);
    let after = card(&mut t, &plan);
    assert_eq!(after["branch"], "feat/sweep");
    assert_eq!(after["page_id"], story);
    assert_eq!(after["next_step"], "keep me");
    create(&mut t, json!({"id":plan,"status":"active","pr_url":null}));
    let after = card(&mut t, &plan);
    assert_eq!(after["title"], "Card sweep");
    assert_eq!(after["repo_path"], "/tmp/adopt-sessions-rust");
    assert_eq!(after["pr_url"], Value::Null);
}

#[test]
fn get_session_resolves_links_events_and_harness_id() {
    let mut t = TestDb::new();
    let project = pages::resolve_client(&mut t.db, "Session Read").unwrap();
    let story = sessions::resolve_story(&mut t.db, "Ship", &project, &[], None).unwrap();
    let harness = uuid::Uuid::new_v4().to_string();
    let id = create(
        &mut t,
        json!({"title":"Card","client_id":project,"page_id":story,"agent_id":harness,"branch":"feat/read","next_step":"wire callback"}),
    );
    let spec = sessions::handle(
        &mut t.db,
        "POST",
        &format!("/api/sessions/{id}/specs-page"),
        "",
        &Value::Null,
    )
    .unwrap()
    .unwrap()
    .1["page_id"]
        .clone();
    assert!(
        pages::get(&mut t.db, spec.as_str().unwrap())
            .unwrap()
            .is_object()
    );
    pages::update(&mut t.db,spec.as_str().unwrap(),&json!({"content":[{"type":"heading","level":2,"text":"Goal"},{"type":"text","text":"Token exchange"}]})).unwrap();
    sessions::handle(
        &mut t.db,
        "POST",
        &format!("/api/sessions/{id}/links"),
        "",
        &json!({"page_id":story,"anchor":"Ship"}),
    )
    .unwrap()
    .unwrap();
    for summary in ["first", "second", "third"] {
        sessions::handle(
            &mut t.db,
            "POST",
            &format!("/api/sessions/{id}/events"),
            "",
            &json!({"summary":summary}),
        )
        .unwrap()
        .unwrap();
    }
    let card = sessions::get_session(&mut t.db, &harness, 2).unwrap();
    assert_eq!(card["project"], json!({"id":project,"name":"Session Read"}));
    assert_eq!(card["story"]["title"], "Ship");
    assert_eq!(card["branch"], "feat/read");
    assert_eq!(card["next_step"], "wire callback");
    assert!(card["specs"].as_str().unwrap().contains("Token exchange"));
    assert_eq!(card["activity_total"], 3);
    assert_eq!(card["activity"].as_array().unwrap().len(), 2);
    for (query, count) in [
        ("events=0x2", 2),
        ("events=2.0", 2),
        ("events=bad", 3),
        ("events=0", 3),
    ] {
        let response = sessions::handle(
            &mut t.db,
            "GET",
            &format!("/api/sessions/{id}"),
            query,
            &Value::Null,
        )
        .unwrap()
        .unwrap();
        assert_eq!(response.1["activity"].as_array().unwrap().len(), count);
    }
    assert_eq!(card["links"][0]["anchor"], "Ship");
    assert_eq!(card["specs_page_id"], spec);
    sessions::handle(
        &mut t.db,
        "POST",
        &format!("/api/sessions/{id}/delete"),
        "",
        &Value::Null,
    )
    .unwrap()
    .unwrap();
    assert!(sessions::get_session(&mut t.db, &id, 20).unwrap().is_null());
}

#[test]
fn tags_statuses_and_invalid_tags_preserve_card_integrity() {
    let mut t = TestDb::new();
    let id = create(
        &mut t,
        json!({"title":"Tagged","tags":["Priority:P1","priority-p1"]}),
    );
    assert_eq!(card(&mut t, &id)["tags"], json!(["priority-p1"]));
    for tags in [json!(null), json!([""]), json!([42])] {
        assert!(
            sessions::upsert(&mut t.db, &json!({"id":id,"title":"bad","tags":tags}), None).is_err()
        );
        assert_eq!(card(&mut t, &id)["title"], "Tagged");
    }
    let tag = sessions::handle(
        &mut t.db,
        "POST",
        "/api/tags",
        "",
        &json!({"label":"Team: DévOps"}),
    )
    .unwrap()
    .unwrap()
    .1;
    let again = sessions::handle(
        &mut t.db,
        "POST",
        "/api/tags",
        "",
        &json!({"label":"Team: DévOps"}),
    )
    .unwrap()
    .unwrap()
    .1;
    assert_eq!(tag, again);
    assert_eq!(tag["key"], "team-devops");
    let status = sessions::handle(
        &mut t.db,
        "POST",
        "/api/statuses",
        "",
        &json!({"label":"Review","color":"#56b6c2"}),
    )
    .unwrap()
    .unwrap()
    .1["id"]
        .clone();
    let again = sessions::handle(
        &mut t.db,
        "POST",
        "/api/statuses",
        "",
        &json!({"label":"Review","color":"#7a9ee7"}),
    )
    .unwrap()
    .unwrap()
    .1["id"]
        .clone();
    assert_ne!(status, again);
    sessions::handle(
        &mut t.db,
        "POST",
        &format!("/api/statuses/{}/delete", status.as_str().unwrap()),
        "",
        &Value::Null,
    )
    .unwrap()
    .unwrap();
    assert!(
        t.db.query("select id from statuses where id=$1 and deleted", &[status])
            .unwrap()
            .len()
            == 1
    );
}

#[test]
fn due_and_presence_validate_real_blocks() {
    let mut t = TestDb::new();
    let page=pages::create(&mut t.db,&json!({"title":"Due","content":[{"type":"todo","id":"a1","text":"Bump {{trame:due=2026-10-13}}","done":false},{"type":"todo","id":"a2","text":"Old {{trame:due=2026-10-01}}","done":true}]})).unwrap();
    let due = sessions::list_due(&mut t.db).unwrap();
    let found = due
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["page_id"] == page)
        .unwrap();
    assert_eq!(found["text"], "Bump");
    assert_eq!(found["due"], "2026-10-13");
    let id = create(&mut t, json!({"title":"Presence"}));
    let route = format!("/api/sessions/{id}/presence");
    assert_eq!(
        sessions::handle(
            &mut t.db,
            "POST",
            &route,
            "",
            &json!({"state":"busy","harness":"codex"})
        )
        .unwrap()
        .unwrap()
        .0,
        400
    );
    assert_eq!(
        sessions::handle(
            &mut t.db,
            "POST",
            &route,
            "",
            &json!({"state":"working","harness":"codex","page_id":page,"block_id":"missing"})
        )
        .unwrap()
        .unwrap()
        .0,
        400
    );
    let result = sessions::handle(
        &mut t.db,
        "POST",
        &route,
        "",
        &json!({"state":"working","harness":"codex","page_id":page,"block_id":"a1"}),
    )
    .unwrap()
    .unwrap();
    assert_eq!(result.0, 200);
    assert_eq!(result.1["page_id"], page);
    assert_eq!(
        sessions::list_agent_presence(&mut t.db)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn story_similarity_matches_original_bands() {
    for (a, b, min, max) in [
        (
            "staging cutover saas-dev",
            "Staging cutover (saas-ops → saas-dev)",
            0.8,
            1.01,
        ),
        (
            "CI sur la capacité dev",
            "CI sur la capacite dev",
            0.8,
            1.01,
        ),
        (
            "CI sur la capacite dev (roadmap 7)",
            "Migration Soren — étape 7 : CI sur la capacité dev",
            0.5,
            0.8,
        ),
        ("GEN-7145 — Soren infra", "Soren infra", 0.8, 1.01),
        ("Monitoring", "Alerting configuration", 0.0, 0.5),
    ] {
        let score = trame_local::sessions::story_similarity(a, b);
        assert!(score >= min && score < max, "{a}: {b}: {score}");
    }
    let hits = sessions::similar_stories(
        "soren-dev cutover",
        vec![
            json!({"id":"1","title":"Monitoring"}),
            json!({"id":"2","title":"Migration soren-dev"}),
            json!({"id":"3","title":"soren-dev cutover plan"}),
        ],
        0.5,
    );
    assert_eq!(
        hits.iter()
            .map(|h| h["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["3", "2"]
    );
}

#[test]
fn status_delete_reassigns_cards_and_refuses_the_last_column() {
    let mut t = TestDb::new();
    let statuses =
        t.db.query(
            "select id,key from statuses where not deleted order by sort_key",
            &[],
        )
        .unwrap();
    assert_eq!(
        statuses
            .iter()
            .map(|r| r["key"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["todo", "active", "paused", "blocked", "done"]
    );
    let active = statuses.iter().find(|r| r["key"] == "active").unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let id = create(&mut t, json!({"title":"Needs a column"}));
    assert_eq!(card(&mut t, &id)["status"], "active");
    let path = format!("/api/statuses/{active}/delete");
    assert_eq!(
        sessions::handle(&mut t.db, "POST", &path, "", &Value::Null)
            .unwrap()
            .unwrap()
            .0,
        200
    );
    assert_eq!(card(&mut t, &id)["status"], "todo");
    let next = create(&mut t, json!({"title":"Fallback default"}));
    assert_eq!(card(&mut t, &next)["status"], "todo");
    let remaining =
        t.db.query("select id from statuses where not deleted", &[])
            .unwrap();
    for row in remaining.iter().skip(1) {
        let path = format!("/api/statuses/{}/delete", row["id"].as_str().unwrap());
        assert_eq!(
            sessions::handle(&mut t.db, "POST", &path, "", &Value::Null)
                .unwrap()
                .unwrap()
                .0,
            200
        );
    }
    let last = remaining[0]["id"].as_str().unwrap();
    assert_eq!(
        sessions::handle(
            &mut t.db,
            "POST",
            &format!("/api/statuses/{last}/delete"),
            "",
            &Value::Null
        )
        .unwrap()
        .unwrap(),
        (400, json!({"error":"cannot delete the last status"}))
    );
    assert_eq!(
        t.db.query("select id from statuses where not deleted", &[])
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn story_resolution_reuses_unfiled_page_and_keeps_project_boundaries() {
    let mut t = TestDb::new();
    let a = pages::resolve_client(&mut t.db, "Story A").unwrap();
    let b = pages::resolve_client(&mut t.db, "Story B").unwrap();
    let first = sessions::resolve_story(&mut t.db, "Ship the Feature", &a, &[], None).unwrap();
    assert_eq!(
        sessions::resolve_story(&mut t.db, "  ship   the feature ", &a, &[], None).unwrap(),
        first
    );
    let other = sessions::resolve_story(&mut t.db, "Ship the Feature", &b, &[], None).unwrap();
    assert_ne!(other, first);
    let plain = pages::create(&mut t.db, &json!({"title":"Loose notes"})).unwrap();
    assert_eq!(
        sessions::resolve_story(&mut t.db, "loose notes", &a, &[], None).unwrap(),
        plain
    );
    assert_eq!(
        pages::get(&mut t.db, plain.as_str().unwrap()).unwrap()["kind"],
        "page"
    );
    let id = create(
        &mut t,
        json!({"title":"Promote","client_id":a,"story":"Loose notes"}),
    );
    assert_eq!(card(&mut t, &id)["page_id"], plain);
    assert_eq!(
        pages::get(&mut t.db, plain.as_str().unwrap()).unwrap()["kind"],
        "story"
    );
    let parent = pages::create(&mut t.db, &json!({"title":"Features hub"})).unwrap();
    let nested = pages::create(
        &mut t.db,
        &json!({"title":"Nested topic","parent_id":parent}),
    )
    .unwrap();
    let mut note = String::new();
    let id = sessions::upsert(
        &mut t.db,
        &json!({"title":"Nested","client_id":a,"story":"Nested topic"}),
        Some(&mut note),
    )
    .unwrap();
    assert_ne!(card(&mut t, id.as_str().unwrap())["page_id"], nested);
    assert!(note.contains(nested.as_str().unwrap()));
    assert_eq!(
        pages::get(&mut t.db, nested.as_str().unwrap()).unwrap()["kind"],
        "page"
    );
    let near_a = create(
        &mut t,
        json!({"title":"a","client":"Similar Project","story":"Staging cutover (saas-ops → saas-dev)"}),
    );
    let mut near_note = String::new();
    let near_b = sessions::upsert(
        &mut t.db,
        &json!({"title":"b","client":"Similar Project","story":"staging cutover saas-dev"}),
        Some(&mut near_note),
    )
    .unwrap();
    assert_eq!(
        card(&mut t, &near_a)["page_id"],
        card(&mut t, near_b.as_str().unwrap())["page_id"]
    );
    assert!(near_note.starts_with("matched existing story"));
}

#[test]
fn specs_page_id_is_stable_and_deleted_page_is_resurrected() {
    let mut t = TestDb::new();
    let project = pages::resolve_client(&mut t.db, "Specs Project").unwrap();
    let story = sessions::resolve_story(&mut t.db, "Spec story", &project, &[], None).unwrap();
    let id = create(
        &mut t,
        json!({"title":"Spec card","client_id":project,"page_id":story}),
    );
    let route = format!("/api/sessions/{id}/specs-page");
    let spec = sessions::handle(&mut t.db, "POST", &route, "", &Value::Null)
        .unwrap()
        .unwrap()
        .1["page_id"]
        .clone();
    let want = uuid::Uuid::new_v5(
        &uuid::uuid!("b2f6c1d8-4e5a-4b7c-8f1d-2a9e6c3b0d47"),
        id.as_bytes(),
    )
    .to_string();
    assert_eq!(spec, want);
    assert_eq!(
        sessions::handle(&mut t.db, "POST", &route, "", &Value::Null)
            .unwrap()
            .unwrap()
            .1["page_id"],
        spec
    );
    assert_eq!(
        pages::get(&mut t.db, spec.as_str().unwrap()).unwrap()["parent_id"],
        story
    );
    pages::delete(&mut t.db, spec.as_str().unwrap()).unwrap();
    assert_eq!(
        sessions::handle(&mut t.db, "POST", &route, "", &Value::Null)
            .unwrap()
            .unwrap()
            .1["page_id"],
        spec
    );
    assert_eq!(
        pages::get(&mut t.db, spec.as_str().unwrap()).unwrap()["deleted"],
        false
    );
    let missing = uuid::Uuid::new_v4().to_string();
    assert!(
        sessions::handle(
            &mut t.db,
            "POST",
            &format!("/api/sessions/{missing}/specs-page"),
            "",
            &Value::Null
        )
        .unwrap()
        .is_err()
    );
}

#[test]
fn branch_history_and_terminal_cards_control_adoption() {
    let mut t = TestDb::new();
    let harness = uuid::Uuid::new_v4().to_string();
    let first = create(
        &mut t,
        json!({"title":"cutover","claude_id":harness,"repo_path":"/tmp/branch-history","branch":"feat/a","story":"Staging cutover","pr_url":"https://example.invalid/1"}),
    );
    let second = create(
        &mut t,
        json!({"title":"cutover","claude_id":harness,"repo_path":"/tmp/branch-other","branch":"feat/b","story":"Staging cutover","pr_url":"https://example.invalid/2"}),
    );
    assert_eq!(second, first);
    assert_eq!(card(&mut t, &first)["branches"], "feat/a\nfeat/b");
    assert_eq!(
        card(&mut t, &first)["pr_url"],
        "https://example.invalid/1\nhttps://example.invalid/2"
    );
    let different = create(
        &mut t,
        json!({"title":"other","claude_id":harness,"repo_path":"/tmp/branch-other","branch":"feat/c","story":"Other goal"}),
    );
    assert_ne!(different, first);
    assert_eq!(
        create(
            &mut t,
            json!({"title":"manual","repo_path":"/tmp/branch-other","branch":"feat/b"})
        ),
        first
    );
    sessions::handle(
        &mut t.db,
        "POST",
        &format!("/api/sessions/{first}/status"),
        "",
        &json!({"status":"done"}),
    )
    .unwrap()
    .unwrap();
    let new = create(
        &mut t,
        json!({"title":"cutover again","claude_id":harness,"repo_path":"/tmp/branch-other","branch":"feat/d","story":"Staging cutover"}),
    );
    assert_ne!(new, first);
    assert_eq!(card(&mut t, &first)["status"], "done");
    create(
        &mut t,
        json!({"id":first,"pr_url":"https://example.invalid/2"}),
    );
    assert_eq!(card(&mut t, &first)["pr_url"], "https://example.invalid/2");
}

#[test]
fn tag_label_color_and_due_window_match_typescript_cases() {
    for (label, want) in [
        ("team:devops", json!({"ns":"team","value":"devops"})),
        ("infra", json!({"ns":null,"value":"infra"})),
        ("team : devops", json!({"ns":"team","value":"devops"})),
        (":devops", json!({"ns":null,"value":":devops"})),
        ("team:", json!({"ns":null,"value":"team:"})),
        ("a:b:c", json!({"ns":"a","value":"b:c"})),
    ] {
        assert_eq!(sessions::split_tag_label(label), want);
    }
    let palette = [
        "#6b7280", "#c98a63", "#e3c567", "#7bd88f", "#5fc2b0", "#6aa9e0", "#a78bd8", "#dd8ab8",
        "#e06c75",
    ];
    for key in ["a", "infra", "team-devops", "", "zzz-9"] {
        assert_eq!(sessions::tag_color(key), sessions::tag_color(key));
        assert!(palette.contains(&sessions::tag_color(key)));
    }
    assert_eq!(sessions::tag_key("Team: DévOps"), "team-devops");
    for (date, days, shown) in [
        ("2026-10-06", -3, true),
        ("2026-10-09", 0, true),
        ("2026-10-16", 7, true),
        ("2026-10-17", 8, false),
    ] {
        assert_eq!(sessions::days_until(date, "2026-10-09").unwrap(), days);
        assert_eq!(sessions::shown_due(date, "2026-10-09").unwrap(), shown);
    }
}

#[test]
fn default_story_tags_obey_repo_whitelist_and_only_stamp_new_pages() {
    let map = json!({"Obitrain":"Obitrain","Work":{"project":"Soren","tags":["Infra"],"repos":["sre-config"]}});
    for (path, want) in [
        ("/home/me/Projects/Obitrain/obiapp", "Obitrain"),
        ("/home/me/Projects/Work/sre-config", "Soren"),
        ("/home/me/Projects/trame", "Side-projects"),
        ("/home/me/Projects/Work/track-backend", "Soren"),
        (
            "/tmp/claude-1000/-home-me-Projects-Work-sops/abc/scratchpad/wt-x",
            "Soren",
        ),
        ("/data/my-Work-notes", "Side-projects"),
    ] {
        assert_eq!(sessions::client_for(path, &map), want);
    }
    for path in [
        "/home/me/Projects/Work/sre-config",
        "/home/me/Projects/Work/sre-config/packages/sctl",
        "/tmp/claude-1000/-home-me-Work-sre-config/x/wt-a",
    ] {
        assert_eq!(sessions::default_tags_for(path, &map), vec!["Infra"]);
    }
    assert_eq!(
        sessions::default_tags_for("/home/me/Projects/Work/track-backend", &map),
        Vec::<String>::new()
    );
    let mut t = TestDb::new();
    let project = pages::resolve_client(&mut t.db, "Tag project").unwrap();
    let story = sessions::resolve_story(
        &mut t.db,
        "Blackbox probes",
        &project,
        &["Infra".into()],
        None,
    )
    .unwrap();
    let row = pages::get(&mut t.db, story.as_str().unwrap()).unwrap();
    assert_eq!(row["tags"], json!(["infra"]));
    assert_eq!(
        t.db.query(
            "select label from tags where key='infra' and not deleted",
            &[]
        )
        .unwrap()[0]["label"],
        "Infra"
    );
    assert_eq!(
        sessions::resolve_story(
            &mut t.db,
            "blackbox probes",
            &project,
            &["Different".into()],
            None
        )
        .unwrap(),
        story
    );
    assert_eq!(
        pages::get(&mut t.db, story.as_str().unwrap()).unwrap()["tags"],
        json!(["infra"])
    );
}

#[test]
fn unknown_routes_stay_on_the_proxy_and_get_fallbacks_are_exact() {
    for (method, path, want) in [
        ("GET", "/api/stories", false),
        ("POST", "/api/stories", true),
        ("GET", "/api/statuses", false),
        ("POST", "/api/statuses", true),
        ("GET", "/api/tags", true),
        ("PUT", "/api/tags", true),
        ("GET", "/api/sessions", false),
        ("GET", "/api/sessions/abc/events", true),
        ("GET", "/api/sessions/abc/specs-page", false),
        ("POST", "/api/sessions/abc/specs-page", true),
        ("GET", "/api/reports", false),
    ] {
        assert_eq!(sessions::owns(method, path), want, "{method} {path}");
    }
}

#[test]
fn track_event_dedupe_and_page_feed_keep_agent_and_link_boundaries() {
    let mut t = TestDb::new();
    let page = pages::create(&mut t.db, &json!({"title":"Feed"})).unwrap();
    let other = pages::create(&mut t.db, &json!({"title":"Elsewhere"})).unwrap();
    let a = create(&mut t, json!({"title":"a — one","status":"active"}));
    let b = create(&mut t, json!({"title":"b — two","status":"done"}));
    let off = create(&mut t, json!({"title":"off — elsewhere","status":"active"}));
    for (id, p, anchor) in [
        (&a, &page, "first task"),
        (&a, &page, "second task"),
        (&b, &page, "third task"),
        (&off, &other, "not here"),
    ] {
        sessions::handle(
            &mut t.db,
            "POST",
            &format!("/api/sessions/{id}/links"),
            "",
            &json!({"page_id":p,"anchor":anchor}),
        )
        .unwrap()
        .unwrap();
    }
    for (id, summary, agent) in [
        (&a, "a1", "claude"),
        (&b, "b1", "codex"),
        (&a, "a2", "claude"),
        (&off, "off1", "codex"),
    ] {
        if id == &a {
            sessions::handle(
                &mut t.db,
                "POST",
                "/api/sessions",
                "",
                &json!({"id":id,"summary":summary,"agent":agent}),
            )
            .unwrap()
            .unwrap();
        } else {
            sessions::handle(
                &mut t.db,
                "POST",
                &format!("/api/sessions/{id}/events"),
                "",
                &json!({"summary":summary,"agent":agent}),
            )
            .unwrap()
            .unwrap();
        }
    }
    let feed = pages::events(&mut t.db, page.as_str().unwrap()).unwrap();
    let rows = feed.as_array().unwrap();
    assert_eq!(
        rows.iter()
            .map(|r| r["summary"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["a2", "b1", "a1"]
    );
    assert_eq!(
        rows.iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect::<std::collections::HashSet<_>>()
            .len(),
        3
    );
    assert_eq!(
        rows.iter().find(|r| r["summary"] == "b1").unwrap()["session_title"],
        "b — two"
    );
    assert_eq!(
        rows.iter().find(|r| r["summary"] == "b1").unwrap()["session_status"],
        "done"
    );
    assert!(!rows.iter().any(|r| r["session_id"] == off));

    let post = |t: &mut TestDb, summary: &str, agent: &str| {
        sessions::handle(
            &mut t.db,
            "POST",
            "/api/sessions",
            "",
            &json!({"id":a,"summary":summary,"agent":agent}),
        )
        .unwrap()
        .unwrap()
    };
    post(&mut t, "a2", "claude");
    assert_eq!(
        sessions::get_session(&mut t.db, &a, 20).unwrap()["activity_total"],
        2
    );
    post(&mut t, "a3", "claude");
    assert_eq!(
        sessions::get_session(&mut t.db, &a, 20).unwrap()["activity_total"],
        3
    );
    for _ in 0..2 {
        sessions::handle(
            &mut t.db,
            "POST",
            &format!("/api/sessions/{a}/events"),
            "",
            &json!({"summary":"a3"}),
        )
        .unwrap()
        .unwrap();
    }
    assert_eq!(
        sessions::get_session(&mut t.db, &a, 20).unwrap()["activity_total"],
        5
    );
    post(&mut t, "a3", "codex");
    assert_eq!(
        sessions::get_session(&mut t.db, &a, 20).unwrap()["activity_total"],
        6
    );
    sessions::handle(
        &mut t.db,
        "POST",
        &format!("/api/sessions/{a}/events"),
        "",
        &json!({"summary":"a4"}),
    )
    .unwrap()
    .unwrap();
    post(&mut t, "a4", "claude");
    assert_eq!(
        sessions::get_session(&mut t.db, &a, 20).unwrap()["activity_total"],
        8
    );
    post(&mut t, "a4", "codex");
    assert_eq!(
        sessions::get_session(&mut t.db, &a, 20).unwrap()["activity_total"],
        9
    );
}

#[test]
fn agent_presence_validates_normalizes_and_tracks_state_start() {
    for raw in [
        json!({"state":"busy","harness":"codex"}),
        json!({"harness":"codex"}),
        json!({"state":"working"}),
        json!({"state":"working","harness":"  "}),
    ] {
        assert!(
            sessions::touch_agent_presence(&uuid::Uuid::new_v4().to_string(), &raw, 1_000).is_err()
        );
    }
    let id = uuid::Uuid::new_v4().to_string();
    let first = sessions::touch_agent_presence(
        &id,
        &json!({"state":"working","harness":"codex","page_id":"p1","block_id":"b1"}),
        1_000,
    )
    .unwrap();
    let same =
        sessions::touch_agent_presence(&id, &json!({"state":"working","harness":"codex"}), 5_000)
            .unwrap();
    assert_eq!(first["since"], 1_000);
    assert_eq!(same["since"], 1_000);
    assert_eq!(same["at"], 5_000);
    assert_eq!(same["page_id"], "p1");
    assert_eq!(same["block_id"], "b1");
    let next=sessions::touch_agent_presence(&id,&json!({"state":"waiting","harness":" spatchou ","tokens":-3,"question":"blocked","step":"x".repeat(500)}),9_000).unwrap();
    assert_eq!(next["since"], 9_000);
    assert_eq!(next["harness"], "spatchou");
    assert_eq!(next["tokens"], Value::Null);
    assert_eq!(next["question"], "blocked");
    assert_eq!(next["step"].as_str().unwrap().len(), 200);
    let idle = sessions::touch_agent_presence(
        &id,
        &json!({"state":"idle","harness":"codex","question":"should clear"}),
        10_000,
    )
    .unwrap();
    assert_eq!(idle["question"], Value::Null);
    let mut t = TestDb::new();
    let expired = create(&mut t, json!({"title":"Expired presence"}));
    sessions::touch_agent_presence(&expired, &json!({"state":"idle","harness":"codex"}), 0)
        .unwrap();
    assert!(
        !sessions::list_agent_presence(&mut t.db)
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["session_id"] == expired)
    );
}

#[test]
fn journal_presence_records_one_join_and_one_leave_without_reopening_done() {
    let mut t = TestDb::new();
    for (status, expected) in [("paused", "active"), ("done", "done")] {
        let id = create(&mut t, json!({"title":status,"status":status}));
        let route = format!("/api/sessions/{id}/presence");
        let start = json!({"state":"working","harness":"claude-code","name":format!("w-{status}")});
        assert_eq!(
            sessions::handle(&mut t.db, "POST", &route, "", &start)
                .unwrap()
                .unwrap()
                .0,
            200
        );
        assert_eq!(
            sessions::handle(&mut t.db, "POST", &route, "", &start)
                .unwrap()
                .unwrap()
                .0,
            200
        );
        assert_eq!(card(&mut t, &id)["status"], expected);
        let joined =
            t.db.query(
                "select summary from session_events where session_id=$1 and kind='presence'",
                &[json!(id)],
            )
            .unwrap();
        assert_eq!(joined.len(), 1);
        assert_eq!(joined[0]["summary"], "joined");
        sessions::handle(&mut t.db,"POST",&route,"",&json!({"state":"idle","harness":"claude-code","name":format!("w-{status}"),"ended":true})).unwrap().unwrap();
        let logs=t.db.query("select summary from session_events where session_id=$1 and kind='presence' order by at,id",&[json!(id)]).unwrap();
        assert_eq!(logs.len(), 2);
        assert!(logs[1]["summary"].as_str().unwrap().starts_with("left · "));
    }
}

#[test]
fn status_ids_revive_and_board_deleted_filter_is_exact() {
    let mut t = TestDb::new();
    let create_status = |t: &mut TestDb, color: &str| {
        sessions::handle(
            &mut t.db,
            "POST",
            "/api/statuses",
            "",
            &json!({"label":"Review","color":color}),
        )
        .unwrap()
        .unwrap()
        .1["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let id = create_status(&mut t, "#56b6c2");
    assert_eq!(
        id,
        uuid::Uuid::new_v5(
            &uuid::uuid!("6f1d4a2e-8c3b-4f9a-9d2e-5b7c1a0e3f84"),
            b"review"
        )
        .to_string()
    );
    sessions::handle(
        &mut t.db,
        "POST",
        &format!("/api/statuses/{id}/delete"),
        "",
        &Value::Null,
    )
    .unwrap()
    .unwrap();
    let revived = create_status(&mut t, "#7a9ee7");
    assert_eq!(revived, id);
    let board = sessions::handle(&mut t.db, "GET", "/api/board", "", &Value::Null)
        .unwrap()
        .unwrap()
        .1;
    let reviews = board["statuses"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["key"] == "review")
        .collect::<Vec<_>>();
    assert_eq!(reviews.len(), 1);
    assert_eq!(reviews[0]["color"], "#7a9ee7");
    let gone = create(&mut t, json!({"title":"deleted card"}));
    let kept = create(&mut t, json!({"title":"live card"}));
    sessions::handle(
        &mut t.db,
        "POST",
        &format!("/api/sessions/{gone}/delete"),
        "",
        &Value::Null,
    )
    .unwrap()
    .unwrap();
    let deleted = sessions::handle(&mut t.db, "GET", "/api/board", "deleted=1", &Value::Null)
        .unwrap()
        .unwrap()
        .1;
    let live = sessions::handle(&mut t.db, "GET", "/api/board", "", &Value::Null)
        .unwrap()
        .unwrap()
        .1;
    let ids = |board: &Value| {
        board["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|s| s["id"].as_str())
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    assert!(ids(&deleted).contains(&gone));
    assert!(!ids(&deleted).contains(&kept));
    assert!(!ids(&live).contains(&gone));
}

#[test]
fn story_rewording_does_not_retarget_but_explicit_null_does() {
    let mut t = TestDb::new();
    let id = create(
        &mut t,
        json!({"title":"repo — auth","repo_path":"/tmp/story-reword","branch":"fix/auth","story":"pg-users policy in git","client":"Reword Project"}),
    );
    let original = card(&mut t, &id)["page_id"].clone();
    assert!(!original.is_null());
    let before =
        t.db.query(
            "select count(*)::int as n from pages where kind='story' and not deleted",
            &[],
        )
        .unwrap()[0]["n"]
            .clone();
    let again = create(
        &mut t,
        json!({"title":"repo — auth","repo_path":"/tmp/story-reword","branch":"fix/auth","story":"pg-users policy, tracked in git"}),
    );
    assert_eq!(again, id);
    assert_eq!(card(&mut t, &id)["page_id"], original);
    assert_eq!(
        t.db.query(
            "select count(*)::int as n from pages where kind='story' and not deleted",
            &[]
        )
        .unwrap()[0]["n"],
        before
    );
    let project = pages::resolve_client(&mut t.db, "Other Project").unwrap();
    let other = sessions::resolve_story(&mut t.db, "Other story", &project, &[], None).unwrap();
    create(&mut t, json!({"id":id,"page_id":other}));
    assert_eq!(card(&mut t, &id)["page_id"], other);
    create(&mut t, json!({"id":id,"page_id":null}));
    assert_eq!(card(&mut t, &id)["page_id"], Value::Null);
    create(&mut t, json!({"id":id,"page_id":original}));
    create(&mut t, json!({"id":id,"title":"renamed","status":"paused"}));
    assert_eq!(card(&mut t, &id)["page_id"], original);
}

#[test]
fn unbranched_plan_and_earlier_branch_respect_terminal_state() {
    let mut t = TestDb::new();
    let repo = "/tmp/plan-earlier-branch";
    let exact = create(
        &mut t,
        json!({"title":"exact","repo_path":repo,"branch":"feat/x"}),
    );
    let plan = create(
        &mut t,
        json!({"title":"plan","status":"paused","repo_path":repo}),
    );
    assert_ne!(plan, exact);
    assert_eq!(
        create(
            &mut t,
            json!({"title":"again","repo_path":repo,"branch":"feat/x"})
        ),
        exact
    );
    let adopted = create(
        &mut t,
        json!({"title":"plan starts","repo_path":repo,"branch":"feat/y"}),
    );
    assert_eq!(adopted, plan);
    assert_eq!(card(&mut t, &plan)["branch"], "feat/y");
    let harness = uuid::Uuid::new_v4().to_string();
    let card_id = create(
        &mut t,
        json!({"title":"history","claude_id":harness,"repo_path":"/tmp/earlier-branch","branch":"feat/1","story":"Earlier branch"}),
    );
    assert_eq!(
        create(
            &mut t,
            json!({"title":"history","claude_id":harness,"repo_path":"/tmp/earlier-branch","branch":"feat/2","story":"Earlier branch"})
        ),
        card_id
    );
    assert_eq!(
        create(
            &mut t,
            json!({"title":"manual","repo_path":"/tmp/earlier-branch","branch":"feat/1"})
        ),
        card_id
    );
    let done = create(
        &mut t,
        json!({"title":"done plan","status":"done","repo_path":"/tmp/closed-plan"}),
    );
    let fresh = create(
        &mut t,
        json!({"title":"fresh work","repo_path":"/tmp/closed-plan","branch":"feat/z"}),
    );
    assert_ne!(fresh, done);
}

#[test]
fn home_project_and_blank_story_do_not_create_root_stories() {
    let mut t = TestDb::new();
    let home = pages::resolve_client(&mut t.db, "Home Project").unwrap();
    create(
        &mut t,
        json!({"title":"home repo","client_id":home,"repo_path":"/tmp/home-project"}),
    );
    let other = pages::resolve_client(&mut t.db, "Other Project").unwrap();
    let reused = sessions::resolve_story(&mut t.db, "Shared topic", &other, &[], None).unwrap();
    for (title, client_id, parent, expected_story) in [
        ("Fresh home topic", home.clone(), home.clone(), Value::Null),
        ("Shared topic", other.clone(), other.clone(), reused.clone()),
    ] {
        let id = create(
            &mut t,
            json!({"title":title,"repo_path":"/tmp/home-project/wt","branch":title,"story":title}),
        );
        let s = card(&mut t, &id);
        let page = pages::get(&mut t.db, s["page_id"].as_str().unwrap()).unwrap();
        assert_eq!(s["client_id"], client_id);
        assert_eq!(page["parent_id"], parent);
        if !expected_story.is_null() {
            assert_eq!(page["id"], expected_story);
        }
    }
    let before =
        t.db.query(
            "select count(*)::int as n from pages where kind='story' and not deleted",
            &[],
        )
        .unwrap()[0]["n"]
            .clone();
    let blank = create(
        &mut t,
        json!({"title":"blank","repo_path":"/tmp/home-project","story":"   "}),
    );
    assert_eq!(card(&mut t, &blank)["page_id"], Value::Null);
    assert_eq!(
        t.db.query(
            "select count(*)::int as n from pages where kind='story' and not deleted",
            &[]
        )
        .unwrap()[0]["n"],
        before
    );
    let detached = create(
        &mut t,
        json!({"title":"rootless","repo_path":"/tmp/home-project/wt2","branch":"rootless","story":"Rootless topic","client_id":null}),
    );
    assert_eq!(card(&mut t, &detached)["client_id"], Value::Null);
    let detached_page = card(&mut t, &detached)["page_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        pages::get(&mut t.db, &detached_page).unwrap()["parent_id"],
        Value::Null
    );
}

#[test]
fn read_card_handles_missing_refs_and_worklog_limits() {
    let mut t = TestDb::new();
    let id = create(
        &mut t,
        json!({"title":"Loose","status":"active","repo_path":"/tmp/loose-card"}),
    );
    let card = sessions::get_session(&mut t.db, &id, 20).unwrap();
    assert_eq!(card["project"], Value::Null);
    assert_eq!(card["story"], Value::Null);
    assert_eq!(card["activity"], json!([]));
    let unknown = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        sessions::get_session(&mut t.db, &unknown, 20).unwrap(),
        Value::Null
    );
    for summary in ["first", "second", "third"] {
        sessions::handle(
            &mut t.db,
            "POST",
            &format!("/api/sessions/{id}/events"),
            "",
            &json!({"summary":summary}),
        )
        .unwrap()
        .unwrap();
    }
    t.db.query(
        "update session_events set at='2026-01-01T00:00:00Z' where session_id=$1",
        &[json!(id)],
    )
    .unwrap();
    let card = sessions::get_session(&mut t.db, &id, 2).unwrap();
    assert_eq!(
        card["activity"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["summary"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["third", "second"]
    );
    assert_eq!(card["activity_total"], 3);
}

#[test]
fn session_tags_survive_partial_writes_then_replace_and_clear() {
    let mut t = TestDb::new();
    let id = create(
        &mut t,
        json!({"title":"Tagged","tags":["priority:P1","priority-p1","infra"]}),
    );
    let other = create(&mut t, json!({"title":"Untagged"}));
    assert_eq!(
        sessions::get_session(&mut t.db, &id, 20).unwrap()["tags"],
        json!(["priority-p1", "infra"])
    );
    assert_eq!(
        sessions::get_session(&mut t.db, &other, 20).unwrap()["tags"],
        json!([])
    );
    create(
        &mut t,
        json!({"id":id,"title":"Renamed","summary":"Tracking update"}),
    );
    assert_eq!(
        sessions::get_session(&mut t.db, &id, 20).unwrap()["tags"],
        json!(["priority-p1", "infra"])
    );
    create(&mut t, json!({"id":id,"tags":["priority-p2"]}));
    assert_eq!(
        sessions::get_session(&mut t.db, &id, 20).unwrap()["tags"],
        json!(["priority-p2"])
    );
    assert_eq!(
        sessions::get_session(&mut t.db, &other, 20).unwrap()["tags"],
        json!([])
    );
    create(&mut t, json!({"id":id,"tags":[]}));
    assert_eq!(
        sessions::get_session(&mut t.db, &id, 20).unwrap()["tags"],
        json!([])
    );
}

#[test]
fn report_helpers_store_story_refs_and_soft_delete() {
    let mut t = TestDb::new();
    let id=sessions::create_report(&mut t.db,&json!({"title":"Report","html":"<h1>Done</h1>","client":"Reports project","story":"Reports story"})).unwrap();
    let report = sessions::get_report(&mut t.db, id.as_str().unwrap()).unwrap();
    assert_eq!(report["title"], "Report");
    assert_eq!(report["html"], "<h1>Done</h1>");
    assert!(!report["client_id"].is_null());
    assert!(!report["page_id"].is_null());
    assert!(
        sessions::list_reports(&mut t.db)
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == id)
    );
    sessions::delete_report(&mut t.db, id.as_str().unwrap()).unwrap();
    assert_eq!(
        sessions::get_report(&mut t.db, id.as_str().unwrap()).unwrap(),
        Value::Null
    );
    assert!(
        !sessions::list_reports(&mut t.db)
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == id)
    );
}

#[test]
fn same_block_id_on_two_pages_keeps_two_links() {
    let mut t = TestDb::new();
    let id = create(&mut t, json!({"title":"Links"}));
    let a = pages::create(&mut t.db, &json!({"title":"Links A"})).unwrap();
    let b = pages::create(&mut t.db, &json!({"title":"Links B"})).unwrap();
    for (page, count) in [(&a, 1), (&a, 1), (&b, 2)] {
        sessions::ensure_link(&mut t.db, &id, page.as_str().unwrap(), "blk00001", "todo").unwrap();
        assert_eq!(
            sessions::handle(
                &mut t.db,
                "GET",
                &format!("/api/sessions/{id}/links"),
                "",
                &Value::Null
            )
            .unwrap()
            .unwrap()
            .1
            .as_array()
            .unwrap()
            .len(),
            count
        );
    }
}

#[test]
fn session_links_resolve_visible_partial_quotes_and_ambiguous_quotes() {
    let mut t = TestDb::new();
    let id = create(&mut t, json!({"title":"Quoted links"}));
    let page = pages::create(
        &mut t.db,
        &json!({
            "title":"Quoted page",
            "content":[
            {"type":"todo","id":"quoted01","text":"Ship {{trame:done=1}} carefully"},
                {"type":"text","id":"quoted02","text":"Review shared phrase A"},
                {"type":"text","id":"quoted03","text":"Review shared phrase B"}
            ]
        }),
    )
    .unwrap();
    for (anchor, expected) in [
        ("Ship carefully", "quoted01"),
        ("carefully", "quoted01"),
        ("shared phrase", ""),
    ] {
        sessions::handle(
            &mut t.db,
            "POST",
            "/api/sessions",
            "",
            &json!({"id":id,"links":[{"page_id":page,"anchor":anchor}]}),
        )
        .unwrap()
        .unwrap();
        let links = sessions::handle(
            &mut t.db,
            "GET",
            &format!("/api/sessions/{id}/links"),
            "",
            &Value::Null,
        )
        .unwrap()
        .unwrap()
        .1;
        let link = links
            .as_array()
            .unwrap()
            .iter()
            .find(|l| l["anchor"] == anchor)
            .unwrap();
        assert_eq!(
            link["block_id"],
            if expected.is_empty() {
                Value::Null
            } else {
                json!(expected)
            }
        );
    }
}

#[test]
fn page_tags_survive_unrelated_patches_and_can_be_cleared() {
    let mut t = TestDb::new();
    let id = pages::create(&mut t.db, &json!({"title":"Tagged","tags":["devops"]})).unwrap();
    let id = id.as_str().unwrap();
    assert_eq!(
        pages::get(&mut t.db, id).unwrap()["tags"],
        json!(["devops"])
    );
    pages::update(&mut t.db, id, &json!({"title":"Renamed"})).unwrap();
    assert_eq!(
        pages::get(&mut t.db, id).unwrap()["tags"],
        json!(["devops"])
    );
    pages::update(&mut t.db, id, &json!({"tags":["devops","mobile"]})).unwrap();
    assert_eq!(
        pages::get(&mut t.db, id).unwrap()["tags"],
        json!(["devops", "mobile"])
    );
    pages::update(&mut t.db, id, &json!({"tags":[]})).unwrap();
    assert_eq!(pages::get(&mut t.db, id).unwrap()["tags"], json!([]));
}

#[test]
fn story_from_page_rejects_nested_and_spec_pages() {
    let mut t = TestDb::new();
    let project = pages::resolve_client(&mut t.db, "Conversion project").unwrap();
    let folder = pages::create(&mut t.db, &json!({"title":"Docs","parent_id":project})).unwrap();
    let plain = pages::create(
        &mut t.db,
        &json!({"title":"Becomes story","parent_id":folder}),
    )
    .unwrap();
    let story = pages::create(
        &mut t.db,
        &json!({"title":"Existing story","kind":"story","parent_id":project}),
    )
    .unwrap();
    let under =
        pages::create(&mut t.db, &json!({"title":"Under story","parent_id":story})).unwrap();
    let spec = pages::create(&mut t.db, &json!({"title":"Spec","parent_id":project})).unwrap();
    pages::session_from_page(&mut t.db, spec.as_str().unwrap()).unwrap();
    let above = pages::create(
        &mut t.db,
        &json!({"title":"Holds story","parent_id":project}),
    )
    .unwrap();
    pages::create(
        &mut t.db,
        &json!({"title":"Nested story","kind":"story","parent_id":above}),
    )
    .unwrap();
    let loose = pages::create(&mut t.db, &json!({"title":"No project"})).unwrap();
    for (page, fragment) in [
        (&under, "already under a user story"),
        (&spec, "card's specs"),
        (&above, "sits below this page"),
        (&loose, "under a project first"),
    ] {
        assert!(
            pages::story_from_page(&mut t.db, page.as_str().unwrap())
                .unwrap_err()
                .to_string()
                .contains(fragment)
        );
    }
    for page in [&plain, &story] {
        assert_eq!(
            pages::story_from_page(&mut t.db, page.as_str().unwrap()).unwrap()["id"],
            *page
        );
        let row = pages::get(&mut t.db, page.as_str().unwrap()).unwrap();
        assert_eq!(row["kind"], "story");
        assert_eq!(row["parent_id"], project);
    }
}
