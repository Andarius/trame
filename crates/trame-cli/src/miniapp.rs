use crate::{
    connectors, digest,
    due::{self, Options, Window},
    target::resolve_target,
};
use anyhow::{Context, Result, bail};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Request},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::{net::TcpListener, time::timeout};

const PAGE: &str = include_str!("miniapp/index.html");
const DEFAULT_ADDR: &str = "0.0.0.0:8790";
const MAX_AGE_SECS: i64 = 24 * 3600;
const MAX_FUTURE_SECS: i64 = 5 * 60;
const MAX_INIT_DATA_BYTES: usize = 4096;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const DUE_WITHIN_DAYS: i64 = 7;
const MAX_SCHEDULES: usize = 10;
const MAX_SETTINGS_BYTES: usize = 16 * 1024;
const USAGE: &str = "usage: tramecli miniapp serve [--addr HOST:PORT]";

type HmacSha256 = Hmac<Sha256>;

/// Why an initData string was refused; never shown to the client.
#[derive(Debug, PartialEq, Eq)]
pub enum Rejected {
    Malformed,
    BadHash,
    AuthDate,
    User,
}

struct Config {
    token: String,
    chat_id: String,
}

fn hmac(key: &[u8]) -> Result<HmacSha256, Rejected> {
    HmacSha256::new_from_slice(key).map_err(|_| Rejected::Malformed)
}

/// Checks Telegram's signature over `init_data`, its freshness at `now` (unix seconds) and that the user is `chat_id`.
pub fn validate_init_data(
    init_data: &str,
    token: &str,
    chat_id: &str,
    now: i64,
) -> Result<(), Rejected> {
    let mut fields = reqwest::Url::parse(&format!("http://x/?{init_data}"))
        .map_err(|_| Rejected::Malformed)?
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect::<Vec<_>>();
    let hash = fields
        .iter()
        .find(|(k, _)| k == "hash")
        .and_then(|(_, v)| hex::decode(v).ok())
        .ok_or(Rejected::Malformed)?;
    fields.retain(|(k, _)| k != "hash");
    fields.sort();
    let check = fields
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("\n");
    // the key is the constant "WebAppData", the message the bot token
    let mut secret = hmac(b"WebAppData")?;
    secret.update(token.as_bytes());
    let mut mac = hmac(&secret.finalize().into_bytes())?;
    mac.update(check.as_bytes());
    mac.verify_slice(&hash).map_err(|_| Rejected::BadHash)?;
    let field = |name: &str| fields.iter().find(|(k, _)| k == name).map(|(_, v)| v);
    let auth_date = field("auth_date")
        .and_then(|v| v.parse::<i64>().ok())
        .ok_or(Rejected::AuthDate)?;
    if now - auth_date > MAX_AGE_SECS || auth_date - now > MAX_FUTURE_SECS {
        return Err(Rejected::AuthDate);
    }
    let user = field("user")
        .and_then(|v| serde_json::from_str::<Value>(v).ok())
        .and_then(|v| v["id"].as_i64())
        .ok_or(Rejected::User)?;
    if user.to_string() == chat_id {
        Ok(())
    } else {
        Err(Rejected::User)
    }
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({"error": "unauthorized"})),
    )
        .into_response()
}

fn pick(row: &Value) -> Value {
    json!({
        "project": row["project"],
        "card_title": row["card_title"],
        "status": row["status"],
        "page_title": row["page_title"],
        "text": row["text"],
        "days": row["days"],
        "due": row["due"],
    })
}

/// None for the signed Telegram user, else the response to send instead (401, or 503
/// without credentials).
fn refuse(headers: &HeaderMap) -> Option<Response> {
    // read per request: a removed or rotated connector takes effect at once, and none means closed
    let Ok(config) = config() else {
        return Some(
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error": "unavailable"})),
            )
                .into_response(),
        );
    };
    let init_data = headers
        .get("x-telegram-init-data")
        .filter(|v| v.len() <= MAX_INIT_DATA_BYTES)
        .and_then(|v| v.to_str().ok());
    match init_data {
        Some(data) if validate_init_data(data, &config.token, &config.chat_id, now()).is_ok() => {
            None
        }
        _ => Some(unauthorized()),
    }
}

