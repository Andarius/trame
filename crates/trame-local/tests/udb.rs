mod common;

use common::TestDb;
use serde_json::{Value, json};
use trame_local::udb;

#[allow(
    clippy::needless_pass_by_value,
    reason = "callers pass json! temporaries"
)]
fn call(t: &mut TestDb, method: &str, path: &str, body: Value) -> (u16, Value) {
    udb::handle(&mut t.db, method, path, "", &body)
        .unwrap()
        .unwrap()
}
fn id(t: &mut TestDb, name: &str) -> String {
    call(t, "POST", "/api/udb", json!({"name":name})).1["id"]
        .as_str()
        .unwrap()
        .to_owned()
}
#[allow(
    clippy::needless_pass_by_value,
    reason = "callers pass json! temporaries"
)]
fn prop(t: &mut TestDb, db: &str, name: &str, kind: &str, config: Value) -> String {
    call(
        t,
        "POST",
        &format!("/api/udb/{db}/props"),
        json!({"name":name,"type":kind,"config":config}),
    )
    .1["id"]
        .as_str()
        .unwrap()
        .to_owned()
}
#[allow(
    clippy::needless_pass_by_value,
    reason = "callers pass json! temporaries"
)]
fn row(t: &mut TestDb, db: &str, vals: Value) -> String {
    call(
        t,
        "POST",
        &format!("/api/udb/{db}/rows"),
        json!({"vals":vals}),
    )
    .1["id"]
        .as_str()
        .unwrap()
        .to_owned()
}
fn read(t: &mut TestDb, id: &str) -> Value {
    call(t, "GET", &format!("/api/udb/{id}"), Value::Null).1
}

#[test]
fn database_rows_views_icons_and_soft_delete() {
    let mut t = TestDb::new();
    let db = id(&mut t, "Bench");
    let title = read(&mut t, &db)["properties"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let row = row(
        &mut t,
        &db,
        json!({title.clone():"first","keep":false,"remove":"old"}),
    );
    let image = "data:image/png;base64,example";
    call(
        &mut t,
        "POST",
        &format!("/api/udb/rows/{row}"),
        json!({"vals":{"remove":null},"icon":image}),
    );
    let views = json!({"tabs":[{"id":"a","name":"Alpha"}],"active":"a"});
    call(
        &mut t,
        "POST",
        &format!("/api/udb/{db}"),
        json!({"icon":"🧪","views":views}),
    );
    let data = read(&mut t, &db);
    assert_eq!(data["db"]["views"], views);
    assert_eq!(data["rows"][0]["vals"][title], "first");
    assert_eq!(data["rows"][0]["vals"]["keep"], false);
    assert!(data["rows"][0]["vals"].get("remove").is_none());
    assert_eq!(data["rows"][0]["icon"], image);
    assert_eq!(
        call(&mut t, "GET", "/api/udb/icons", Value::Null).1,
        json!([image])
    );
    assert_eq!(
        call(&mut t, "GET", "/api/udb", Value::Null).1[0]["row_count"],
        1
    );
    call(
        &mut t,
        "POST",
        &format!("/api/udb/rows/{row}/delete"),
        Value::Null,
    );
    assert!(read(&mut t, &db)["rows"].as_array().unwrap().is_empty());
    call(
        &mut t,
        "POST",
        &format!("/api/udb/{db}/delete"),
        Value::Null,
    );
    assert_eq!(
        call(&mut t, "GET", &format!("/api/udb/{db}"), Value::Null),
        (404, json!({"error":"not found"}))
    );
}

#[test]
fn relation_pair_reverse_read_and_distinct_rollup() {
    let mut t = TestDb::new();
    let a = id(&mut t, "A");
    let b = id(&mut t, "B");
    let a_title = read(&mut t, &a)["properties"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let b_title = read(&mut t, &b)["properties"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let a_row = row(&mut t, &a, json!({a_title:"source"}));
    let b_row = row(&mut t, &b, json!({b_title:"target"}));
    let relation = prop(&mut t, &a, "Refs", "relation", json!({"target_db":b}));
    let reverse = read(&mut t, &b)["properties"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["type"] == "relation")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let count = prop(
        &mut t,
        &a,
        "Count",
        "rollup",
        json!({"relation_prop":relation,"agg":"count"}),
    );
    let link = json!({"prop_id":relation,"from_row":a_row,"to_row":b_row});
    call(&mut t, "POST", "/api/udb/links", link.clone());
    call(&mut t, "POST", "/api/udb/links", link);
    assert_eq!(
        read(&mut t, &a)["rows"][0]["relations"][&relation][0]["title"],
        "target"
    );
    assert_eq!(
        read(&mut t, &b)["rows"][0]["relations"][&reverse][0]["title"],
        "source"
    );
    assert_eq!(read(&mut t, &a)["rows"][0]["derived"][&count], 1);
    call(
        &mut t,
        "POST",
        "/api/udb/links",
        json!({"prop_id":reverse,"from_row":b_row,"to_row":a_row,"remove":true}),
    );
    assert_eq!(read(&mut t, &a)["rows"][0]["derived"][&count], Value::Null);
    call(
        &mut t,
        "POST",
        &format!("/api/udb/props/{relation}/delete"),
        Value::Null,
    );
    assert_eq!(
        read(&mut t, &b)["properties"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|p| p["type"] == "relation")
            .count(),
        0
    );
}

#[test]
fn formula_evaluates_and_cannot_read_private_tables() {
    let mut t = TestDb::new();
    let db = id(&mut t, "Formula");
    let score = prop(&mut t, &db, "Score", "number", json!({}));
    row(&mut t, &db, json!({score:42}));
    let double = prop(
        &mut t,
        &db,
        "Double",
        "formula",
        json!({"expr":"score * 2"}),
    );
    assert_eq!(read(&mut t, &db)["rows"][0]["derived"][&double], "84");
    let path = format!("/api/udb/{db}/props");
    let (status, body) = call(
        &mut t,
        "POST",
        &path,
        json!({"name":"Bad","type":"formula","config":{"expr":"bogus_prop + 1"}}),
    );
    assert_eq!(status, 400);
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("unknown identifier \"bogus_prop\"")
    );
    let (status, body) = call(
        &mut t,
        "POST",
        &path,
        json!({"name":"Private","type":"formula","config":{"expr":"query_to_xml('select id from pages',false,false,'')"}}),
    );
    assert_eq!(status, 400);
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("permission denied"),
        "{}",
        body["error"]
    );
    let (status, body) = call(
        &mut t,
        "POST",
        &path,
        json!({"name":"Mutate","type":"formula","config":{"expr":"set_config('role','trame',false)"}}),
    );
    assert_eq!(status, 400);
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("permission denied"),
        "{}",
        body["error"]
    );
}

