use crate::db::Db;
use anyhow::Result;
use serde_json::{Value, json};

mod board;
mod presence;
mod stories;
mod write;

pub use board::{add_event, ensure_link, get_session, list_due, search, timeline};
pub use presence::{list_agent_presence, list_presence, touch_agent_presence, touch_presence};
pub use stories::similar as similar_stories;
pub use stories::{find_similar_stories, resolve_story};
pub use write::upsert;
pub use write::{client_for, default_tags, default_tags_for, split_tag_label, tag_color, tag_key};
pub(crate) use write::{ensure_specs_page, ensure_tag};

pub fn days_until(due: &str, today: &str) -> Result<i64> {
    let due = chrono::NaiveDate::parse_from_str(due, "%Y-%m-%d")?;
    let today = chrono::NaiveDate::parse_from_str(today, "%Y-%m-%d")?;
    Ok((due - today).num_days())
}

pub fn shown_due(due: &str, today: &str) -> Result<bool> {
    Ok(days_until(due, today)? <= 7)
}

pub fn story_similarity(a: &str, b: &str) -> f64 {
    stories::similarity(a, b)
}

fn first(db: &mut Db, sql: &str, params: &[Value]) -> Result<Value> {
    Ok(db
        .query(sql, params)?
        .into_iter()
        .next()
        .unwrap_or(Value::Null))
}

fn origin(db: &Db) -> Value {
    json!(db.origin)
}

fn query_param(query: &str, name: &str) -> Option<String> {
    reqwest::Url::parse(&format!("http://localhost/?{query}"))
        .ok()?
        .query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

fn ok() -> Value {
    json!({"ok":true})
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "values fit by construction (timestamps, ids, pids, JS-number parity); JS-number (f64) semantics must be preserved"
)]
fn event_limit(query: &str) -> Result<i64> {
    let number = query_param(query, "events")
        .as_deref()
        .and_then(crate::routes::number)
        .filter(|n| *n != 0.0)
        .unwrap_or(20.0);
    if !number.is_finite()
        || number.fract() != 0.0
        || number < i64::MIN as f64
        || number >= i64::MAX as f64
    {
        anyhow::bail!("invalid event limit");
    }
    Ok(number as i64)
}

