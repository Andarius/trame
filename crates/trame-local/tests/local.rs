mod common;
use common::TestDb;
use serde_json::json;
use trame_local::{local, pages, settings};

#[test]
fn identity_claim_typescript_assertions_and_explicit_profile_sync() {
    let mut t = TestDb::new();
    let users =
        t.db.query("select id,name from users where not deleted", &[])
            .unwrap();
    let seed = "00000000-0000-4000-8000-000000000101";
    assert_eq!(users.len(), 1);
    assert_eq!(users[0]["id"], seed);
    local::claim_device(&mut t.db).unwrap();
    local::claim_device(&mut t.db).unwrap();
    let devices =
        t.db.query(
            "select id,node_id,user_id from devices where not deleted",
            &[],
        )
        .unwrap();
    assert_eq!(devices.len(), 1);
    assert_eq!(
        devices[0]["id"],
        local::device_id("rust-slice2-test").to_string()
    );
    assert_eq!(devices[0]["node_id"], "rust-slice2-test");
    assert_eq!(devices[0]["user_id"], seed);
    let settings = t.root.join("settings.json");
    settings::save_explore(&settings, &json!({"authorName":" Local display "})).unwrap();
    assert_eq!(t.db.identity().unwrap()["name"], "Local display");
    let saved = t.request(
        "POST",
        "/api/settings",
        json!({"authorName":" Synced profile ","authorAvatar":"avatar.png"}),
    );
    assert_eq!(saved.0, 200);
    assert_eq!(saved.1["authorName"], "Synced profile");
    let profile =
        t.db.query(
            "select name,avatar,origin from users where id=$1",
            &[json!(seed)],
        )
        .unwrap();
    assert_eq!(profile[0]["name"], "Synced profile");
    assert_eq!(profile[0]["avatar"], "avatar.png");
    assert_eq!(profile[0]["origin"], "rust-slice2-test");
    t.db.query(
        "insert into users(id,name) values ('00000000-0000-4000-8000-000000000102','Guest')",
        &[],
    )
    .unwrap();
    t.db.query(
        "delete from devices where node_id=$1",
        &[json!(t.db.origin)],
    )
    .unwrap();
    local::claim_device(&mut t.db).unwrap();
    assert_eq!(
        t.db.query(
            "select 1 from devices where node_id=$1",
            &[json!(t.db.origin)]
        )
        .unwrap()
        .len(),
        0
    );
    t.db.query(
        "delete from users where id='00000000-0000-4000-8000-000000000102'",
        &[],
    )
    .unwrap();
    settings::save_explore(
        &settings,
        &json!({"hubApi":"https://fixture.invalid","hubApiToken":"fixture-only"}),
    )
    .unwrap();
    local::claim_device(&mut t.db).unwrap();
    assert!(
        t.db.query(
            "select 1 from devices where node_id=$1",
            &[json!(t.db.origin)]
        )
        .unwrap()
        .is_empty()
    );
    settings::save_explore(&settings, &json!({"hubApi":""})).unwrap();
    local::claim_device(&mut t.db).unwrap();
    assert_eq!(t.db.identity().unwrap()["userId"], seed);
}

#[test]
fn page_link_typescript_assertions_and_share_updates() {
    let mut t = TestDb::new();
    let page = pages::create(&mut t.db, &json!({"title":"Shared plan"})).unwrap();
    let (id, token) = local::create_link(&mut t.db, page.as_str().unwrap()).unwrap();
    assert!(token.len() > 20);
    let links = local::list_links(&mut t.db, page.as_str().unwrap()).unwrap();
    assert_eq!(
        links
            .iter()
            .map(|l| json!({"id":l["id"],"token":l["token"]}))
            .collect::<Vec<_>>(),
        vec![json!({"id":id,"token":token})]
    );
    let registry: serde_json::Value =
        serde_json::from_str(include_str!("../../../protocol/rust-entities.json")).unwrap();
    let cols = &registry["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["name"] == "page_links")
        .unwrap()["cols"];
    assert!(
        !cols.as_array().unwrap().contains(&json!("token")),
        "raw token must never sync"
    );
    let result = t.request(
        "POST",
        &format!("/api/page-links/{}/delete", id.as_str().unwrap()),
        json!({}),
    );
    assert_eq!(result, (200, json!({"ok":true})));
    assert!(
        local::list_links(&mut t.db, page.as_str().unwrap())
            .unwrap()
            .is_empty()
    );
    let share=t.request("POST","/api/shares",json!({"page_id":page,"user_id":"00000000-0000-4000-8000-000000000101","role":"viewer"})).1;
    let again=t.request("POST","/api/shares",json!({"page_id":page,"user_id":"00000000-0000-4000-8000-000000000101","role":"anything"})).1;
    assert_eq!(share, again);
    let list = t
        .request(
            "GET",
            &format!("/api/shares?page={}", page.as_str().unwrap()),
            json!(null),
        )
        .1;
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["role"], "editor");
    t.request(
        "POST",
        &format!("/api/shares/{}/delete", share["id"].as_str().unwrap()),
        json!({}),
    );
    assert_eq!(
        t.request(
            "GET",
            &format!("/api/shares?page={}", page.as_str().unwrap()),
            json!(null)
        )
        .1,
        json!([])
    );
}
