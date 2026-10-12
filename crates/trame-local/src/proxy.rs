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
    pub upstream: u16,
    pub token: String,
    pub client: reqwest::Client,
    pub native: Option<crate::routes::Native>,
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
            if site != "same-origin" && site != "none" && site != "" {
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

fn strip_hop_headers(headers: &mut HeaderMap) {
    let named: Vec<String> = headers
        .get_all("connection")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|v| v.trim().to_owned())
        .collect();
    for name in named {
        headers.remove(name);
    }
    for name in [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ] {
        headers.remove(name);
    }
}

async fn forward(State(state): State<Proxy>, req: Request<Body>) -> Response {
    if !allowed(req.headers(), req.uri().path(), state.port) {
        return (StatusCode::FORBIDDEN, "local request required").into_response();
    }
    if let Some(native) = &state.native {
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
    }
    if state.native.is_some() {
        return crate::routes::json_response(404, serde_json::json!({"error":"not found"}));
    }
    let (parts, body) = req.into_parts();
    let mut headers = parts.headers;
    strip_hop_headers(&mut headers);
    for name in [
        "host",
        "x-trame-sidecar-token",
        "forwarded",
        "x-forwarded-host",
        "x-forwarded-proto",
        "x-forwarded-for",
    ] {
        headers.remove(name);
    }
    let url = format!(
        "http://127.0.0.1:{}{}",
        state.upstream,
        parts
            .uri
            .path_and_query()
            .map(|v| v.as_str())
            .unwrap_or("/")
    );
    let result = state
        .client
        .request(parts.method, url)
        .headers(headers)
        .header("x-trame-sidecar-token", &state.token)
        .body(reqwest::Body::wrap_stream(body.into_data_stream()))
        .send()
        .await;
    let Ok(upstream) = result else {
        return (StatusCode::BAD_GATEWAY, "backend unavailable").into_response();
    };
    let status = upstream.status();
    let mut headers = upstream.headers().clone();
    strip_hop_headers(&mut headers);
    headers.remove("x-trame-sidecar-token");
    let mut response = Response::new(Body::from_stream(upstream.bytes_stream()));
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    response
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

    #[tokio::test]
    async fn forwards_status_binary_query_and_method_without_following_redirects() {
        use axum::{http::HeaderValue, routing::any};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/api/echo",
                    any(|req: Request<Body>| async move {
                        assert_eq!(req.headers()["x-trame-sidecar-token"], "private");
                        assert!(!req.headers().contains_key("x-secret-hop"));
                        assert_eq!(req.uri().query(), Some("a=%2F&b=1"));
                        assert_eq!(req.method(), "PATCH");
                        let bytes = axum::body::to_bytes(req.into_body(), 1024).await.unwrap();
                        (
                            StatusCode::TEMPORARY_REDIRECT,
                            [("location", "https://example.invalid/")],
                            bytes,
                        )
                    }),
                ),
            )
            .await
            .unwrap();
        });
        let app = router(Proxy {
            port: 8790,
            upstream: port,
            token: "private".into(),
            native: None,
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
        });
        let mut req = Request::builder()
            .method("PATCH")
            .uri("/api/echo?a=%2F&b=1")
            .header("host", "127.0.0.1:8790")
            .header("x-trame-sidecar-token", "attacker")
            .header("connection", "x-secret-hop")
            .body(Body::from(vec![0, 255, 7]))
            .unwrap();
        req.headers_mut()
            .insert("x-secret-hop", HeaderValue::from_static("remove"));
        let response = tower::ServiceExt::oneshot(app, req).await.unwrap();
        assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
        assert_eq!(response.headers()["location"], "https://example.invalid/");
        assert_eq!(
            &axum::body::to_bytes(response.into_body(), 1024)
                .await
                .unwrap()[..],
            &[0, 255, 7]
        );
        server.abort();
    }
}
