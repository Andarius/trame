use crate::{comments, db::Db};
use axum::{
    body::Body,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::path::PathBuf;

#[derive(Clone)]
pub struct Native {
    pub root: PathBuf,
    pub web_dir: PathBuf,
    pub origin: String,
    pub settings: PathBuf,
    pub sync: crate::sync::Sync,
    pub port: u16,
    pub desktop: bool,
    pub demo: crate::demo::Demo,
    /// Asks the desktop window to show an app query (absent outside the desktop app).
    pub open: Option<tokio::sync::mpsc::UnboundedSender<String>>,
}

pub fn owns(method: &str, path: &str) -> bool {
    if crate::runtime::owns(method, path) {
        return true;
    }
    if crate::local::owns(method, path)
        || crate::udb::owns(method, path)
        || crate::sessions::owns(method, path)
        || crate::imports::owns(method, path)
        || owns_comments(method, path)
    {
        return true;
    }
    let p: Vec<_> = path.split('/').collect();
    match p.as_slice() {
        ["", "api", "pages"] => true,
        ["", "api", "pages", id] => !id.is_empty() && *id != "import",
        ["", "api", "pages", id, "delete" | "move"] => !id.is_empty(),
        ["", "api", "pages", id, "story" | "session"] => !id.is_empty() && method == "POST",
        ["", "api", "pages", id, "events"] => !id.is_empty() && method == "GET",
        ["", "api", "repos", "suggest"] => method == "GET",
        ["", "api", "repos"] | ["", "api", "repos", _] | ["", "api", "repos", _, "delete"] => {
            method == "POST"
        }
        _ => false,
    }
}

fn hub_owns(method: &str, path: &str) -> bool {
    let Some(path) = path.strip_prefix("/api/") else {
        return false;
    };
    let parts: Vec<_> = path.split('/').collect();
    match (method, parts.as_slice()) {
        ("GET", ["board" | "search" | "due" | "agent-presence"] | ["stories", "similar"])
        | ("GET" | "POST", ["presence" | "tags" | "pages" | "comments" | "udb"])
        | ("POST", ["sessions" | "stories" | "statuses"]) => true,
        ("GET", ["sessions", id])
        | ("GET" | "POST", ["sessions", id, "links" | "events"])
        | (
            "POST",
            [
                "sessions",
                id,
                "specs-page" | "presence" | "status" | "delete" | "restore",
            ]
            | ["stories" | "statuses" | "tags", id]
            | ["statuses", id, "delete" | "move"]
            | ["tags" | "links", id, "delete"],
        ) => valid_uuid(id),
        // The shared page handler answers 405 for unsupported methods on these paths.
        (_, ["pages", id] | ["pages", id, "delete" | "move"])
        | ("GET", ["pages", id, "events"])
        | ("POST", ["pages", id, "story" | "session"]) => valid_uuid(id),
        ("GET", ["comments", "inbox"] | ["udb", "icons"]) => true,
        ("POST", ["comments", id] | ["comments", id, "delete" | "agent-status"]) => valid_uuid(id),
        ("POST", ["udb", "links"]) => true,
        ("GET" | "POST", ["udb", id])
        | (
            "POST",
            ["udb", id, "props" | "rows" | "delete"]
            | ["udb", "props" | "rows", id]
            | ["udb", "props" | "rows", id, "delete"],
        ) => valid_uuid(id),
        _ => false,
    }
}

pub fn hub_parses_json(method: &str, path: &str) -> bool {
    hub_owns(method, path) && parses_json(method, path)
}

pub fn parse_hub_body(method: &str, path: &str, bytes: &[u8]) -> Result<Value, (u16, Value)> {
    if !hub_parses_json(method, path) {
        return Ok(Value::Null);
    }
    let error = match serde_json::from_slice(bytes) {
        Ok(body) => return Ok(body),
        Err(error) => error,
    };
    let parts: Vec<_> = path.split('/').collect();
    let status = match parts.as_slice() {
        ["", "api", "sessions", _, "presence"] => return Ok(Value::Null),
        ["", "api", "pages", ..]
        | ["", "api", "statuses" | "tags", _]
        | ["", "api", "statuses", _, "move"]
        | ["", "api", "udb", "props", _]
        | ["", "api", "udb", _, "props"] => 400,
        _ => 500,
    };
    Err((status, json!({"error": error.to_string()})))
}

/// Dispatch only the shared routes explicitly exposed by the hub.
pub fn hub_handle(
    db: &mut Db,
    method: &str,
    path: &str,
    query: &str,
    body: &Value,
) -> anyhow::Result<(u16, Value)> {
    if !hub_owns(method, path) {
        return Ok(not_found());
    }
    anyhow::ensure!(db.is_hub(), "hub dispatcher requires a hub database");
    handle(db, method, path, query, body)
}

fn not_found() -> (u16, Value) {
    (404, json!({"error":"not found"}))
}

pub fn handle(
    db: &mut Db,
    method: &str,
    path: &str,
    query: &str,
    body: &Value,
) -> anyhow::Result<(u16, Value)> {
    db.exclusive(|db| handle_inner(db, method, path, query, body))
}

fn handle_inner(
    db: &mut Db,
    method: &str,
    path: &str,
    query: &str,
    body: &Value,
) -> anyhow::Result<(u16, Value)> {
    if !db.is_hub()
        && let Some(result) = crate::local::handle(db, method, path, query, body)
    {
        return result;
    }
    if let Some(result) = crate::udb::handle(db, method, path, query, body) {
        return result;
    }
    if let Some(result) = crate::sessions::handle(db, method, path, query, body) {
        return result;
    }
    if !db.is_hub()
        && let Some(result) = crate::imports::handle(db, method, path, query, body)
            .or_else(|| crate::repos::handle(db, method, path, query, body))
    {
        return result;
    }
    if let Some(result) = crate::pages::handle(db, method, path, body) {
        return result;
    }
    if owns_comments(method, path) {
        return handle_comments(db, method, path, query, body);
    }
    Ok(not_found())
}

fn owns_comments(method: &str, path: &str) -> bool {
    let parts: Vec<_> = path.split('/').collect();
    match parts.as_slice() {
        ["", "api", "comments"] | ["", "api", "comments", "inbox"] => true,
        ["", "api", "comments", id] | ["", "api", "comments", id, "delete" | "agent-status"] => {
            !id.is_empty() && method == "POST"
        }
        _ => false,
    }
}

fn handle_comments(
    db: &mut Db,
    method: &str,
    path: &str,
    query: &str,
    body: &Value,
) -> anyhow::Result<(u16, Value)> {
    if method == "POST"
        && body.is_null()
        && path != "/api/comments/inbox"
        && !path.ends_with("/delete")
    {
        anyhow::bail!("null comment body");
    }
    let url = reqwest::Url::parse(&format!("http://localhost/?{query}"))?;
    let get = |key: &str| {
        url.query_pairs()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.into_owned())
    };
    if path == "/api/comments/inbox" {
        let raw = get("stale").unwrap_or_else(|| "600".into());
        let stale = number(&raw).unwrap_or(600.0);
        let pages = get("page")
            .unwrap_or_default()
            .split(',')
            .map(trame_core::trim)
            .filter(|v| valid_uuid(v))
            .map(str::to_owned)
            .collect::<Vec<_>>();
        return Ok((
            200,
            comments::inbox(
                db,
                if stale.is_finite() { stale } else { 600.0 },
                &pages,
                get("mode").as_deref() == Some("all"),
            )?,
        ));
    }
    if path == "/api/comments" {
        return Ok((
            200,
            if method == "POST" {
                json!({"id":comments::create(db,body)?})
            } else if let Some(page) = get("page").filter(|s| !s.is_empty()) {
                comments::list(db, &page)?
            } else {
                json!([])
            },
        ));
    }
    let parts: Vec<_> = path.split('/').collect();
    let id = parts[3];
    match parts.get(4).copied() {
        Some("agent-status") => {
            if !["seen", "answering", "failed", "answered", "clear"]
                .contains(&body["status"].as_str().unwrap_or(""))
            {
                return Ok((400, json!({"error":"invalid status"})));
            }
            comments::set_status(db, id, body)?;
        }
        Some("delete") => comments::delete(db, id)?,
        _ => comments::update(db, id, body)?,
    }
    Ok((200, json!({"ok":true})))
}

