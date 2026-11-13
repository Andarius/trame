mod common;
use common::TestDb;

#[test]
#[allow(
    clippy::case_sensitive_file_extension_comparisons,
    reason = "build output names are lowercase; exact match intended"
)]
fn built_frontend_uses_source_mime_cache_and_missing_asset_contract() {
    let t = TestDb::new();
    let base = t.base_url();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let client = reqwest::Client::new();
    let dist = trame_local::workspace().join("app/web/dist/assets");
    let asset = std::fs::read_dir(dist)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .find(|name| name.ends_with(".js"))
        .unwrap();
    rt.block_on(async {
        let index = client.get(format!("{base}/")).send().await.unwrap();
        assert_eq!(index.status(), 200);
        assert_eq!(index.headers()["content-type"], "text/html");
        assert_eq!(index.headers()["cache-control"], "no-cache");
        assert!(index.text().await.unwrap().contains("<div id=\"root\""));
        let response = client
            .get(format!("{base}/assets/{asset}"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["content-type"], "text/javascript");
        assert_eq!(
            response.headers()["cache-control"],
            "public, max-age=31536000, immutable"
        );
        assert!(!response.bytes().await.unwrap().is_empty());
        assert_eq!(
            client
                .get(format!("{base}/assets/missing-asset.js"))
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
        let fallback = client
            .get(format!("{base}/no-such-page.html"))
            .send()
            .await
            .unwrap();
        assert_eq!(fallback.status(), 200);
        assert!(
            fallback
                .text()
                .await
                .unwrap()
                .contains("Frontend not built")
        );
    });
}

#[test]
fn polled_board_answers_304_until_it_changes() {
    let t = TestDb::new();
    let base = t.base_url();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let client = reqwest::Client::new();
    rt.block_on(async {
        let get = |tag: Option<String>| {
            let mut req = client.get(format!("{base}/api/board"));
            if let Some(tag) = tag {
                req = req.header("if-none-match", tag);
            }
            req.send()
        };
        let first = get(None).await.unwrap();
        assert_eq!(first.status(), 200);
        let tag = first.headers()["etag"].to_str().unwrap().to_owned();
        assert_eq!(get(Some(tag.clone())).await.unwrap().status(), 304);
        let created = client
            .post(format!("{base}/api/sessions"))
            .json(&serde_json::json!({"title": "Etag check", "repo_path": "/tmp/etag"}))
            .send()
            .await
            .unwrap();
        assert!(created.status().is_success());
        let changed = get(Some(tag.clone())).await.unwrap();
        assert_eq!(changed.status(), 200);
        assert_ne!(changed.headers()["etag"], tag.as_str());
    });
}
