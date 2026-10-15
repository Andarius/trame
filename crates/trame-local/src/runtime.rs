use crate::{
    routes::{Native, json_response},
    settings,
};
use axum::{
    body::Body,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
pub fn owns(method: &str, path: &str) -> bool {
    matches!(path, "/api/status" | "/api/update")
        || (method == "POST"
            && matches!(
                path,
                "/api/sync" | "/api/hub/test" | "/api/pr-state" | "/api/update/restart"
            ))
}

pub async fn serve(state: Native, req: Request<Body>) -> Response {
    let path = req.uri().path().to_owned();
    if path == "/api/update" {
        let force = req
            .uri()
            .query()
            .unwrap_or("")
            .split('&')
            .any(|q| q.split('=').next() == Some("force"));
        let (status, value) =
            crate::update::serve(req.method() == "POST", force, state.sync.offline).await;
        return json_response(status, value);
    }
    if path == "/api/update/restart" {
        return json_response(200, crate::update::restart(state.desktop));
    }
    if path == "/api/status" {
        return json_response(
            200,
            json!({"nodeId":state.origin,"remote":settings::hub_api(&state.settings).is_some(),"lastSync":*state.sync.last.lock().await,"dataDir":state.root.join("postgres"),"desktop":state.desktop,"debug":cfg!(debug_assertions),"version":version()}),
        );
    }
    if path == "/api/hub/test" && state.sync.offline {
        return json_response(503, json!({"error":"unavailable in offline mode"}));
    }
    if path == "/api/sync" {
        return match state.sync.once().await {
            Ok(result) => json_response(200, result),
            Err(error) => {
                eprintln!("sync: {error:#}");
                let (status, reason) = crate::sync::failure(&error);
                json_response(status, json!({"error":reason}))
            }
        };
    }
    let Ok(bytes) = axum::body::to_bytes(req.into_body(), usize::MAX).await else {
        return (StatusCode::BAD_REQUEST, "body unavailable").into_response();
    };
    let Ok(body) = serde_json::from_slice::<Value>(&bytes) else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response();
    };
    if path == "/api/pr-state" {
        let Some(url) = body["url"].as_str().filter(|s| s.starts_with("https://")) else {
            return json_response(400, json!({"error":"invalid url"}));
        };
        let url = url.to_owned();
        let value = crate::blocking::spawn(move || {
            let mut value = json!({"url":url});
            if let Some(info) = crate::forge::pr_info(&url, state.sync.offline).as_object() {
                for (k, v) in info {
                    value[k] = v.clone();
                }
            }
            value
        })
        .await
        .unwrap_or(Value::Null);
        return json_response(200, value);
    }
    let mut url = trame_core::trim(body["hubApi"].as_str().unwrap_or("")).to_owned();
    let mut token = trame_core::trim(body["hubApiToken"].as_str().unwrap_or("")).to_owned();
    if url.is_empty() {
        if let Some(config) = settings::hub_api(&state.settings) {
            (url, token) = config;
        }
    } else if token.is_empty() {
        token = settings::read(&state.settings)["hubApiToken"]
            .as_str()
            .map(trame_core::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| std::env::var("TRACKER_HUB_API_TOKEN").unwrap_or_default());
    }
    if url.is_empty() || token.is_empty() {
        return json_response(
            200,
            json!({"ok":false,"error":"no hub URL + token configured"}),
        );
    }
    json_response(
        200,
        state
            .sync
            .test_hub(url.strip_suffix('/').unwrap_or(&url), &token)
            .await,
    )
}
