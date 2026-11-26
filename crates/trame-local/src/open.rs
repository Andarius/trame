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

/// The app query string for a page or card id, or a board query.
pub fn query(kind: &str, id: &str) -> String {
    match kind {
        "page" => format!("page={id}"),
        "agent" => format!("view=terminals&term=agent:{id}"),
        "board" => format!("view=board&group=none&q={}", crate::plugins::encode(id)),
        _ => format!("view=card&card={id}"),
    }
}

/// The app query string for a saved board view (`boardViews` in settings), by name ignoring case.
pub fn view_query(settings: &Path, name: &str) -> Option<String> {
    let views =
        crate::settings::normalize_board_views(&crate::settings::read(settings)["boardViews"]);
    let view = views.as_array()?.iter().find(|v| {
        v["name"]
            .as_str()
            .is_some_and(|n| n.eq_ignore_ascii_case(name.trim()))
    })?;
    Some(format!(
        "view=board&group={}&q={}",
        view["group"].as_str().unwrap_or("none"),
        crate::plugins::encode(view["q"].as_str().unwrap_or_default())
    ))
}

/// The app query string a `trame://` target opens (None for an unknown view).
pub fn link_query(kind: &str, target: &str, settings: &Path) -> Option<String> {
    if kind == "view" {
        view_query(settings, target)
    } else {
        Some(query(kind, target))
    }
}

/// The kind and target of a `trame://` link: a `page` or `card` id, a `board` query or a saved `view` name.
pub fn scheme_target(url: &str) -> Option<(&'static str, String)> {
    if let Some(target) = trame_core::board_link::parse(url) {
        return Some(target);
    }
    let rest = url.strip_prefix("trame://")?;
    let (kind, id) = rest.split_once('/')?;
    if kind == "agent" {
        return trame_core::board_link::valid_run_id(id).then(|| ("agent", id.to_owned()));
    }
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
        .json(&body(kind, &id))
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

/// The POST /api/open body for a link target.
fn body(kind: &str, target: &str) -> Value {
    match kind {
        "board" => json!({"q": target}),
        "view" => json!({"view": target}),
        _ => json!({format!("{kind}_id"): target}),
    }
}

/// Resolves a POST /api/open body naming a board query (`q`) or a saved view (`view`); None for an id body.
pub fn resolve_board(settings: &Path, body: &Value) -> Option<(u16, Value)> {
    if let Some(name) = body["view"].as_str() {
        return Some(match view_query(settings, name) {
            Some(query) => (200, json!({"kind":"view","id":name,"query":query})),
            None => (404, json!({"error":format!("no saved view named {name}")})),
        });
    }
    let q = body["q"].as_str()?;
    Some((
        200,
        json!({"kind":"board","id":q,"query":query("board", q)}),
    ))
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
    if let Some(id) = body["agent_id"].as_str() {
        if !trame_core::board_link::valid_run_id(id) {
            return json_response(400, json!({"error":"invalid run id"}));
        }
        if !crate::agent::exists(id) {
            return json_response(404, json!({"error":"this run is not on this machine"}));
        }
        return reply(
            &state,
            (
                200,
                json!({"kind":"agent","id":id,"query":query("agent",id)}),
            ),
        );
    }
    if let Some(resolved) = resolve_board(&state.settings, &body) {
        return reply(&state, resolved);
    }
    let resolved = crate::blocking::spawn(move || {
        let mut db = Db::connect(
            &state.root.join("socket"),
            &state.origin,
            Some(state.settings.clone()),
        )?;
        resolve(&mut db, &body).map(|result| (result, state))
    })
    .await;
    let Ok(Ok((resolved, state))) = resolved else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response();
    };
    reply(&state, resolved)
}

fn reply(state: &Native, (status, mut value): (u16, Value)) -> Response {
    if status == 200 {
        let query = value["query"].as_str().unwrap_or_default().to_owned();
        value["url"] = json!(format!("http://127.0.0.1:{}/?{query}", state.port));
        value["opened"] = json!(state.open.as_ref().is_some_and(|tx| tx.send(query).is_ok()));
    }
    json_response(status, value)
}

/// A passive landing page for Slack clients that accept only web links.
pub(crate) fn agent_landing(id: &str) -> Response {
    if !trame_core::board_link::valid_run_id(id) {
        return (StatusCode::NOT_FOUND, "Unknown run link").into_response();
    }
    axum::response::Html(include_str!("open-agent.html").replace("{{RUN_ID}}", id)).into_response()
}