pub fn valid_uuid(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

pub async fn serve(state: Native, req: Request<Body>) -> Response {
    if crate::runtime::owns(req.method().as_str(), req.uri().path()) {
        return crate::runtime::serve(state, req).await;
    }
    let (parts, body) = req.into_parts();
    let path = parts.uri.path().to_owned();
    let query = parts.uri.query().unwrap_or("").to_owned();
    let method = parts.method.to_string();
    let Ok(bytes) = axum::body::to_bytes(body, usize::MAX).await else {
        return (StatusCode::BAD_REQUEST, "body unavailable").into_response();
    };
    let body = if parses_json(&method, &path) {
        match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(_) if path == "/api/open-path" => json!({}),
            Err(_) if path.starts_with("/api/sessions/") && path.ends_with("/presence") => {
                Value::Null
            }
            Err(e) => {
                return if path.starts_with("/api/pages") || path.starts_with("/api/tags/") {
                    json_response(400, json!({"error":json_error(&bytes,&e)}))
                } else {
                    (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response()
                };
            }
        }
    } else {
        Value::Null
    };
    let result = crate::blocking::spawn(move || {
        let mut db = Db::connect(
            &state.root.join("socket"),
            &state.origin,
            Some(state.settings),
        )?;
        handle(&mut db, &method, &path, &query, &body)
    })
    .await;
    match result {
        Ok(Ok((status, value))) => json_response(status, value),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response(),
    }
}

fn parses_json(method: &str, path: &str) -> bool {
    if method != "POST" {
        return false;
    }
    let p = path.split('/').collect::<Vec<_>>();
    match p.as_slice() {
        [
            "",
            "api",
            "pages" | "comments" | "sessions" | "stories" | "statuses" | "tags" | "presence"
            | "settings" | "reports" | "shares" | "page-links" | "open-path" | "udb" | "repos",
        ] => true,
        ["", "api", "pages" | "repos", _] | ["", "api", "pages", _, "move"] => true,
        ["", "api", "comments", "inbox"] => false,
        ["", "api", "comments", _] | ["", "api", "comments", _, "agent-status"] => true,
        [
            "",
            "api",
            "sessions",
            _,
            "events" | "links" | "presence" | "status",
        ] => true,
        ["", "api", "stories", "similar"] => false,
        ["", "api", "stories" | "statuses" | "tags", _] | ["", "api", "statuses", _, "move"] => {
            true
        }
        ["", "api", "report-files", "delete"] => true,
        ["", "api", "import", "claude"] | ["", "api", "import", "claude", "ignore" | "star"] => {
            true
        }
        ["", "api", "udb", "icons"] => false,
        ["", "api", "udb", _]
        | ["", "api", "udb", _, "props" | "rows"]
        | ["", "api", "udb", "props" | "rows", _] => true,
        _ => false,
    }
}
#[allow(
    clippy::needless_pass_by_value,
    reason = "callers pass json! temporaries"
)]
pub(crate) fn json_response(status: u16, value: Value) -> Response {
    (
        StatusCode::from_u16(status).unwrap(),
        [("content-type", "application/json")],
        crate::json::stringify(&value),
    )
        .into_response()
}