#[test]
fn route_ownership_keeps_unrelated_endpoints_proxied() {
    for path in [
        "/api/udb",
        "/api/udb/icons",
        "/api/udb/links",
        "/api/udb/props/p",
        "/api/udb/rows/r/delete",
        "/api/udb/d/props",
    ] {
        assert!(udb::owns("POST", path), "{path}");
    }
    for path in [
        "/api/udbs",
        "/api/udb/",
        "/api/pages/d",
        "/api/udb/d/export",
    ] {
        assert!(!udb::owns("GET", path), "{path}");
    }
}

#[test]
fn formula_role_rejects_writes_leaks_locks_and_role_escalation() {
    use postgres::{Config, NoTls};
    let mut t = TestDb::new();
    let db = id(&mut t, "Sandbox");
    prop(&mut t, &db, "Ready", "formula", json!({"expr":"1 + 1"}));
    let mut config = Config::new();
    config
        .host_path(t.root.join("socket"))
        .port(trame_local::pg::PORT)
        .user("trame_formula")
        .dbname("postgres");
    let mut restricted = config.connect(NoTls).unwrap();
    let count: i64 = restricted
        .query_one("select count(*) from udb_rows", &[])
        .unwrap()
        .get(0);
    assert_eq!(count, 0);
    for (sql, expected) in [
        ("select id from pages", "permission denied"),
        (
            "select query_to_xml('select id from pages', false, false, '')",
            "permission denied",
        ),
        (
            "insert into udb_rows (db_id, sort_key) values (gen_random_uuid(), 'a')",
            "read-only",
        ),
        ("select lo_create(0)", "read-only"),
        (
            "select pg_logical_emit_message(false, 'x', 'payload', true)",
            "permission denied",
        ),
        ("select pg_advisory_lock(123)", "permission denied"),
        (
            "select set_config('role', 'trame', false)",
            "permission denied",
        ),
        ("select pg_sleep(5)", "statement timeout"),
    ] {
        let error = restricted.query(sql, &[]).unwrap_err();
        assert!(
            error.to_string().contains(expected)
                || error
                    .as_db_error()
                    .is_some_and(|e| e.message().contains(expected)),
            "{sql}: {error}"
        );
    }
    {
        let mut tx = restricted.transaction().unwrap();
        tx.query("select set_config('statement_timeout', '0', false)", &[])
            .unwrap();
        tx.rollback().unwrap();
    }
    let timeout: String = restricted
        .query_one("show statement_timeout", &[])
        .unwrap()
        .get(0);
    assert_eq!(timeout, "2s");
}

#[test]
fn formula_role_is_repaired_at_startup_without_per_query_ddl() {
    use postgres::{Config, NoTls};
    let mut t = TestDb::new();
    t.db.batch_execute("alter role trame_formula set statement_timeout='1s'")
        .unwrap();
    let db = id(&mut t, "Formula role repair");
    prop(&mut t, &db, "Value", "formula", json!({"expr":"1 + 1"}));
    assert_eq!(read(&mut t, &db)["rows"].as_array().unwrap().len(), 0);
    let mut config = Config::new();
    config
        .host_path(t.root.join("socket"))
        .port(trame_local::pg::PORT)
        .user("trame_formula")
        .dbname("postgres");
    let mut restricted = config.connect(NoTls).unwrap();
    let timeout: String = restricted
        .query_one("show statement_timeout", &[])
        .unwrap()
        .get(0);
    assert_eq!(timeout, "1s");
    drop(restricted);
    t.db.batch_execute("grant pg_read_all_data to trame_formula")
        .unwrap();
    trame_local::startup::initialize(&t.root, &t.db.origin, &t.root.join("settings.json")).unwrap();
    let mut restricted = config.connect(NoTls).unwrap();
    let timeout: String = restricted
        .query_one("show statement_timeout", &[])
        .unwrap()
        .get(0);
    assert_eq!(timeout, "2s");
    let memberships: i64 = t
        .db
        .client
        .query_one(
            "select count(*) from pg_auth_members where member=(select oid from pg_roles where rolname='trame_formula')",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(memberships, 0);
    assert!(restricted.query("select id from pages", &[]).is_err());
}
