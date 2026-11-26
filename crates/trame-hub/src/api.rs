use crate::auth;
use anyhow::Result;
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::State,
    http::{HeaderMap, Request, StatusCode},
    routing::{any, get},
};
use postgres::{Client, Config, NoTls};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Semaphore;
use trame_local::{db::Db, routes, udb::formula::Executor};

struct Hub {
    database: Config,
    idle: Mutex<Vec<Client>>,
    slots: Arc<Semaphore>,
    formula: Executor,
}

type Reply = (u16, Value);

pub(crate) fn router(database: Config, client: Client, formula: Executor) -> Router {
    Router::new()
        .route(
            "/health",
            get(async || Json(json!({"ok":true,"protocol":trame_protocol::registry().version}))),
        )
        .route("/api/{*path}", any(api))
        .route("/api", any(api))
        .route("/api/", any(api))
        .with_state(Arc::new(Hub {
            database,
            idle: Mutex::new(vec![client]),
            slots: Arc::new(Semaphore::new(4)),
            formula,
        }))
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("authorization")?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .filter(|s| !s.is_empty())
}

fn error(status: u16, message: &str) -> Reply {
    (status, json!({"error":message}))
}

async fn parse_body(method: &str, path: &str, body: Body) -> Result<Value, Reply> {
    if !routes::hub_parses_json(method, path) {
        return Ok(Value::Null);
    }
    let bytes = tokio::time::timeout(Duration::from_secs(30), to_bytes(body, 128 * 1024 * 1024))
        .await
        .map_err(|_| error(408, "request body timed out"))?
        .map_err(|_| error(413, "request body unavailable or too large"))?;
    routes::parse_hub_body(method, path, &bytes)
}

fn dispatch(db: &mut Db, token: &str, req: Request<Body>) -> Result<Reply> {
    let (request, body) = req.into_parts();
    let Some(caller) = auth::lookup(&mut db.client, token)? else {
        return Ok(error(401, "invalid or missing token"));
    };
    let version = trame_protocol::registry().version;
    let protocol = request
        .headers
        .get("x-trame-protocol")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("none");
    if protocol != version.to_string() {
        return Ok(error(
            400,
            &format!("protocol mismatch: server speaks {version}, client sent {protocol}"),
        ));
    }
    let Some(member) = caller.member else {
        return Ok(error(403, "the hub /api is for members only"));
    };
    let path = request.uri.path();
    let method = request.method.as_str();
    let body = match tokio::runtime::Handle::current().block_on(parse_body(method, path, body)) {
        Ok(body) => body,
        Err(reply) => return Ok(reply),
    };

    db.origin = caller.node;
    db.client.query_one(
        "SELECT set_config('trame.source','api',true), set_config('trame.actor',$1,true)",
        &[&member],
    )?;
    routes::hub_handle(db, method, path, request.uri.query().unwrap_or(""), &body)
}

async fn request(hub: Arc<Hub>, request: Request<Body>) -> Result<Reply> {
    let Some(token) = bearer(request.headers()).map(str::to_owned) else {
        return Ok(error(401, "invalid or missing token"));
    };
    let slot = Arc::clone(&hub.slots).acquire_owned().await?;
    tokio::task::spawn_blocking(move || {
        let _slot = slot;
        let idle = hub.idle.lock().unwrap().pop();
        let client = match idle {
            Some(client) if !client.is_closed() => client,
            _ => hub.database.connect(NoTls)?,
        };
        let mut db = Db::for_hub(client, String::new(), hub.formula.clone());
        let reply = db.transaction_if(
            |db| dispatch(db, &token, request),
            |(status, _)| *status < 400,
        )?;
        hub.idle.lock().unwrap().push(db.client);
        Ok(reply)
    })
    .await?
}

async fn api(State(hub): State<Arc<Hub>>, req: Request<Body>) -> (StatusCode, Json<Value>) {
    let (status, body) = request(hub, req)
        .await
        .unwrap_or_else(|e| error(500, &e.to_string()));
    (StatusCode::from_u16(status).unwrap(), Json(body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_requires_scheme_and_nonempty_token() {
        for (header, expected) in [
            ("", None),
            ("Basic foo", None),
            ("Bearer ", None),
            ("bearer token", None),
            ("Bearer token", Some("token")),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert("authorization", header.parse().unwrap());
            assert_eq!(bearer(&headers), expected);
        }
    }
}