// shortcut: V8 diagnostics cover the replay corpus; extend when another malformed-input contract is needed.
fn json_error(bytes: &[u8], error: &serde_json::Error) -> String {
    let input = String::from_utf8_lossy(bytes);
    let message = error.to_string();
    let offset = input
        .split_inclusive('\n')
        .take(error.line().saturating_sub(1))
        .map(str::len)
        .sum::<usize>()
        + error.column().saturating_sub(1);
    let offset = if message.starts_with("control character") && error.column() == 0 {
        offset.saturating_sub(1)
    } else {
        offset
    }
    .min(input.len());
    let prefix = String::from_utf8_lossy(&bytes[..offset]);
    let position = prefix.encode_utf16().count();
    let line = prefix.bytes().filter(|b| *b == b'\n').count() + 1;
    let column = prefix
        .rsplit('\n')
        .next()
        .unwrap_or("")
        .encode_utf16()
        .count()
        + 1;
    let located = |reason: &str| {
        format!("{reason} in JSON at position {position} (line {line} column {column})")
    };
    if message.starts_with("trailing comma")
        && input.get(offset..).is_some_and(|s| s.starts_with('}'))
    {
        return located("Expected double-quoted property name");
    }
    if message.starts_with("key must be a string") {
        return located(if input[..offset].trim_end().ends_with(',') {
            "Expected double-quoted property name"
        } else {
            "Expected property name or '}'"
        });
    }
    if message.starts_with("expected `:`") {
        return located("Expected ':' after property name");
    }
    if message.starts_with("expected `,` or `}`") {
        return located("Expected ',' or '}' after property value");
    }
    if message.starts_with("expected `,` or `]`") {
        return located("Expected ',' or ']' after array element");
    }
    if message.starts_with("trailing characters") {
        return format!(
            "Unexpected non-whitespace character after JSON at position {position} (line {line} column {column})"
        );
    }
    if message.starts_with("control character") {
        return located("Bad control character in string literal");
    }
    if error.is_eof() {
        if input.trim_end().ends_with('{') || input.trim_end().ends_with(',') {
            let pos = input.encode_utf16().count();
            let col = input
                .rsplit('\n')
                .next()
                .unwrap_or("")
                .encode_utf16()
                .count()
                + 1;
            let reason = if input.trim_end().ends_with('{') {
                "Expected property name or '}'"
            } else {
                "Expected double-quoted property name"
            };
            return format!("{reason} in JSON at position {pos} (line {line} column {col})");
        }
        return "Unexpected end of JSON input".into();
    }
    if input == "undefined" {
        return "\"undefined\" is not valid JSON".into();
    }
    let token = input
        .get(offset..)
        .and_then(|s| s.chars().next())
        .unwrap_or(' ');
    format!("Unexpected token '{token}', \"{input}\" is not valid JSON")
}

