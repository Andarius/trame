mod common;
use common::TestDb;
use serde_json::{Value, json};
use trame_local::{
    settings,
    sync::{self, Change, Sync},
};

fn pair(t: &mut TestDb) -> (Change, Change) {
    let id = t
        .request("POST", "/api/sessions", json!({"title":"fk order"}))
        .1["id"]
        .clone();
    t.request(
        "POST",
        &format!("/api/sessions/{}/events", id.as_str().unwrap()),
        json!({"summary":"first log"}),
    );
    let session =
        t.db.query("select * from sessions where id=$1", &[id.clone()])
            .unwrap()
            .remove(0);
    let event =
        t.db.query(
            "select * from session_events where session_id=$1 order by at",
            &[id.clone()],
        )
        .unwrap()
        .remove(0);
    t.db.query(
        "delete from session_events where session_id=$1",
        &[id.clone()],
    )
    .unwrap();
    t.db.query("delete from sessions where id=$1", &[id.clone()])
        .unwrap();
    (
        Change {
            rev: 1,
            entity: "sessions".into(),
            id: id.as_str().unwrap().into(),
            value: session.as_object().cloned(),
        },
        Change {
            rev: 1,
            entity: "session_events".into(),
            id: event["id"].as_str().unwrap().into(),
            value: event.as_object().cloned(),
        },
    )
}

#[test]
fn sync_apply_typescript_assertions() {
    let mut t = TestDb::new();
    for mode in 0..3 {
        let (session, event) = pair(&mut t);
        let windows = match mode {
            0 => vec![vec![event.clone(), session]],
            1 => vec![vec![event.clone()], vec![session]],
            _ => vec![vec![event.clone()]],
        };
        let mut deferred = Vec::new();
        for page in windows {
            sync::apply_changes(&mut t.db, page, &mut deferred).unwrap();
        }
        let left = usize::from(mode == 2);
        assert_eq!(deferred.len(), left);
        let n =
            t.db.query(
                "select count(*)::int as n from session_events where id=$1",
                &[json!(event.id)],
            )
            .unwrap();
        assert_eq!(n[0]["n"], json!(1 - left));
    }
}

#[test]
fn identity_schema_wire_assertions_and_lww_boundaries() {
    let mut t = TestDb::new();
    for e in &sync::registry().entities {
        let cols =
            t.db.query(
                "select column_name from information_schema.columns where table_name=$1",
                &[json!(e.name)],
            )
            .unwrap();
        assert!(!cols.is_empty(), "table {} exists", e.name);
        for c in &e.cols {
            assert!(
                cols.iter().any(|v| v["column_name"] == c.as_str()),
                "{}.{} exists",
                e.name,
                c
            );
        }
    }
    assert!(sync::lww_upsert("users;drop table pages", &serde_json::Map::new()).is_err());
    let id = t
        .request("POST", "/api/pages", json!({"title":"new value"}))
        .1["id"]
        .clone();
    let mut row =
        t.db.query("select * from pages where id=$1", &[id.clone()])
            .unwrap()
            .remove(0);
    row["updated_at"] = json!("2000-01-01T00:00:00.000Z");
    row["title"] = json!("stale value");
    sync::apply_changes(
        &mut t.db,
        vec![Change {
            rev: 999,
            entity: "pages".into(),
            id: id.as_str().unwrap().into(),
            value: row.as_object().cloned(),
        }],
        &mut Vec::new(),
    )
    .unwrap();
    assert_eq!(
        t.request(
            "GET",
            &format!("/api/pages/{}", id.as_str().unwrap()),
            Value::Null
        )
        .1["title"],
        "new value"
    );
}

