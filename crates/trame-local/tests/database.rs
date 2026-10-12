mod common;
use common::TestDb;
use serde_json::{Value, json};
#[test]
fn original_changelog_assertions() {
    let mut t = TestDb::new();
    let id = t
        .request("POST", "/api/pages", json!({"title":"logged page"}))
        .1["id"]
        .clone();
    t.request(
        "POST",
        &format!("/api/pages/{}", id.as_str().unwrap()),
        json!({"title":"renamed"}),
    );
    t.request(
        "POST",
        &format!("/api/pages/{}/delete", id.as_str().unwrap()),
        Value::Null,
    );
    let log =
        t.db.query(
            "select rev,entity,op from change_log where row_id=$1 order by rev",
            &[id],
        )
        .unwrap();
    assert_eq!(
        log.iter()
            .map(|l| l["op"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["upsert", "upsert", "delete"]
    );
    assert_eq!(
        log.iter()
            .map(|l| l["entity"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["pages", "pages", "pages"]
    );
    assert!(
        log[0]["rev"].as_i64() < log[1]["rev"].as_i64()
            && log[1]["rev"].as_i64() < log[2]["rev"].as_i64()
    );
    t.db.batch_execute("insert into pages(id,title,origin,owner_id) values ('00000000-0000-4000-8000-00000000cccc','pulled','other-node','00000000-0000-4000-8000-000000000101')").unwrap();
    let log=t.db.query("select op,actor,source from change_log where row_id='00000000-0000-4000-8000-00000000cccc'",&[]).unwrap();
    assert_eq!(log.len(), 1);
    assert_eq!(log[0]["op"], "upsert");
    assert_eq!(log[0]["actor"], Value::Null);
    assert_eq!(log[0]["source"], Value::Null);
    t.db.batch_execute("set trame.actor='00000000-0000-4000-8000-000000000101';set trame.source='api';insert into pages(id,title,origin,owner_id) values ('00000000-0000-4000-8000-00000000dddd','via api','hub-api','00000000-0000-4000-8000-000000000101');reset trame.actor;reset trame.source;").unwrap();
    let log=t.db.query("select actor,source from change_log where row_id='00000000-0000-4000-8000-00000000dddd'",&[]).unwrap();
    assert_eq!(log[0]["actor"], "00000000-0000-4000-8000-000000000101");
    assert_eq!(log[0]["source"], "api");
    t.db.batch_execute("insert into change_log(entity,row_id,op,at) values ('pages','00000000-0000-4000-8000-00000000eeee','upsert',now()-interval '40 days')").unwrap();
    let before =
        t.db.query("select count(*)::int as n from change_log", &[])
            .unwrap()[0]["n"]
            .as_i64()
            .unwrap();
    t.db.batch_execute(include_str!("../../../db/schema.sql"))
        .unwrap();
    assert!(
        t.db.query(
            "select 1 from change_log where row_id='00000000-0000-4000-8000-00000000eeee'",
            &[]
        )
        .unwrap()
        .is_empty()
    );
    assert_eq!(
        t.db.query("select count(*)::int as n from change_log", &[])
            .unwrap()[0]["n"],
        before - 1
    );
    t.db.batch_execute("insert into pages(id,title,origin) values ('00000000-0000-4000-8000-00000000ffff','post rerun','cl-test')").unwrap();
    assert_eq!(t.db.query("select count(*)::int as n from change_log where row_id='00000000-0000-4000-8000-00000000ffff'",&[]).unwrap()[0]["n"],1);
}
#[test]
fn original_adapter_types_and_failed_transaction_assertions() {
    let mut t = TestDb::new();
    t.db.batch_execute("create temporary table adapter_test(id int primary key,data jsonb);insert into adapter_test values(1,'{\"seed\":true}')").unwrap();
    let data = json!([{"text":"page block"}]);
    t.db.query(
        "insert into adapter_test values($1,$2)",
        &[json!(2), json!(data.to_string())],
    )
    .unwrap();
    let rows=t.db.query("select data,count(*) over() as n,1.25::numeric as amount,'2026-10-11T12:00:00Z'::timestamptz as at,$1::uuid[] as ids from adapter_test where id=2",&[json!(["a89f8286-e5d9-4931-9f52-9043726d61ea"])]).unwrap();
    assert_eq!(rows[0]["data"], data);
    assert_eq!(rows[0]["n"], 1);
    assert_eq!(rows[0]["amount"], "1.25");
    assert!(rows[0]["at"].is_string());
    assert_eq!(rows[0]["at"], "2026-10-11T12:00:00.000Z");
    assert_eq!(
        rows[0]["ids"],
        json!(["a89f8286-e5d9-4931-9f52-9043726d61ea"])
    );
    assert!(t.db.batch_execute("begin;insert into adapter_test values(3,'{}');insert into adapter_test values(1,'{}');commit;").is_err());
    t.db.batch_execute("rollback").unwrap();
    assert_eq!(
        t.db.query("select id from adapter_test order by id", &[])
            .unwrap(),
        vec![json!({"id":1}), json!({"id":2})]
    );
    t.db.batch_execute("begin;insert into adapter_test values(3,'{}');commit;")
        .unwrap();
    assert_eq!(
        t.db.query("select 'committed' as result", &[]).unwrap()[0]["result"],
        "committed"
    );
    assert_eq!(
        t.db.query("select id from adapter_test where id=3", &[])
            .unwrap(),
        vec![json!({"id":3})]
    );
    for literal in [
        "0",
        "-1.2500",
        "123456789.00001",
        "0.000000001",
        "NaN",
        "Infinity",
        "-Infinity",
    ] {
        let row =
            t.db.query(
                "select $1::numeric as n,($1::numeric)::text as expected",
                &[json!(literal)],
            )
            .unwrap();
        assert_eq!(row[0]["n"], row[0]["expected"], "{literal}");
    }
}