#[allow(
    clippy::cast_precision_loss,
    reason = "JS-number (f64) semantics must be preserved"
)]
pub(crate) fn number(value: &str) -> Option<f64> {
    let value = trame_core::trim(value);
    if value.is_empty() {
        return Some(0.0);
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = value.strip_prefix(prefix) {
            return u64::from_str_radix(digits, radix).ok().map(|n| n as f64);
        }
    }
    value.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hub_allowlist_routes_to_shared_handlers() {
        let id = "aaf9a808-4376-4bd3-b90b-645bb0fd634d";
        for (method, path) in [
            ("GET", "/api/board".into()),
            ("GET", "/api/stories/similar".into()),
            ("POST", "/api/sessions".into()),
            ("GET", format!("/api/sessions/{id}")),
            ("POST", format!("/api/sessions/{id}/presence")),
            ("GET", format!("/api/sessions/{id}/links")),
            ("POST", format!("/api/links/{id}/delete")),
            ("POST", format!("/api/stories/{id}")),
            ("POST", format!("/api/statuses/{id}/move")),
            ("POST", format!("/api/tags/{id}/delete")),
            ("GET", "/api/comments/inbox".into()),
            ("POST", format!("/api/comments/{id}/agent-status")),
            ("POST", "/api/pages".into()),
            ("GET", format!("/api/pages/{id}/events")),
            ("PATCH", format!("/api/pages/{id}")),
            ("POST", format!("/api/pages/{id}/story")),
            ("POST", format!("/api/pages/{id}/session")),
            ("GET", "/api/udb/icons".into()),
            ("POST", "/api/udb/links".into()),
            ("POST", format!("/api/udb/{id}/props")),
            ("POST", format!("/api/udb/rows/{id}/delete")),
        ] {
            assert!(hub_owns(method, &path), "{method} {path}");
            assert!(owns(method, &path), "{method} {path}");
        }
    }

    #[test]
    fn hub_allowlist_rejects_local_unknown_and_ambiguous_paths() {
        let id = "aaf9a808-4376-4bd3-b90b-645bb0fd634d";
        for (method, path) in [
            ("GET", "/api/settings".into()),
            ("POST", "/api/settings".into()),
            ("GET", "/api/status".into()),
            ("GET", "/api/fs/complete".into()),
            ("GET", "/api/folder".into()),
            ("POST", "/api/open-path".into()),
            ("POST", "/api/import/claude".into()),
            ("POST", "/api/pages/import".into()),
            ("GET", "/api/repos/suggest".into()),
            ("POST", format!("/api/repos/{id}")),
            ("GET", "/api/reports".into()),
            ("POST", "/api/report-files/delete".into()),
            ("GET", "/api/timeline".into()),
            ("POST", "/api/update/restart".into()),
            ("POST", "/api/sync".into()),
            ("POST", "/sync".into()),
            ("GET", "/usage".into()),
            ("GET", "/l/test".into()),
            ("POST", "/api/comment-links".into()),
            ("POST", "/api/page-links".into()),
            ("POST", "/api/comments/inbox".into()),
            ("GET", "/api/pages/".into()),
            ("POST", format!("/api/pages/{id}/story/extra")),
            ("POST", "/api/udb/icons".into()),
            ("POST", "/api/udb/props/rows".into()),
            ("GET", "/api/udb/links".into()),
            ("DELETE", "/api/board".into()),
            ("POST", "/api/stories/similar".into()),
            ("GET", format!("/api/sessions/{id}/unknown")),
            ("GET", format!("/api/sessions/{id}/events/")),
            ("GET", "/api//board".into()),
        ] {
            assert!(!hub_owns(method, &path), "{method} {path}");
        }
    }

    #[test]
    fn hub_reads_json_only_for_supported_body_consumers() {
        let id = "aaf9a808-4376-4bd3-b90b-645bb0fd634d";
        for (method, path, expected) in [
            ("POST", "/api/pages".into(), true),
            ("POST", "/api/pages/import".into(), false),
            ("POST", format!("/api/pages/{id}/move"), true),
            ("POST", format!("/api/pages/{id}/session"), false),
            ("POST", format!("/api/sessions/{id}/specs-page"), false),
            ("POST", format!("/api/statuses/{id}/move"), true),
            ("POST", format!("/api/comments/{id}/delete"), false),
            ("POST", "/api/open-path".into(), false),
            ("PATCH", format!("/api/pages/{id}"), false),
        ] {
            assert_eq!(hub_parses_json(method, &path), expected, "{method} {path}");
        }
    }

    #[test]
    fn malformed_hub_json_preserves_route_status() {
        let id = "aaf9a808-4376-4bd3-b90b-645bb0fd634d";
        for (path, status) in [
            ("/api/pages".to_owned(), Some(400)),
            (format!("/api/statuses/{id}/move"), Some(400)),
            (format!("/api/udb/{id}/props"), Some(400)),
            ("/api/sessions".into(), Some(500)),
            (format!("/api/sessions/{id}/presence"), None),
        ] {
            let result = parse_hub_body("POST", &path, b"{");
            assert_eq!(result.err().map(|(status, _)| status), status, "{path}");
        }
    }

    #[test]
    fn import_routes_get_their_json_body() {
        for path in [
            "/api/import/claude",
            "/api/import/claude/ignore",
            "/api/import/claude/star",
        ] {
            assert!(parses_json("POST", path), "{path}");
        }
    }
    #[test]
    fn malformed_page_json_preserves_ts_errors() {
        for (input, wanted) in [
            ("", "Unexpected end of JSON input"),
            (
                "{",
                "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
            ),
            ("nope", "Unexpected token 'o', \"nope\" is not valid JSON"),
            (
                "{bad}",
                "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
            ),
            (
                "{\"a\":}",
                "Unexpected token '}', \"{\"a\":}\" is not valid JSON",
            ),
            ("[1,]", "Unexpected token ']', \"[1,]\" is not valid JSON"),
            (
                "{\"a\":1,}",
                "Expected double-quoted property name in JSON at position 7 (line 1 column 8)",
            ),
            (
                "{\"a\" 1}",
                "Expected ':' after property name in JSON at position 5 (line 1 column 6)",
            ),
            ("undefined", "\"undefined\" is not valid JSON"),
            (
                "null x",
                "Unexpected non-whitespace character after JSON at position 5 (line 1 column 6)",
            ),
            (
                "\"bad\ntext\"",
                "Bad control character in string literal in JSON at position 4 (line 1 column 5)",
            ),
        ] {
            let err = serde_json::from_str::<Value>(input).unwrap_err();
            assert_eq!(json_error(input.as_bytes(), &err), wanted, "{input}");
        }
    }
}