fn bad_request(message: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({"error": message}))).into_response()
}

/// Where the schedules run, for the settings screen.
fn runs_on() -> String {
    std::env::var("TRAME_RUNNER_NAME").unwrap_or_else(|_| "this server".into())
}

async fn api_settings(headers: HeaderMap) -> Response {
    if let Some(response) = refuse(&headers) {
        return response;
    }
    let values = connectors::load_values();
    let set_up: Vec<&str> = connectors::REGISTRY
        .iter()
        .filter(|s| (s.build)(&values).is_some())
        .map(|s| s.name)
        .collect();
    match digest::read_settings().and_then(|s| digest::schedules_from(&s)) {
        Ok(schedules) => Json(json!({
            "schedules": schedules,
            "connectors": set_up,
            "runs_on": runs_on(),
            "defaults": digest::Schedule::morning(),
        }))
        .into_response(),
        Err(error) => bad_request(&format!("{error:#}")),
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Save {
    schedules: Vec<digest::Schedule>,
}

async fn api_settings_save(headers: HeaderMap, body: Bytes) -> Response {
    if let Some(response) = refuse(&headers) {
        return response;
    }
    let save: Save = match serde_json::from_slice(&body) {
        Ok(save) => save,
        Err(error) => return bad_request(&format!("invalid schedules: {error}")),
    };
    if save.schedules.len() > MAX_SCHEDULES {
        return bad_request(&format!("at most {MAX_SCHEDULES} schedules"));
    }
    for (i, schedule) in save.schedules.iter().enumerate() {
        if let Err(error) = schedule.validate() {
            return bad_request(&format!("{error:#}"));
        }
        if save.schedules[..i].iter().any(|s| s.name == schedule.name) {
            return bad_request(&format!("two schedules are named {}", schedule.name));
        }
    }
    match digest::write_schedules(&save.schedules) {
        Ok(()) => Json(json!({"schedules": save.schedules})).into_response(),
        Err(error) => {
            eprintln!("miniapp: saving schedules failed: {error:#}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "could not save"})),
            )
                .into_response()
        }
    }
}

async fn api_due(headers: HeaderMap) -> Response {
    if let Some(response) = refuse(&headers) {
        return response;
    }
    let options = Options {
        window: Window::Within(DUE_WITHIN_DAYS),
        query: None,
    };
    let loaded = async {
        let target = resolve_target().await?;
        let rows = due::load(&options, &target).await?;
        anyhow::Ok((rows, crate::digest::project_icons(&target).await))
    }
    .await;
    match loaded {
        Ok((rows, icons)) => {
            // only the icons of projects on screen, and only inline images
            let icons: serde_json::Map<String, Value> = icons
                .into_iter()
                .filter(|(name, icon)| {
                    icon.starts_with("data:image/")
                        && rows.iter().any(|r| r["project"] == name.as_str())
                })
                .map(|(name, icon)| (name, Value::String(icon)))
                .collect();
            Json(json!({"rows": rows.iter().map(pick).collect::<Vec<_>>(), "icons": icons}))
                .into_response()
        }
        Err(error) => {
            eprintln!("miniapp: loading due todos failed: {error}");
            (
                StatusCode::BAD_GATEWAY,
                Json(json!({"error": "unavailable"})),
            )
                .into_response()
        }
    }
}

async fn index() -> impl IntoResponse {
    (
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        Html(PAGE),
    )
}

async fn limit_time(request: Request, next: Next) -> Response {
    timeout(REQUEST_TIMEOUT, next.run(request))
        .await
        .unwrap_or_else(|_| StatusCode::GATEWAY_TIMEOUT.into_response())
}

fn router() -> Router {
    Router::new()
        .route("/tg/", get(index))
        .route("/tg/api/due", post(api_due))
        .route("/tg/api/settings", post(api_settings))
        .route(
            "/tg/api/settings/save",
            post(api_settings_save).layer(DefaultBodyLimit::max(MAX_SETTINGS_BYTES)),
        )
        .fallback(|| async { StatusCode::NOT_FOUND })
        .layer(DefaultBodyLimit::max(1024))
        .layer(middleware::from_fn(limit_time))
}

fn config() -> Result<Config> {
    let values = connectors::load_values();
    let get = |key: &str| values.get(key).filter(|v| !v.is_empty()).cloned();
    match (get("TELEGRAM_BOT_TOKEN"), get("TELEGRAM_CHAT_ID")) {
        (Some(token), Some(chat_id)) => Ok(Config { token, chat_id }),
        _ => bail!(
            "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required (`tramecli connector setup telegram`)"
        ),
    }
}

pub async fn main(args: &[String]) -> Result<()> {
    let [sub, rest @ ..] = args else {
        bail!(USAGE);
    };
    if sub != "serve" {
        bail!("unknown miniapp command: {sub}\n{USAGE}");
    }
    let addr = match rest {
        [] => DEFAULT_ADDR,
        [flag, addr] if flag == "--addr" => addr,
        _ => bail!(USAGE),
    };
    // fail fast at startup; requests re-read the values
    config()?;
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("binding {addr}"))?;
    eprintln!(
        "miniapp: listening on http://{}/tg/",
        listener.local_addr()?
    );
    axum::serve(listener, router()).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "123:TEST-TOKEN";
    const NOW: i64 = 1_800_000_000;

    fn encode(s: &str) -> String {
        s.bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() {
                    char::from(b).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect()
    }

    /// Signs `fields` the way Telegram does and returns the urlencoded initData.
    fn signed(fields: &[(&str, &str)], token: &str) -> String {
        let mut sorted = fields.to_vec();
        sorted.sort_unstable();
        let check = sorted
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("\n");
        let mut secret = hmac(b"WebAppData").unwrap();
        secret.update(token.as_bytes());
        let mut mac = hmac(&secret.finalize().into_bytes()).unwrap();
        mac.update(check.as_bytes());
        let hash = hex::encode(mac.finalize().into_bytes());
        fields
            .iter()
            .map(|(k, v)| format!("{k}={}", encode(v)))
            .chain([format!("hash={hash}")])
            .collect::<Vec<_>>()
            .join("&")
    }

    #[test]
    fn init_data_validation() {
        let user = r#"{"id":42,"first_name":"Ju"}"#;
        let other = r#"{"id":43}"#;
        let auth = |delta: i64| (NOW + delta).to_string();
        let valid = signed(
            &[
                ("auth_date", &auth(-60)),
                ("user", user),
                ("query_id", "AA"),
            ],
            TOKEN,
        );
        let hash = valid.rsplit("hash=").next().unwrap().to_owned();
        let bad_hash = valid.replace(&hash, &"0".repeat(64));
        let tampered = valid.replace("query_id=AA", "query_id=BB");
        let no_hash = valid.rsplit_once("&hash=").unwrap().0.to_owned();
        for (name, data, expected) in [
            ("valid", valid.clone(), Ok(())),
            ("tampered field", tampered, Err(Rejected::BadHash)),
            ("wrong hash", bad_hash, Err(Rejected::BadHash)),
            (
                "signed with another token",
                signed(&[("auth_date", &auth(-60)), ("user", user)], "9:OTHER"),
                Err(Rejected::BadHash),
            ),
            (
                "stale auth_date",
                signed(
                    &[("auth_date", &auth(-MAX_AGE_SECS - 1)), ("user", user)],
                    TOKEN,
                ),
                Err(Rejected::AuthDate),
            ),
            (
                "future auth_date",
                signed(
                    &[("auth_date", &auth(MAX_FUTURE_SECS + 1)), ("user", user)],
                    TOKEN,
                ),
                Err(Rejected::AuthDate),
            ),
            (
                "other user id",
                signed(&[("auth_date", &auth(-60)), ("user", other)], TOKEN),
                Err(Rejected::User),
            ),
            ("missing hash", no_hash, Err(Rejected::Malformed)),
        ] {
            assert_eq!(
                validate_init_data(&data, TOKEN, "42", NOW),
                expected,
                "{name}"
            );
        }
    }
}
