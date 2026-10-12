mod common;

use common::TestDb;
use std::{sync::mpsc, time::Duration};
use trame_local::{blocking, db::Db};

#[test]
fn cancelled_awaiter_does_not_finish_drain_before_database_write() {
    let mut test = TestDb::new();
    let root = test.root.clone();
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(1)
        .enable_all()
        .build()
        .unwrap();

    let waiter = runtime.block_on(async {
        tokio::spawn(async move {
            blocking::spawn(move || {
                let mut db = Db::connect(
                    &root.join("socket"),
                    "rust-slice2-test",
                    Some(root.join("settings.json")),
                )
                .unwrap();
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                db.query("update sync_state set api_cursor=987 where id=1", &[])
                    .unwrap();
            })
            .await
        })
    });
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let queued = runtime.block_on(async { blocking::spawn(|| panic!("queued work ran")) });
    queued.abort();
    let drained_early = runtime.block_on(async {
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        tokio::time::timeout(Duration::from_millis(50), blocking::drain())
            .await
            .is_ok()
    });
    release_tx.send(()).unwrap();
    runtime.block_on(async {
        assert!(queued.await.unwrap_err().is_cancelled());
        tokio::time::timeout(Duration::from_secs(5), blocking::drain())
            .await
            .unwrap();
    });
    assert!(!drained_early, "drain finished before the database write");
    assert_eq!(
        test.db
            .query("select api_cursor from sync_state where id=1", &[])
            .unwrap()[0]["api_cursor"],
        987
    );
    runtime.block_on(async {
        let failed = blocking::spawn(|| panic!("panic releases guard"));
        assert!(failed.await.unwrap_err().is_panic());
        tokio::time::timeout(Duration::from_secs(5), blocking::drain())
            .await
            .unwrap();
    });
}
