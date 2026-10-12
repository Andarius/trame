mod common;

use common::TestDb;
use serde_json::json;
use std::{sync::mpsc, time::Duration};
use trame_local::{db::Db, sync};

#[test]
fn sync_scan_and_local_writes_share_an_operation_gate() {
    let mut test = TestDb::new();
    let root = test.root.clone();
    let page = test
        .request("POST", "/api/pages", json!({"title":"before"}))
        .1["id"]
        .clone();
    test.db
        .client
        .batch_execute("begin; lock pages in access exclusive mode")
        .unwrap();
    let scan_root = root.clone();
    let scanner = std::thread::spawn(move || {
        let mut db = Db::connect(&scan_root.join("socket"), "rust-slice2-test", None).unwrap();
        sync::assemble(&mut db).unwrap()
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        test.db
            .client
            .simple_query("select pg_stat_clear_snapshot()")
            .unwrap();
        let waiting: bool = test.db.client.query_one("select exists(select 1 from pg_stat_activity where wait_event_type='Lock' and query like 'select % from pages where origin=%')", &[]).unwrap().get(0);
        if waiting {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "scan did not reach pages"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let (done_tx, done_rx) = mpsc::channel();
    let changed = page.clone();
    let writer = std::thread::spawn(move || {
        let mut db = Db::connect(&root.join("socket"), "rust-slice2-test", None).unwrap();
        db.query("update sync_state set api_cursor=123 where id=1", &[])
            .unwrap();
        done_tx.send(()).unwrap();
        db.query(
            "update pages set title='after',updated_at=clock_timestamp() where id=$1",
            &[changed],
        )
        .unwrap();
    });
    let interleaved = done_rx.recv_timeout(Duration::from_millis(100)).is_ok();
    test.db.client.batch_execute("commit").unwrap();
    let snapshot = scanner.join().unwrap();
    writer.join().unwrap();
    assert!(!interleaved, "writer interleaved the scan");
    assert!(
        snapshot
            .1
            .iter()
            .any(|row| row["id"] == page && row["value"]["title"] == "before")
    );
    test.db
        .query(
            "update sync_state set last_pushed_at=$1 where id=1",
            &[json!(snapshot.3)],
        )
        .unwrap();
    let next = sync::assemble(&mut test.db).unwrap();
    assert!(
        next.1
            .iter()
            .any(|row| row["id"] == page && row["value"]["title"] == "after")
    );
}

#[test]
fn parallel_specs_requests_keep_one_page_and_do_not_exhaust_connections() {
    let mut test = TestDb::new();
    let session = test
        .request("POST", "/api/sessions", json!({"title":"concurrent specs"}))
        .1["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let base = test.base_url();
    let pages = tokio::runtime::Runtime::new().unwrap().block_on(async {
        let client = reqwest::Client::new();
        let requests = (0..128).map(|_| {
            let client = &client;
            let url = format!("{base}/api/sessions/{session}/specs-page");
            async move {
                let response = client.post(url).send().await.unwrap();
                assert_eq!(response.status(), 200);
                response.json::<serde_json::Value>().await.unwrap()["page_id"].clone()
            }
        });
        futures_util::future::join_all(requests).await
    });
    assert!(
        pages
            .iter()
            .all(|page| page == &pages[0] && page.is_string())
    );
    let stored = test
        .db
        .query(
            "select count(*)::int as n from pages where id=$1",
            &[pages[0].clone()],
        )
        .unwrap();
    assert_eq!(stored[0]["n"], 1);
}

#[test]
fn reviewed_api_errors_and_non_string_summaries_match_the_oracle() {
    let mut test = TestDb::new();
    for path in ["/api/tags/not-a-uuid", "/api/tags/not-a-uuid/delete"] {
        let response = test.request("POST", path, json!({}));
        assert_eq!(
            response,
            (
                400,
                json!({"error":"invalid input syntax for type uuid: \"not-a-uuid\""})
            )
        );
    }
    let session = test
        .request("POST", "/api/sessions", json!({"title":"event types"}))
        .1["id"]
        .clone();
    for (summary, expected) in [
        (json!(12), "12"),
        (json!(false), "false"),
        (json!(null), ""),
    ] {
        test.request(
            "POST",
            &format!("/api/sessions/{}/events", session.as_str().unwrap()),
            json!({"summary":summary}),
        );
        let rows = test.db.query("select summary from session_events where session_id=$1 and kind='log' order by at desc limit 1", std::slice::from_ref(&session)).unwrap();
        assert_eq!(rows[0]["summary"], expected);
    }
    let cwd = test.root.join("repo with space");
    std::fs::create_dir(&cwd).unwrap();
    let response = trame_local::platform::handle(
        &mut test.db,
        0,
        "/api/watcher/start",
        &json!({"agent":"codex","cwd":cwd,"probe":true}),
    )
    .unwrap();
    assert_eq!(response.0, 200);
    assert_eq!(response.1["launched"], false);
    assert!(
        response.1["cmd"]
            .as_str()
            .unwrap()
            .contains(&format!("--cwd '{}'", cwd.display()))
    );
}
