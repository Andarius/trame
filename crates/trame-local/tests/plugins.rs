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

#[cfg(feature = "wasm-plugins")]
fn call(t: &TestDb, method: &str, path: &str, body: &Value) -> (u16, Value) {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let res = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .request(method.parse().unwrap(), format!("{}{path}", t.base_url()))
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .unwrap();
        let status = res.status().as_u16();
        (status, res.json().await.unwrap_or(Value::Null))
    })
}

#[cfg(feature = "wasm-plugins")]
#[test]
fn a_wasm_package_loads_at_boot_and_serves_routes_writes_and_commands() {
    let wasm = include_bytes!("fixtures/wasm-hello/plugin.wasm");
    let mut t = TestDb::with_files(
        &[],
        &[
            ("plugins/wasm/hello/plugin.wasm", wasm),
            // a package whose folder is not its manifest id is skipped, not fatal
            ("plugins/wasm/renamed/plugin.wasm", wasm),
            ("plugins/wasm/broken/plugin.wasm", b"not wasm"),
        ],
    );
    let (_, list) = call(&t, "GET", "/api/plugins", &Value::Null);
    let ids: Vec<_> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].clone())
        .collect();
    assert_eq!(
        ids.iter().filter(|id| **id == "hello").count(),
        1,
        "{ids:?}"
    );
    assert!(
        !ids.contains(&json!("renamed")) && !ids.contains(&json!("broken")),
        "{ids:?}"
    );

    assert_eq!(
        call(&t, "GET", "/api/plugins/hello/greet?name=Ada", &Value::Null).0,
        403
    );
    call(
        &t,
        "POST",
        "/api/plugins/hello/enable",
        &json!({"enabled": true}),
    );
    // the plugin's sanitize keeps only `greeting`
    call(
        &t,
        "POST",
        "/api/plugins/hello/settings",
        &json!({"greeting": " Salut ", "token": "x"}),
    );
    let settings: Value =
        serde_json::from_slice(&std::fs::read(t.root.join("settings.json")).unwrap()).unwrap();
    assert_eq!(
        settings["plugins"]["hello"],
        json!({"enabled": true, "greeting": "Salut"})
    );

    for (method, path, body, want) in [
        (
            "GET",
            "/api/plugins/hello/greet?name=Ada",
            Value::Null,
            (200, json!({"text": "Salut, Ada!"})),
        ),
        (
            "POST",
            "/api/plugins/hello/cli",
            json!({"name": "greet", "args": ["Ada"]}),
            (
                200,
                json!({"code": 0, "text": "Salut, Ada!", "json": {"text": "Salut, Ada!"}}),
            ),
        ),
        (
            "GET",
            "/api/plugins/hello/nope",
            Value::Null,
            (404, json!({"error": "not found"})),
        ),
    ] {
        assert_eq!(call(&t, method, path, &body), want, "{method} {path}");
    }

    let (status, note) = call(
        &t,
        "POST",
        "/api/plugins/hello/note",
        &json!({"title": "from wasm"}),
    );
    assert_eq!(status, 200, "{note}");
    let page = trame_local::pages::get(&mut t.db, note["id"].as_str().unwrap()).unwrap();
    assert_eq!(page["title"], "from wasm");
}
