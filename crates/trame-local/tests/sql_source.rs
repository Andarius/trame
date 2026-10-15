mod common;
use common::TestDb;
use serde_json::{Value, json};
use trame_local::plugins::sql_source::{self, Env};

struct Fixture {
    t: TestDb,
    env: Env,
    dsn: String,
    db_id: String,
}

// a second database in the test cluster plays the external Postgres
fn fixture() -> Fixture {
    let mut t = TestDb::new();
    let name = format!("src_{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    t.db.batch_execute(&format!("create database {name}"))
        .unwrap();
    let dsn = format!(
        "host={} port={} user=trame dbname={name}",
        t.root.join("socket").display(),
        trame_local::pg::PORT
    );
    let mut src = postgres::Client::connect(&dsn, postgres::NoTls).unwrap();
    src.batch_execute(
        "create table kr (client_id text, client_name text, volume_pct numeric, as_of date, active boolean);
         insert into kr values ('c1','Saur',63.4,'2026-10-14',true),('c2','Veolia',41,'2026-10-14',false);
         create sequence s;",
    )
    .unwrap();
    let env = Env {
        root: t.root.clone(),
        origin: "rust-slice2-test".into(),
        settings: t.root.join("settings.json"),
    };
    let (_, created) = t.request("POST", "/api/udb", json!({"name":"OKR"}));
    let db_id = created["id"].as_str().unwrap().to_owned();
    sql_source::handle(&env, "POST", "/enable", &json!({"enabled":true})).unwrap();
    Fixture { t, env, dsn, db_id }
}

fn source(f: &Fixture, extra: &Value) -> Value {
    let mut body = json!({
        "name": "OKR volume", "dsn": f.dsn, "db_id": f.db_id, "key_column": "client_id",
        "query": "select client_id, client_name as \"Name\", volume_pct, as_of, active from kr",
    });
    body.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    body
}

fn exec(f: &Fixture, sql: &str) {
    postgres::Client::connect(&f.dsn, postgres::NoTls)
        .unwrap()
        .batch_execute(sql)
        .unwrap();
}

fn table(f: &mut Fixture) -> Value {
    let path = format!("/api/udb/{}", f.db_id);
    f.t.request("GET", &path, json!({})).1
}

fn by_name(data: &Value, name: &str) -> String {
    data["properties"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == name)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn call(f: &Fixture, method: &str, sub: &str, body: &Value) -> (u16, Value) {
    sql_source::handle(&f.env, method, sub, body).unwrap()
}

#[test]
fn a_source_fills_then_writes_only_what_changed() {
    let mut f = fixture();

    let (status, dry) = call(
        &f,
        "POST",
        "/sources",
        &source(&f, &json!({"dry_run": true})),
    );
    assert_eq!(status, 200, "{dry}");
    assert_eq!(dry["dry_run"]["created"], 2);
    assert_eq!(dry["dry_run"]["claimed_columns"], json!(["Name"]));
    assert_eq!(
        table(&mut f)["rows"].as_array().unwrap().len(),
        0,
        "a dry run writes nothing"
    );

    let (_, saved) = call(&f, "POST", "/sources", &source(&f, &json!({})));
    assert_eq!(saved["status"]["created"], 2, "{saved}");
    let id = saved["source"]["id"].as_str().unwrap().to_owned();
    let settings = std::fs::read_to_string(&f.env.settings).unwrap();
    assert!(
        settings.contains(&f.dsn),
        "the dsn is kept in the device settings"
    );
    assert!(
        !crate_json(&call(&f, "GET", "/settings", &json!({})).1).contains("dbname"),
        "never returned"
    );

    let data = table(&mut f);
    let (vol, active, date) = (
        by_name(&data, "volume_pct"),
        by_name(&data, "active"),
        by_name(&data, "as_of"),
    );
    let saur = data["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["vals"][&vol] == json!(63.4))
        .unwrap()
        .clone();
    assert_eq!(saur["vals"][&active], true);
    assert_eq!(saur["vals"][&date], json!({"start":"2026-10-14"}));
    let props = data["properties"].as_array().unwrap();
    assert!(
        props
            .iter()
            .filter(|p| p["name"] != "Notes")
            .all(|p| p["config"]["source"] == id.as_str())
    );

    // a user column edit, then an unchanged refresh: nothing is rewritten
    let (_, notes) = f.t.request(
        "POST",
        &format!("/api/udb/{}/props", f.db_id),
        json!({"name":"Notes","type":"text"}),
    );
    let notes = notes["id"].as_str().unwrap().to_owned();
    f.t.request(
        "POST",
        &format!("/api/udb/rows/{}", saur["id"].as_str().unwrap()),
        json!({"vals":{&notes:"call Monday"}}),
    );
    let stamp = |f: &mut Fixture| {
        f.t.db
            .query(
                "select id, updated_at::text as at from udb_rows where db_id=$1 order by id",
                &[json!(f.db_id)],
            )
            .unwrap()
    };
    let before = stamp(&mut f);
    let (_, again) = call(&f, "POST", &format!("/refresh/{id}"), &json!({}));
    assert_eq!(
        (
            again["status"]["created"].clone(),
            again["status"]["updated"].clone()
        ),
        (json!(0), json!(0))
    );
    assert_eq!(
        stamp(&mut f),
        before,
        "an unchanged refresh bumps no updated_at"
    );

    // a changed value patches that cell only; the user's note survives
    exec(&f, "update kr set volume_pct = 64.1 where client_id = 'c1'");
    let (_, changed) = call(&f, "POST", &format!("/refresh/{id}"), &json!({}));
    assert_eq!(changed["status"]["updated"], 1, "{changed}");
    let row = table(&mut f)["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == saur["id"])
        .unwrap()
        .clone();
    assert_eq!(
        (row["vals"][&vol].clone(), row["vals"][&notes].clone()),
        (json!(64.1), json!("call Monday"))
    );

    // a vanished key stays unless delete_missing
    exec(&f, "delete from kr where client_id = 'c2'");
    for (delete_missing, rows) in [(false, 2), (true, 1)] {
        let mut body = source(&f, &json!({"id": id, "delete_missing": delete_missing}));
        body["connection_id"] = saved["source"]["connection_id"].clone();
        body.as_object_mut().unwrap().remove("dsn");
        call(&f, "POST", "/sources", &body);
        assert_eq!(
            table(&mut f)["rows"].as_array().unwrap().len(),
            rows,
            "delete_missing={delete_missing}"
        );
    }

    // disconnecting hands the columns back and keeps the rows
    call(&f, "POST", &format!("/sources/{id}/delete"), &json!({}));
    let data = table(&mut f);
    assert_eq!(data["rows"].as_array().unwrap().len(), 1);
    assert!(
        data["properties"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["config"].get("source").is_none())
    );
}

fn crate_json(v: &Value) -> String {
    serde_json::to_string(v).unwrap()
}

#[test]
fn bad_sources_are_refused_before_any_write() {
    let mut f = fixture();
    exec(
        &f,
        "create table dup (k text, v int); insert into dup values ('a',1),('a',2),(null,3);",
    );
    for (query, key, error) in [
        ("select k, v from dup where v < 3", "k", "is not unique"),
        ("select k, v from dup where v = 3", "k", "has empty values"),
        (
            "select client_id from kr",
            "missing",
            "is not in the query results",
        ),
        ("select nextval('s') as k", "k", "read-only transaction"),
        ("select 1 as k, 2 as k", "k", "appears twice"),
        ("select 1 as k; select 2 as k", "k", "syntax error"),
        ("", "k", "the query is empty"),
    ] {
        let (status, body) = call(
            &f,
            "POST",
            "/sources",
            &source(
                &f,
                &json!({"query": query, "key_column": key, "dry_run": true}),
            ),
        );
        assert_eq!(status, 400, "{query}: {body}");
        assert!(
            body["error"].as_str().unwrap().contains(error),
            "{query}: {body}"
        );
    }
    assert_eq!(table(&mut f)["rows"].as_array().unwrap().len(), 0);
    assert_eq!(
        table(&mut f)["properties"].as_array().unwrap().len(),
        1,
        "only the title column"
    );

    exec(
        &f,
        "create table big as select g as k from generate_series(1, 10001) g",
    );
    let error = sql_source::run_query(&f.dsn, "select k from big", sql_source::MAX_ROWS)
        .err()
        .unwrap();
    assert!(
        error.to_string().contains("more than 10000 rows"),
        "{error}"
    );
}

#[test]
fn routes_stay_closed_while_the_plugin_is_off() {
    let f = fixture();
    call(&f, "POST", "/enable", &json!({"enabled": false}));
    for (method, sub) in [
        ("GET", "/status"),
        ("POST", "/preview"),
        ("POST", "/sources"),
        ("POST", "/refresh/x"),
    ] {
        assert_eq!(call(&f, method, sub, &json!({})).0, 403, "{sub}");
    }
    assert_eq!(call(&f, "GET", "/settings", &json!({})).0, 200);
}