#[test]
fn rejected_mutations_keep_watermark_and_failed_pull_keeps_cursor() {
    let mut t = TestDb::new();
    t.request("POST", "/api/pages", json!({"title":"queued local edit"}));
    let before =
        t.db.query(
            "select api_cursor,last_pushed_at from sync_state where id=1",
            &[],
        )
        .unwrap()
        .remove(0);
    let config = Sync::new(
        t.root.clone(),
        t.root.join("settings.json"),
        t.db.origin.clone(),
        false,
    );
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async{
        use axum::{Json,Router,routing::post};
        use std::sync::{Arc,Mutex};
        let calls=Arc::new(Mutex::new(Vec::<Value>::new()));
        let record=calls.clone();
        let server=Router::new().route("/sync",post(move|headers:axum::http::HeaderMap,Json(body):Json<Value>|{
            let record=record.clone();async move{
                assert_eq!(headers["x-trame-protocol"],sync::registry().version.to_string());
                assert_eq!(headers["authorization"],"Bearer fixture-token");
                let mut requests=record.lock().unwrap();requests.push(body.clone());
                let count=requests.len();
                let mutation=body["mutations"][0]["mutationId"].clone();
                let response=match count{
                    1=>json!({"acknowledgements":[],"rejectedMutations":[{"mutationId":mutation,"reason":"fixture rejection"}],"changes":[],"nextCursor":10,"hasMore":false}),
                    2=>json!({"acknowledgements":[],"rejectedMutations":[],"changes":[],"nextCursor":20,"hasMore":true}),
                    _=>json!({"error":"fixture interrupted pull"}),
                };
                (if count<3{axum::http::StatusCode::OK}else{axum::http::StatusCode::SERVICE_UNAVAILABLE},Json(response))
            }
        }));
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address=listener.local_addr().unwrap();
        settings::save_explore(&config.settings,&json!({"hubApi":format!("http://{address}"),"hubApiToken":"fixture-token"})).unwrap();
        let server=tokio::spawn(async move{axum::serve(listener,server).await.unwrap()});
        let result=config.once().await.unwrap();assert_eq!(result["pulled"],0);
        let state=config.db(|db|Ok(db.query("select api_cursor,last_pushed_at from sync_state where id=1",&[])?.remove(0))).await.unwrap();
        assert_eq!(state["api_cursor"],10);assert_eq!(state["last_pushed_at"],before["last_pushed_at"]);
        assert!(config.once().await.is_err());
        let after=config.db(|db|Ok(db.query("select api_cursor,last_pushed_at from sync_state where id=1",&[])?.remove(0))).await.unwrap();assert_eq!(state,after);
        let calls=calls.lock().unwrap();assert_eq!(calls.len(),3);assert!(!calls[0]["mutations"].as_array().unwrap().is_empty());assert_eq!(calls[0]["mutations"],calls[1]["mutations"]);assert_eq!(calls[2]["mutations"],json!([]));
        server.abort();
    });
}

#[test]
fn offline_sync_does_not_contact_even_configured_hub() {
    let t = TestDb::new();
    settings::save_explore(
        &t.root.join("settings.json"),
        &json!({"hubApi":"https://never-contact.invalid","hubApiToken":"fixture-token"}),
    )
    .unwrap();
    let config = Sync::new(
        t.root.clone(),
        t.root.join("settings.json"),
        t.db.origin.clone(),
        true,
    );
    assert_eq!(
        tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(config.once())
            .unwrap(),
        Value::Null
    );
}

#[test]
fn realtime_sends_cursor_and_turns_changed_into_a_sync_nudge() {
    let mut t = TestDb::new();
    t.db.query("update sync_state set api_cursor=42 where id=1", &[])
        .unwrap();
    let config = Sync::new(
        t.root.clone(),
        t.root.join("settings.json"),
        t.db.origin.clone(),
        false,
    );
    tokio::runtime::Runtime::new().unwrap().block_on(async{
        use futures_util::{SinkExt,StreamExt};
        use tokio_tungstenite::tungstenite::Message;
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        settings::save_explore(&config.settings,&json!({"hubApi":format!("http://{}",listener.local_addr().unwrap()),"hubApiToken":"fixture-token"})).unwrap();
        let task=tokio::spawn(config.clone().realtime());
        let peer=tokio::spawn(async move{
            let (stream,_)=listener.accept().await.unwrap();
            let mut ws=tokio_tungstenite::accept_async(stream).await.unwrap();
            let hello=ws.next().await.unwrap().unwrap();
            assert_eq!(serde_json::from_str::<Value>(hello.to_text().unwrap()).unwrap(),json!({"type":"hello","cursor":42}));
            ws.send(Message::Text("{\"type\":\"changed\",\"rev\":43}".into())).await.unwrap();
        });
        tokio::time::timeout(std::time::Duration::from_secs(5),config.nudge.notified()).await.unwrap();
        peer.await.unwrap();task.abort();let _=task.await;
    });
}