pub fn owns(method: &str, path: &str) -> bool {
    let parts: Vec<_> = path.split('/').collect();
    match parts.as_slice() {
        [
            "",
            "api",
            "board" | "search" | "due" | "timeline" | "agent-presence" | "presence" | "tags",
        ] => true,
        ["", "api", "stories"] => method == "POST",
        ["", "api", "sessions" | "statuses"] => method == "POST",
        ["", "api", "stories", "similar"] => true,
        ["", "api", "stories", id] => !id.is_empty() && method == "POST",
        ["", "api", "sessions", id] => !id.is_empty() && method == "GET",
        [
            "",
            "api",
            "sessions",
            id,
            "specs-page" | "presence" | "status" | "delete" | "restore",
        ] => !id.is_empty() && method == "POST",
        ["", "api", "sessions", id, "links" | "events"] => !id.is_empty(),
        ["", "api", "links", id, "delete"] => !id.is_empty() && method == "POST",
        ["", "api", "statuses", id] | ["", "api", "statuses", id, "delete" | "move"] => {
            !id.is_empty() && method == "POST"
        }
        ["", "api", "tags", id] | ["", "api", "tags", id, "delete"] => {
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
) -> Option<Result<(u16, Value)>> {
    if !owns(method, path) {
        return None;
    }
    Some(route(db, method, path, query, body))
}

fn route(db: &mut Db, method: &str, path: &str, query: &str, body: &Value) -> Result<(u16, Value)> {
    let parts: Vec<_> = path.split('/').collect();
    let response = match parts.as_slice() {
        ["", "api", "board"] => (200, board::board(db, query_param(query, "deleted").as_deref() == Some("1"))?),
        ["", "api", "search"] => (200, search(db, &query_param(query, "q").unwrap_or_default())?),
        ["", "api", "due"] => (200, list_due(db)?),
        ["", "api", "timeline"] => {
            let days = query_param(query, "days").and_then(|d| d.parse::<i64>().ok()).unwrap_or(42).clamp(1, 366);
            (200, board::timeline(db, days)?)
        }
        ["", "api", "agent-presence"] => (200, list_agent_presence(db)?),
        ["", "api", "presence"] if method == "POST" => { touch_presence(db, body)?; (200, ok()) },
        ["", "api", "presence"] => (200, list_presence(&query_param(query, "page").unwrap_or_default())),
        ["", "api", "sessions"] => write::create_route(db, body)?,
        ["", "api", "sessions", id] => {
            let limit = event_limit(query)?;
            let card = get_session(db, id, limit)?;
            if card.is_null() { (404, json!({"error":"not found"})) } else { (200, card) }
        }
        ["", "api", "sessions", id, "specs-page"] => (200, json!({"page_id":write::ensure_specs_page(db, id)?})),
        ["", "api", "sessions", id, "presence"] => presence::presence_route(db, id, body)?,
        ["", "api", "sessions", id, "events"] if method == "POST" => {
            board::add_event_value(db, id, &body["summary"], if body["kind"] == "presence" { "presence" } else { "log" }, body)?;
            (200, ok())
        }
        ["", "api", "sessions", id, "events"] => (200, board::list_events(db, id, None)?),
        ["", "api", "sessions", id, "links"] if method == "POST" => (200, json!({"id":board::add_link(db,id,&body["page_id"],&body["block_id"],body["anchor"].as_str().unwrap_or(""))?})),
        ["", "api", "sessions", id, "links"] => (200, board::links(db, id)?),
        ["", "api", "links", id, "delete"] => {
            db.query("update session_links set deleted=true, updated_at=clock_timestamp(), origin=$2 where id=$1", &[json!(id),origin(db)])?;
            (200, ok())
        }
        ["", "api", "sessions", id, "delete" | "restore"] => {
            db.query("update sessions set deleted=$2, origin=$3, updated_at=clock_timestamp() where id=$1", &[json!(id),json!(parts[4]=="delete"),origin(db)])?;
            (200, ok())
        }
        ["", "api", "sessions", id, "status"] => {
            set_status(db, id, &body["status"])?;
            let mut out = ok();
            if let Some(note) = board::open_todos_note(db, id)? { out["note"] = json!(note); }
            (200, out)
        }
        ["", "api", "stories", "similar"] => (200, find_similar_stories(db, query)?),
        ["", "api", "stories"] => (200, json!({"id":stories::create_story(db,body)?})),
        ["", "api", "stories", id] => {
            db.query("update pages set title=coalesce($2,title),brief=coalesce($3,brief),status=coalesce($4,status),origin=$5,updated_at=clock_timestamp() where id=$1", &[json!(id),body["title"].clone(),body["brief"].clone(),body["status"].clone(),origin(db)])?;
            (200, ok())
        }
        ["", "api", "statuses"] => (200, json!({"id":write::create_status(db,body)?})),
        ["", "api", "statuses", id] => write::status_route(db,id,None,body)?,
        ["", "api", "statuses", id, action] => write::status_route(db,id,Some(action),body)?,
        ["", "api", "tags"] if method == "POST" => {
            if body["label"].as_str().is_none_or(|s| s.trim().is_empty()) { (400,json!({"error":"label required"})) }
            else { (200, write::ensure_tag(db, body["label"].as_str().unwrap().trim(), body.get("color"))?) }
        }
        ["", "api", "tags"] => (200, json!(db.query("select id,key,label,color,sort_key from tags where not deleted order by sort_key,label", &[])?)),
        ["", "api", "tags", id] | ["", "api", "tags", id, "delete"] => {
            let result = if parts.len()==5 { db.query("update tags set deleted=true,origin=$2,updated_at=clock_timestamp() where id=$1", &[json!(id),origin(db)]) }
            else { db.query("update tags set label=coalesce($2,label),color=coalesce($3,color),origin=$4,updated_at=clock_timestamp() where id=$1", &[json!(id),body["label"].clone(),body["color"].clone(),origin(db)]) };
            match result { Ok(_) => (200, ok()), Err(error) => (400, json!({"error":error.to_string()})) }
        }
        _ => return Ok((404,json!({"error":"not found"}))),
    };
    Ok(response)
}

/// Move a card to a board status.
pub fn set_status(db: &mut Db, id: &str, status: &Value) -> Result<()> {
    db.query(
        "update sessions set status=$2, origin=$3, updated_at=clock_timestamp() where id=$1",
        &[json!(id), status.clone(), origin(db)],
    )?;
    Ok(())
}

pub fn list_reports(db: &mut Db) -> Result<Value> {
    Ok(json!(db.query("select id,title,client_id,page_id,created_at from reports where not deleted order by created_at desc", &[])?))
}

pub fn get_report(db: &mut Db, id: &str) -> Result<Value> {
    first(
        db,
        "select * from reports where id=$1 and not deleted",
        &[json!(id)],
    )
}

pub fn create_report(db: &mut Db, body: &Value) -> Result<Value> {
    let client = if let Some(name) = body["client"].as_str().filter(|s| !s.is_empty()) {
        crate::pages::resolve_client(db, name)?
    } else {
        Value::Null
    };
    let story = if let Some(title) = body["story"].as_str().filter(|s| !s.is_empty()) {
        resolve_story(db, title, &client, &[], None)?
    } else {
        Value::Null
    };
    Ok(first(db,"insert into reports(title,html,client_id,page_id,origin) values($1,$2,$3,$4,$5) returning id",&[body["title"].clone(),body["html"].clone(),client,story,origin(db)])?["id"].clone())
}

pub fn delete_report(db: &mut Db, id: &str) -> Result<()> {
    db.query(
        "update reports set deleted=true,origin=$2,updated_at=clock_timestamp() where id=$1",
        &[json!(id), origin(db)],
    )?;
    Ok(())
}
