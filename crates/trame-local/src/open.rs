use crate::{
    db::Db,
    routes::{Native, json_response},
};
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};

/// The app query string for a page or card id.
pub fn query(kind: &str, id: &str) -> String {
    if kind == "page" {
        format!("page={id}")
    } else {
        format!("view=card&card={id}")
    }
}

/// The kind (`page` or `card`) and id of a `trame://page/<id>` or `trame://card/<id>` link.
pub fn scheme_target(url: &str) -> Option<(&'static str, String)> {
    let rest = url.strip_prefix("trame://")?;
    let (kind, id) = rest.split_once('/')?;
    let id = id.split(['?', '#', '/']).next()?;
    if !crate::routes::valid_uuid(id) {
        return None;
    }
    match kind {
        "page" => Some(("page", id.to_owned())),
        "card" | "session" => Some(("card", id.to_owned())),
        _ => None,
    }
}

/// Hands a `trame://` link to the instance already serving `port_file`; true once its window took it.
pub async fn forward(port_file: &Path, url: &str) -> bool {
    let Some((kind, id)) = scheme_target(url) else {
        return false;
    };
    let Some(port) = std::fs::read_to_string(port_file)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v["port"].as_u64())
    else {
        return false;
    };
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    else {
        return false;
    };
    let Ok(response) = client
        .post(format!("http://127.0.0.1:{port}/api/open"))
        .json(&json!({format!("{kind}_id"): id}))
        .send()
        .await
    else {
        return false;
    };
    response
        .json::<Value>()
        .await
        .is_ok_and(|v| v["opened"] == true)
}

/// Resolves a POST /api/open body (`page_id`, `card_id`, or an untyped `id`) to the app query.
pub fn resolve(db: &mut Db, body: &Value) -> anyhow::Result<(u16, Value)> {
    let (id, kinds): (_, &[&str]) = if let Some(id) = body["page_id"].as_str() {
        (id, &["page"])
    } else if let Some(id) = body["card_id"].as_str() {
        (id, &["card"])
    } else if let Some(id) = body["id"].as_str() {
        (id, &["page", "card"])
    } else {
        return Ok((400, json!({"error":"page_id or card_id required"})));
    };
    if !crate::routes::valid_uuid(id) {
        return Ok((400, json!({"error":"invalid id"})));
    }
    for kind in kinds {
        let table = if *kind == "page" { "pages" } else { "sessions" };
        let found = db.query(
            &format!("select 1 from {table} where id=$1 and not deleted"),
            &[json!(id)],
        )?;
        if !found.is_empty() {
            return Ok((200, json!({"kind":kind,"id":id,"query":query(kind, id)})));
        }
    }
    Ok((404, json!({"error":"no page or card with that id"})))
}

/// POST /api/open for a view: resolves the id, then hands it to the window (`opened` is false when headless).
pub async fn serve(state: Native, body: Value) -> Response {
    let resolved = crate::blocking::spawn(move || {
        let mut db = Db::connect(
            &state.root.join("socket"),
            &state.origin,
            Some(state.settings.clone()),
        )?;
        resolve(&mut db, &body).map(|result| (result, state))
    })
    .await;
    let Ok(Ok(((status, mut value), state))) = resolved else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response();
    };
    if status == 200 {
        let query = value["query"].as_str().unwrap_or_default().to_owned();
        value["url"] = json!(format!("http://127.0.0.1:{}/?{query}", state.port));
        value["opened"] = json!(state.open.as_ref().is_some_and(|tx| tx.send(query).is_ok()));
    }
    json_response(status, value)
}
