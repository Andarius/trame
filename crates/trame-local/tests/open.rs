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
    for (url, expected) in [
        (format!("trame://page/{id}"), Some(("page", id))),
        (format!("trame://card/{id}/"), Some(("card", id))),
        (format!("trame://session/{id}?x=1"), Some(("card", id))),
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
