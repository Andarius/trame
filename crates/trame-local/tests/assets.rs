#![allow(unsafe_code, reason = "tests mutate env vars (set_var/remove_var)")]

mod common;
use common::TestDb;
use serde_json::{Value, json};
use std::{
    fs,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use trame_local::{sessions, settings};
static TEST_ENV_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn native_assets_reports_and_report_files_preserve_http_contract() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let mut t = TestDb::new();
    let base = t.base_url();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let client = reqwest::Client::new();
    let png = vec![137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3];
    let id = rt.block_on(async {
        let upload = client
            .post(format!("{base}/api/assets"))
            .header("content-type", "image/png")
            .body(png.clone())
            .send()
            .await
            .unwrap();
        assert_eq!(upload.status(), 200);
        let id = upload.json::<Value>().await.unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let got = client
            .get(format!("{base}/api/assets/{id}"))
            .send()
            .await
            .unwrap();
        assert_eq!(got.status(), 200);
        assert_eq!(got.headers()["content-type"], "image/png");
        assert_eq!(got.headers()["x-content-type-options"], "nosniff");
        assert_eq!(
            got.headers()["cache-control"],
            "public, max-age=31536000, immutable"
        );
        assert_eq!(got.bytes().await.unwrap().to_vec(), png);
        assert_eq!(
            client
                .post(format!("{base}/api/assets"))
                .header("content-type", "text/html")
                .body("no")
                .send()
                .await
                .unwrap()
                .status(),
            400
        );
        assert_eq!(
            client
                .post(format!("{base}/api/assets"))
                .header("content-type", "image/png")
                .body(vec![0; 10 * 1024 * 1024 + 1])
                .send()
                .await
                .unwrap()
                .status(),
            413
        );
        assert_eq!(
            client
                .get(format!(
                    "{base}/api/assets/00000000-0000-4000-8000-000000000099"
                ))
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
        id
    });
    t.db.query(
        "update assets set path='../../outside' where id=$1",
        &[json!(id)],
    )
    .unwrap();
    rt.block_on(async {
        assert_eq!(
            client
                .get(format!("{base}/api/assets/{id}"))
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
    });
    let report_id = sessions::create_report(
        &mut t.db,
        &json!({"title":"Raw report","html":"<h1>Raw report</h1>"}),
    )
    .unwrap();
    let report_id = report_id.as_str().unwrap();
    rt.block_on(async {
        let report = client
            .get(format!("{base}/report/{report_id}"))
            .send()
            .await
            .unwrap();
        assert_eq!(report.status(), 200);
        assert_eq!(report.headers()["content-type"], "text/html; charset=utf-8");
        assert_eq!(report.text().await.unwrap(), "<h1>Raw report</h1>");
        assert_eq!(
            client
                .get(format!(
                    "{base}/report/00000000-0000-4000-8000-000000000099"
                ))
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
    });
    let reports = t.root.join("reports");
    fs::create_dir(&reports).unwrap();
    let html = reports.join("sample.html");
    let scene = reports.join("diagram.excalidraw");
    fs::write(&html, "<p>fixture</p>").unwrap();
    fs::write(
        &scene,
        r#"{"type":"excalidraw","elements":[],"appState":{"collaborators":[]}}"#,
    )
    .unwrap();
    settings::save_explore(
        &t.root.join("settings.json"),
        &json!({"reportPaths":[reports]}),
    )
    .unwrap();
    rt.block_on(async {
        let file = client
            .get(format!("{base}/report-file"))
            .query(&[("path", html.to_str().unwrap())])
            .send()
            .await
            .unwrap();
        assert_eq!(file.status(), 200);
        assert_eq!(file.text().await.unwrap(), "<p>fixture</p>");
        let editor = client
            .get(format!("{base}/report-file"))
            .query(&[("path", scene.to_str().unwrap())])
            .send()
            .await
            .unwrap();
        assert_eq!(editor.status(), 200);
        let body = editor.text().await.unwrap();
        assert!(body.contains("serializeAsJSON"));
        assert!(body.contains("id=\"scene\""));
        let post = |body: &str| {
            client
                .post(format!("{base}/report-file"))
                .query(&[("path", scene.to_str().unwrap())])
                .body(body.to_owned())
                .send()
        };
        assert_eq!(post("no json").await.unwrap().status(), 400);
        assert_eq!(post(r#"{"type":"other"}"#).await.unwrap().status(), 400);
        assert_eq!(
            post(r#"{"type":"excalidraw","elements":[{"id":"one"}]}"#)
                .await
                .unwrap()
                .status(),
            200
        );
        assert_eq!(
            client
                .post(format!("{base}/report-file"))
                .query(&[("path", html.to_str().unwrap())])
                .body(r#"{"type":"excalidraw"}"#)
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
        assert_eq!(
            client
                .get(format!("{base}/report-file?path=/etc/passwd"))
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
    });
    assert!(fs::read_to_string(&scene).unwrap().contains("one"));
}

#[test]
fn s3_assets_use_local_mock_and_preserve_metadata() {
    use axum::{
        Router,
        body::Body,
        http::{Method, Request, StatusCode},
        response::{IntoResponse, Response},
    };
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let stored = Arc::new(Mutex::new(Vec::<u8>::new()));
    let handler_store = stored.clone();
    let redirect = Arc::new(AtomicBool::new(false));
    let leaked = Arc::new(AtomicBool::new(false));
    let handler_redirect = redirect.clone();
    let handler_leaked = leaked.clone();
    let router = Router::new().fallback(move |req: Request<Body>| {
        let stored = handler_store.clone();
        let redirect = handler_redirect.clone();
        let leaked = handler_leaked.clone();
        async move {
            let (parts, body) = req.into_parts();
            if parts.uri.path() == "/leak" {
                leaked.store(true, Ordering::SeqCst);
                return (StatusCode::OK, "leaked").into_response();
            }
            assert!(
                parts
                    .uri
                    .path()
                    .starts_with("/fixture-bucket/trame-assets/")
            );
            assert!(
                parts
                    .headers
                    .get("authorization")
                    .and_then(|h| h.to_str().ok())
                    .is_some_and(|s| s.contains("Credential=fixture-access/"))
            );
            if parts.method == Method::PUT {
                let bytes = axum::body::to_bytes(body, 11 * 1024 * 1024).await.unwrap();
                *stored.lock().unwrap() = bytes.to_vec();
                Response::builder()
                    .status(StatusCode::OK)
                    .body(Body::empty())
                    .unwrap()
            } else {
                if redirect.load(Ordering::SeqCst) {
                    return Response::builder()
                        .status(StatusCode::FOUND)
                        .header("location", "/leak")
                        .body(Body::empty())
                        .unwrap();
                }
                (StatusCode::OK, stored.lock().unwrap().clone()).into_response()
            }
        }
    });
    let (endpoint, server) = rt.block_on(async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (endpoint, server)
    });
    unsafe {
        std::env::set_var("TRACKER_S3_ENDPOINT", &endpoint);
        std::env::set_var("TRACKER_S3_BUCKET", "fixture-bucket");
        std::env::set_var("TRACKER_S3_ACCESS_KEY", "fixture-access");
        std::env::set_var("TRACKER_S3_SECRET_KEY", "fixture-secret");
    }
    let mut t = TestDb::new();
    let base = t.base_url();
    let client = reqwest::Client::new();
    let bytes = vec![1, 2, 3, 4, 5];
    let id = rt.block_on(async {
        let response = client
            .post(format!("{base}/api/assets"))
            .header("content-type", "image/png")
            .body(bytes.clone())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        response.json::<Value>().await.unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    });
    let row =
        t.db.query("select store,path from assets where id=$1", &[json!(id)])
            .unwrap();
    assert_eq!(row[0]["store"], "s3");
    assert!(
        row[0]["path"]
            .as_str()
            .unwrap()
            .starts_with("trame-assets/")
    );
    rt.block_on(async {
        let got = client
            .get(format!("{base}/api/assets/{id}"))
            .send()
            .await
            .unwrap();
        assert_eq!(got.status(), 200);
        assert_eq!(got.bytes().await.unwrap().to_vec(), bytes);
    });
    assert_eq!(*stored.lock().unwrap(), bytes);
    redirect.store(true, Ordering::SeqCst);
    rt.block_on(async {
        let got = client
            .get(format!("{base}/api/assets/{id}"))
            .send()
            .await
            .unwrap();
        assert_eq!(got.status(), 404);
    });
    assert!(!leaked.load(Ordering::SeqCst));
    drop(t);
    server.abort();
    unsafe {
        for key in [
            "TRACKER_S3_ENDPOINT",
            "TRACKER_S3_BUCKET",
            "TRACKER_S3_ACCESS_KEY",
            "TRACKER_S3_SECRET_KEY",
        ] {
            std::env::remove_var(key);
        }
    }
}

#[test]
fn offline_assets_reject_ambient_external_s3_without_writing_metadata() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    unsafe {
        std::env::set_var("TRACKER_S3_ENDPOINT", "https://s3.example.invalid");
        std::env::set_var("TRACKER_S3_BUCKET", "fixture-bucket");
        std::env::set_var("TRACKER_S3_ACCESS_KEY", "fixture-access");
        std::env::set_var("TRACKER_S3_SECRET_KEY", "fixture-secret");
    }
    let mut t = TestDb::new();
    let base = t.base_url();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let client = reqwest::Client::new();
    let before = t.db.query("select count(*) as n from assets", &[]).unwrap()[0]["n"].clone();
    rt.block_on(async {
        let put = client
            .post(format!("{base}/api/assets"))
            .header("content-type", "image/png")
            .body(vec![1])
            .send()
            .await
            .unwrap();
        assert_eq!(put.status(), 503);
        assert_eq!(
            put.json::<Value>().await.unwrap()["error"],
            "unavailable in offline mode"
        );
    });
    assert_eq!(
        t.db.query("select count(*) as n from assets", &[]).unwrap()[0]["n"],
        before
    );
    let id = t.db.query(
        "insert into assets(mime,store,path) values('image/png','s3','trame-assets/fixture.png') returning id",
        &[],
    ).unwrap()[0]["id"].as_str().unwrap().to_owned();
    rt.block_on(async {
        let got = client
            .get(format!("{base}/api/assets/{id}"))
            .send()
            .await
            .unwrap();
        assert_eq!(got.status(), 503);
        assert_eq!(
            got.json::<Value>().await.unwrap()["error"],
            "unavailable in offline mode"
        );
    });
    drop(t);
    unsafe {
        for key in [
            "TRACKER_S3_ENDPOINT",
            "TRACKER_S3_BUCKET",
            "TRACKER_S3_ACCESS_KEY",
            "TRACKER_S3_SECRET_KEY",
        ] {
            std::env::remove_var(key);
        }
    }
}
