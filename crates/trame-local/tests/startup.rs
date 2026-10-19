mod common;
use common::TestDb;
use serde_json::json;
#[test]
fn native_schema_and_outbox_retry_preserve_failed_writes() {
    let mut t = TestDb::new();
    let path = t.root.join("pending.jsonl");
    let body = json!({"id":"00000000-0000-4000-8000-00000000aa01","title":"Queued while offline","branch":"main","repo":"fixture","cwd":t.root});
    std::fs::write(&path, format!("{body}\nnot json\n")).unwrap();
    assert_eq!(
        trame_local::startup::drain_outbox(&mut t.db, &path).unwrap(),
        1
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "not json\n");
    assert_eq!(
        t.db.query(
            "select title from sessions where id='00000000-0000-4000-8000-00000000aa01'",
            &[]
        )
        .unwrap()[0]["title"],
        "Queued while offline"
    );
    assert_eq!(
        trame_local::startup::drain_outbox(&mut t.db, &path).unwrap(),
        0
    );
    std::fs::write(&path, format!("{body}\n")).unwrap();
    assert_eq!(
        trame_local::startup::drain_outbox(&mut t.db, &path).unwrap(),
        1
    );
    assert!(!path.exists());
    assert_eq!(t.db.query("select count(*)::int as n from sessions where id='00000000-0000-4000-8000-00000000aa01'",&[]).unwrap()[0]["n"],1);
}
#[test]
fn stamped_outbox_receipt_prevents_replay_of_idless_session() {
    let mut t = TestDb::new();
    let path = t.root.join("idless-outbox.jsonl");
    let body = json!({"title":"Created from outbox","repo_path":t.root.join("idless-repo"),"branch":"receipt-test"});
    let receipt = "00000000-0000-4000-8000-00000000bb01";
    let mut stamped = body.clone();
    stamped["_trame_outbox_id"] = json!(receipt);
    std::fs::write(&path, format!("{stamped}\n")).unwrap();
    assert_eq!(
        trame_local::startup::drain_outbox(&mut t.db, &path).unwrap(),
        1
    );
    let first =
        t.db.query(
            "select id from sessions where title='Created from outbox'",
            &[],
        )
        .unwrap();
    assert_eq!(first.len(), 1);
    std::fs::write(&path, format!("{stamped}\n")).unwrap();
    assert_eq!(
        trame_local::startup::drain_outbox(&mut t.db, &path).unwrap(),
        0
    );
    assert!(!path.exists());
    assert_eq!(
        t.db.query(
            "select id from sessions where title='Created from outbox'",
            &[]
        )
        .unwrap(),
        first
    );
    assert_eq!(
        t.db.query(
            "select count(*)::int as n from trame_local.outbox_receipts where id=$1::uuid",
            &[json!(receipt)]
        )
        .unwrap()[0]["n"],
        1
    );
}

#[test]
fn failed_outbox_line_keeps_stamp_and_rolls_back_receipt() {
    let mut t = TestDb::new();
    let path = t.root.join("retry-outbox.jsonl");
    let bad = json!({"id":"invalid-uuid","title":"Retry me","client":"Outbox rollback project","repo_path":t.root.join("retry-repo")});
    std::fs::write(&path, format!("{bad}\n")).unwrap();
    assert_eq!(
        trame_local::startup::drain_outbox(&mut t.db, &path).unwrap(),
        0
    );
    let mut stamped: serde_json::Value =
        serde_json::from_str(std::fs::read_to_string(&path).unwrap().trim()).unwrap();
    let receipt = stamped["_trame_outbox_id"].as_str().unwrap().to_owned();
    assert!(uuid::Uuid::parse_str(&receipt).is_ok());
    assert!(
        t.db.query(
            "select id from trame_local.outbox_receipts where id=$1::uuid",
            &[json!(receipt)]
        )
        .unwrap()
        .is_empty()
    );
    assert!(
        t.db.query(
            "select id from pages where kind='project' and title='Outbox rollback project'",
            &[]
        )
        .unwrap()
        .is_empty()
    );
    stamped["id"] = json!("00000000-0000-4000-8000-00000000bb02");
    std::fs::write(&path, format!("{stamped}\n")).unwrap();
    assert_eq!(
        trame_local::startup::drain_outbox(&mut t.db, &path).unwrap(),
        1
    );
    assert!(!path.exists());
}
#[tokio::test]
async fn native_runtime_routes_and_unknown_routes() {
    let t = tokio::task::spawn_blocking(TestDb::new).await.unwrap();
    let client = reqwest::Client::new();
    let base = t.base_url();
    let status: serde_json::Value = client
        .get(format!("{base}/api/status"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(status["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(status["nodeId"], "rust-slice2-test");
    assert_eq!(
        client
            .post(format!("{base}/api/pr-state"))
            .json(&json!({"url":"file:///etc/passwd"}))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    let pr: serde_json::Value = client
        .post(format!("{base}/api/pr-state"))
        .json(&json!({"url":"https://fixture.invalid/pr/1"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        pr,
        json!({"url":"https://fixture.invalid/pr/1","state":"unknown"})
    );
    assert_eq!(
        client
            .post(format!("{base}/api/update"))
            .send()
            .await
            .unwrap()
            .status(),
        503
    );
    assert_eq!(
        client
            .get(format!("{base}/api/not-a-route"))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    tokio::task::spawn_blocking(move || drop(t)).await.unwrap();
}
