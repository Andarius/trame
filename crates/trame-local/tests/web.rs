mod common;
use common::TestDb;

#[test]
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
