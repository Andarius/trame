mod common;
use common::TestDb;
use serde_json::json;
use trame_local::open;

#[test]
fn open_resolves_page_and_card_ids_and_refuses_unknown_ones() {
    let mut t = TestDb::new();
    let page =
        t.db.query("insert into pages(title) values('plan') returning id", &[])
            .unwrap()[0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
    let card = t
        .db
        .query(
            "insert into sessions(title,status,repo_path) values('open cmd','active','/repos/trame') returning id",
            &[],
        )
        .unwrap()[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let unknown = "00000000-0000-4000-8000-00000000abcd";
    for (body, status, query) in [
        (json!({"page_id":page}), 200, Some(format!("page={page}"))),
        (
            json!({"card_id":card}),
            200,
            Some(format!("view=card&card={card}")),
        ),
        (json!({"id":page}), 200, Some(format!("page={page}"))),
        (
            json!({"id":card}),
            200,
            Some(format!("view=card&card={card}")),
        ),
        (json!({"page_id":card}), 404, None),
        (json!({"card_id":page}), 404, None),
        (json!({"id":unknown}), 404, None),
        (json!({"page_id":"nope"}), 400, None),
        (json!({}), 400, None),
    ] {
        let (got, value) = open::resolve(&mut t.db, &body).unwrap();
        assert_eq!(got, status, "{body}");
        assert_eq!(value["query"].as_str().map(str::to_owned), query, "{body}");
    }
}

#[test]
fn scheme_links_name_a_page_or_a_card() {
    let id = "00000000-0000-4000-8000-00000000abcd";
    let run = id.replace('-', "");
    for (url, expected) in [
        (
            format!("trame://agent/{run}"),
            Some(("agent", run.as_str())),
        ),
        (format!("trame://agent/{id}"), None),
        (format!("trame://page/{id}"), Some(("page", id))),
        (format!("trame://card/{id}/"), Some(("card", id))),
        (format!("trame://session/{id}?x=1"), Some(("card", id))),
        (
            "trame://board?q=tag%3Aparked".to_owned(),
            Some(("board", "tag:parked")),
        ),
        ("trame://view/Parked".to_owned(), Some(("view", "Parked"))),
        (format!("trame://db/{id}"), None),
        ("trame://page/not-an-id".to_owned(), None),
        (format!("https://page/{id}"), None),
    ] {
        assert_eq!(
            open::scheme_target(&url),
            expected.map(|(k, i)| (k, i.to_owned())),
            "{url}"
        );
    }
}

#[test]
fn board_queries_and_saved_views_open_the_filtered_board() {
    let t = TestDb::new();
    let settings = t.root.join("settings.json");
    std::fs::write(
        &settings,
        json!({"boardViews":[{"name":"Parked","q":"tag:parked","group":"project"}]}).to_string(),
    )
    .unwrap();
    for (body, expected) in [
        (
            json!({"q":"tag:parked status:paused"}),
            Some((200, "view=board&group=none&q=tag%3Aparked+status%3Apaused")),
        ),
        (
            json!({"view":"parked"}),
            Some((200, "view=board&group=project&q=tag%3Aparked")),
        ),
        (json!({"view":"Missing"}), Some((404, ""))),
        (json!({"page_id":"x"}), None),
    ] {
        let got = open::resolve_board(&settings, &body)
            .map(|(status, v)| (status, v["query"].as_str().unwrap_or_default().to_owned()));
        assert_eq!(got, expected.map(|(s, q)| (s, q.to_owned())), "{body}");
    }
}
