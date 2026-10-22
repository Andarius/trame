use axum::{
    Router,
    body::Body,
    extract::State,
    http::{HeaderMap, Request, StatusCode},
    response::{IntoResponse, Response},
};

#[derive(Clone)]
pub struct Proxy {
    pub port: u16,
    pub native: crate::routes::Native,
}

fn loopback_origin(value: &str) -> bool {
    let Some(rest) = value
        .strip_prefix("http://")
        .or_else(|| value.strip_prefix("https://"))
    else {
        return false;
    };
    ["localhost", "127.0.0.1", "[::1]"].iter().any(|host| {
        rest == *host
            || rest
                .strip_prefix(host)
                .and_then(|v| v.strip_prefix(':'))
                .is_some_and(|port| !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()))
    })
}

fn allowed(headers: &HeaderMap, path: &str, port: u16) -> bool {
    let host = headers.get("host").and_then(|h| h.to_str().ok());
    if ![
        format!("127.0.0.1:{port}"),
        format!("localhost:{port}"),
        format!("[::1]:{port}"),
    ]
    .iter()
    .any(|h| Some(h.as_str()) == host)
    {
        return false;
    }
    if path == "/api" || path.starts_with("/api/") || path == "/report-file" {
        if let Some(site) = headers.get("sec-fetch-site") {
            if site != "same-origin" && site != "none" && !site.is_empty() {
                return false;
            }
        }
        if let Some(origin) = headers.get("origin") {
            if !origin.is_empty() && !origin.to_str().is_ok_and(loopback_origin) {
                return false;
            }
        }
    }
    true
}

async fn forward(State(state): State<Proxy>, req: Request<Body>) -> Response {
    if !allowed(req.headers(), req.uri().path(), state.port) {
        return (StatusCode::FORBIDDEN, "local request required").into_response();
    }
    let native = &state.native;
    if crate::demo::owns(req.uri().path()) {
        return crate::demo::serve(native, &req);
    }
    if crate::pty::owns(req.uri().path()) {
        return crate::pty::serve(&native.root, req).await;
    }
    if crate::platform::owns(req.method().as_str(), req.uri().path()) {
        let response = crate::platform::serve(native.clone(), req).await;
        if response.status().is_success() {
            native.sync.dirty.notify_one();
        }
        return response;
    }
    if crate::plugins::owns(req.method().as_str(), req.uri().path()) {
        let mutating = req.method() != axum::http::Method::GET;
        let response = crate::plugins::serve(native.clone(), req).await;
        if mutating && response.status().is_success() {
            native.sync.dirty.notify_one();
        }
        return response;
    }
    if crate::assets::owns(req.method().as_str(), req.uri().path()) {
        let mutating = req.method() != axum::http::Method::GET;
        let response = crate::assets::serve(native.clone(), req).await;
        if mutating && response.status().is_success() {
            native.sync.dirty.notify_one();
        }
        return response;
    }
    if crate::stats::owns(req.method().as_str(), req.uri().path()) {
        return crate::stats::serve(native.clone()).await;
    }
    if crate::web::owns(req.uri().path()) {
        return crate::web::serve(native.clone(), req).await;
    }
    if crate::routes::owns(req.method().as_str(), req.uri().path()) {
        let path = req.uri().path();
        let mutating = req.method() != axum::http::Method::GET
            && path.starts_with("/api/")
            && !path.starts_with("/api/sync")
            && !path.starts_with("/api/presence");
        let response = crate::routes::serve(native.clone(), req).await;
        if mutating && response.status().is_success() {
            native.sync.dirty.notify_one();
        }
        return response;
    }
    crate::routes::json_response(404, serde_json::json!({"error":"not found"}))
}

pub fn router(state: Proxy) -> Router {
    Router::new().fallback(forward).with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn guard_matches_existing_csrf_and_rejects_rebound_hosts() {
        for (origin, site, expected) in [
            (None, None, true),
            (Some("http://127.0.0.1:8790"), Some("same-origin"), true),
            (Some("http://localhost:5173"), None, true),
            (Some("https://[::1]"), Some("none"), true),
            (Some("https://evil.example"), None, false),
            (None, Some("cross-site"), false),
            (None, Some("same-site"), false),
            (Some("null"), None, false),
            (Some("http://localhost.evil"), None, false),
            (Some("http://localhost/"), None, false),
        ] {
            let mut h = HeaderMap::new();
            h.insert("host", "127.0.0.1:8790".parse().unwrap());
            if let Some(o) = origin {
                h.insert("origin", o.parse().unwrap());
            }
            if let Some(s) = site {
                h.insert("sec-fetch-site", s.parse().unwrap());
            }
            assert_eq!(
                allowed(&h, "/api/pages", 8790),
                expected,
                "{origin:?} {site:?}"
            );
            assert_eq!(allowed(&h, "/report-file", 8790), expected);
            h.insert("host", "evil.example:8790".parse().unwrap());
            assert!(!allowed(&h, "/api/pages", 8790));
        }
    }
}
