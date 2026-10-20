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
    {
        return true;
    }
    let p: Vec<_> = path.split('/').collect();
    match p.as_slice() {
        ["", "api", "pages" | "comments"] | ["", "api", "comments", "inbox"] => true,
        ["", "api", "pages", id] => !id.is_empty() && *id != "import",
        ["", "api", "pages", id, "delete" | "move"] => !id.is_empty(),
        ["", "api", "pages", id, "story" | "session"] => !id.is_empty() && method == "POST",
        ["", "api", "pages", id, "events"] => !id.is_empty() && method == "GET",
        ["", "api", "comments", id] | ["", "api", "comments", id, "delete" | "agent-status"] => {
            !id.is_empty() && method == "POST"
        }
        _ => false,
    }
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
    if let Some(result) = crate::local::handle(db, method, path, query, body) {
        return result;
    }
    if let Some(result) = crate::udb::handle(db, method, path, query, body) {
        return result;
    }
    if let Some(result) = crate::sessions::handle(db, method, path, query, body) {
        return result;
    }
    if let Some(result) = crate::imports::handle(db, method, path, query, body) {
        return result;
    }
    if let Some(result) = crate::pages::handle(db, method, path, body) {
        return result;
    }
    if method == "POST"
        && body.is_null()
        && path != "/api/comments/inbox"
        && path != "/api/udb/icons"
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
            | "settings" | "reports" | "shares" | "page-links" | "open-path" | "udb",
        ] => true,
        ["", "api", "pages", _] | ["", "api", "pages", _, "move"] => true,
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
        ["", "api", "import", "claude"] | ["", "api", "import", "claude", "ignore"] => true,
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
