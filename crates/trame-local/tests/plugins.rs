mod common;
use common::TestDb;
use serde_json::{Value, json};
use trame_local::plugins;

#[test]
fn a_write_plan_that_fails_leaves_nothing_written() {
    use plugins::api::{Write, apply};
    let mut t = TestDb::new();
    let ok = apply(
        &mut t.db,
        &[
            Write::CreatePage(json!({"title": "kept"})),
            Write::EnsureTag {
                label: "fixture-tag".into(),
                color: None,
            },
        ],
    )
    .unwrap();
    let kept = ok[0].as_str().unwrap().to_owned();
    let failed = apply(
        &mut t.db,
        &[
            Write::CreatePage(json!({"title": "rolled back"})),
            Write::UpdatePage {
                id: kept.clone(),
                patch: json!({"title": "renamed"}),
            },
            Write::UpdatePage {
                id: kept.clone(),
                patch: json!({"status": "not-a-status"}),
            },
        ],
    );
    assert!(failed.is_err());
    let titles: Vec<Value> =
        t.db.query(
            "select title from pages where not deleted order by title",
            &[],
        )
        .unwrap()
        .into_iter()
        .map(|r| r["title"].clone())
        .collect();
    assert_eq!(titles, [json!("kept")]);
    let id = "6f1c2a3e-1b2c-4d5e-8f90-a1b2c3d4e5f6".to_owned();
    apply(
        &mut t.db,
        &[Write::UpsertSession(json!({"id": id, "title": "card"}))],
    )
    .unwrap();
    apply(
        &mut t.db,
        &[Write::AddSessionEvent {
            id: id.clone(),
            summary: "release waiting".into(),
            kind: "log".into(),
            body: json!("deployments"),
        }],
    )
    .unwrap();
    let events =
        t.db.query(
            "select summary from session_events where session_id=$1 and not deleted",
            &[json!(id)],
        )
        .unwrap();
    assert!(events.iter().any(|e| e["summary"] == "release waiting"));
}
