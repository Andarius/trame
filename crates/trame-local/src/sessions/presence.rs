use super::{board, first, origin};
use crate::db::Db;
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::{
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

#[allow(
    clippy::cast_possible_truncation,
    reason = "values fit by construction (timestamps, ids, pids, JS-number parity)"
)]
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn entries() -> &'static Mutex<Vec<Value>> {
    static ENTRIES: OnceLock<Mutex<Vec<Value>>> = OnceLock::new();
    ENTRIES.get_or_init(|| Mutex::new(Vec::new()))
}
fn agents() -> &'static Mutex<Vec<Value>> {
    static AGENTS: OnceLock<Mutex<Vec<Value>>> = OnceLock::new();
    AGENTS.get_or_init(|| Mutex::new(Vec::new()))
}

pub fn touch_presence(db: &mut Db, body: &Value) -> Result<()> {
    let mut values = Vec::new();
    if let Some(watcher) = body["watcher"].as_str().filter(|s| valid_agent(s)) {
        let identity = crate::comments::agent_identity(watcher)?;
        let pages: Vec<&str> = body["pages"]
            .as_array()
            .map(|v| {
                v.iter()
                    .filter_map(Value::as_str)
                    .filter(|s| crate::routes::valid_uuid(s))
                    .collect()
            })
            .unwrap_or_default();
        for page in if pages.is_empty() { vec!["*"] } else { pages } {
            let id = if page == "*" {
                format!("watcher:{watcher}")
            } else {
                format!("watcher:{watcher}:{page}")
            };
            values.push(json!({"id":id,"kind":"watcher","name":identity["name"],"avatar":identity["avatar"],"page_id":page,"at":now()}));
        }
    } else {
        let me = db.identity()?;
        let page = trame_core::js_string(&body["page_id"]);
        let page = if body["page_id"].is_null() {
            String::new()
        } else {
            page
        };
        let id = format!(
            "{}:{page}",
            me["userId"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or(format!("dev:{}", db.origin))
        );
        values.push(json!({"id":id,"kind":"viewer","name":me["name"],"avatar":me["avatar"],"page_id":page,"at":now()}));
    }
    let mut registry = entries().lock().unwrap();
    for value in values {
        if let Some(old) = registry.iter_mut().find(|old| old["id"] == value["id"]) {
            *old = value;
        } else {
            registry.push(value);
        }
    }
    Ok(())
}

pub fn list_presence(page: &str) -> Value {
    let mut registry = entries().lock().unwrap();
    let current = now();
    registry.retain(|v| current - v["at"].as_i64().unwrap_or(0) <= 20_000);
    json!(
        registry
            .iter()
            .filter(|v| v["page_id"] == page || v["kind"] == "watcher" && v["page_id"] == "*")
            .map(|v| {
                let mut item = v.clone();
                item.as_object_mut().unwrap().remove("at");
                item
            })
            .collect::<Vec<_>>()
    )
}

fn valid_agent(id: &str) -> bool {
    id.len() <= 32
        && !id.is_empty()
        && id.bytes().enumerate().all(|(i, b)| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || i > 0 && matches!(b, b'.' | b'_' | b'-')
        })
}
fn cleaned(body: &Value, key: &str, max: usize) -> Value {
    body[key]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| json!(s.chars().take(max).collect::<String>()))
        .unwrap_or(Value::Null)
}
fn number(body: &Value, key: &str) -> Value {
    body[key]
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0)
        .map(|n| json!(n.round()))
        .unwrap_or(Value::Null)
}

pub fn touch_agent_presence(id: &str, body: &Value, at: i64) -> Result<Value> {
    let state = body["state"].as_str().unwrap_or("");
    if !matches!(state, "working" | "waiting" | "idle") {
        bail!("state must be working, waiting or idle");
    }
    let harness = cleaned(body, "harness", 40);
    if harness.is_null() {
        bail!("harness is required");
    }
    let mut registry = agents().lock().unwrap();
    let prev = registry
        .iter()
        .find(|p| p["session_id"] == id)
        .cloned()
        .unwrap_or(Value::Null);
    let question = if state == "waiting" {
        cleaned(body, "question", 300)
    } else {
        Value::Null
    };
    let page = cleaned(body, "page_id", 64);
    let page = if page.is_null() {
        prev["page_id"].clone()
    } else {
        page
    };
    let block = cleaned(body, "block_id", 64);
    let block = if block.is_null() {
        prev["block_id"].clone()
    } else {
        block
    };
    let since = if prev["state"] == state {
        prev["since"].as_i64().unwrap_or(at)
    } else {
        at
    };
    let p = json!({"session_id":id,"state":state,"harness":harness,"name":cleaned(body,"name",60),"icon":cleaned(body,"icon",2048),"provider":cleaned(body,"provider",40),"model":cleaned(body,"model",80),"tokens":number(body,"tokens"),"context_max":number(body,"context_max"),"step":cleaned(body,"step",200),"question":question,"page_id":page,"block_id":block,"since":since,"at":at});
    if let Some(old) = registry.iter_mut().find(|old| old["session_id"] == id) {
        *old = p.clone();
    } else {
        registry.push(p.clone());
    }
    Ok(p)
}

fn live_agents(at: i64) -> Vec<Value> {
    let mut registry = agents().lock().unwrap();
    registry.retain(|v| at - v["at"].as_i64().unwrap_or(0) <= 4 * 60 * 60_000);
    registry.clone()
}

pub fn list_agent_presence(db: &mut Db) -> Result<Value> {
    let list = live_agents(now());
    if list.is_empty() {
        return Ok(json!([]));
    }
    let ids = list
        .iter()
        .map(|v| v["session_id"].clone())
        .collect::<Vec<_>>();
    let rows=db.query("select s.id,s.title,l.page_id,l.block_id,l.anchor,p.title as page_title from sessions s left join session_links l on l.session_id=s.id and not l.deleted left join pages p on p.id=l.page_id and not p.deleted where s.id=any($1::uuid[]) and not s.deleted",&[json!(ids)])?;
    Ok(json!(list.into_iter().filter_map(|mut p|{
        let related=rows.iter().filter(|r|r["id"]==p["session_id"]).collect::<Vec<_>>();
        let first=related.first()?;
        p["session_title"]=first["title"].clone();
        p["links"]=json!(related.into_iter().filter(|r|!r["page_id"].is_null() && !r["page_title"].is_null()).map(|r|json!({"page_id":r["page_id"],"block_id":r["block_id"],"anchor":r["anchor"].as_str().unwrap_or(""),"page_title":r["page_title"]})).collect::<Vec<_>>());
        Some(p)
    }).collect::<Vec<_>>()))
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "values fit by construction (timestamps, ids, pids, JS-number parity); JS-number (f64) semantics must be preserved"
)]
fn journal(db: &mut Db, id: &str, p: &Value, ended: bool) -> Result<()> {
    let last = first(
        db,
        "select summary,at from session_events where session_id=$1 and kind='presence' and agent_name is not distinct from $2 and not deleted order by at desc,id desc limit 1",
        &[json!(id), p["name"].clone()],
    )?;
    let open = last["summary"]
        .as_str()
        .is_some_and(|s| s.starts_with("joined"));
    let usage = json!({"agent":if p["harness"]=="claude-code"{json!("claude")}else{p["harness"].clone()},"agent_name":p["name"],"model":p["model"],"tokens":p["tokens"]});
    if !ended && p["state"] != "idle" && !open {
        board::add_event(db, id, "joined", "presence", &usage)?;
        let card = first(
            db,
            "select s.status,coalesce(t.terminal,false) as terminal from sessions s left join statuses t on t.key=s.status and not t.deleted where s.id=$1 and not s.deleted",
            &[json!(id)],
        )?;
        if !card.is_null() && card["terminal"] == false && card["status"] != "active" {
            let from = origin(db);
            db.query("update sessions set status='active',origin=$2,updated_at=clock_timestamp() where id=$1",&[json!(id),from])?;
        }
    } else if ended && open {
        let then = chrono::DateTime::parse_from_rfc3339(last["at"].as_str().unwrap_or(""))
            .map(|d| d.timestamp_millis())
            .unwrap_or(now());
        let mins = ((now() - then) as f64 / 60_000.0).round().max(1.0) as i64;
        let tok = p["tokens"]
            .as_f64()
            .map(|n| {
                if n >= 1000.0 {
                    format!(" · {:.1}k tok", n / 1000.0)
                } else {
                    format!(" · {} tok", n as i64)
                }
            })
            .unwrap_or_default();
        board::add_event(
            db,
            id,
            &format!("left · {mins} min{tok}"),
            "presence",
            &usage,
        )?;
    }
    Ok(())
}

pub(super) fn presence_route(db: &mut Db, id: &str, body: &Value) -> Result<(u16, Value)> {
    let id = id.to_lowercase();
    if !crate::routes::valid_uuid(&id) {
        return Ok((400, json!({"error":"invalid session id"})));
    }
    let card = first(
        db,
        "select id from sessions where (id=$1 or claude_id=$1) and not deleted order by (id=$1) desc,last_touched desc limit 1",
        &[json!(id)],
    )?;
    if card.is_null() {
        return Ok((404, json!({"error":"no card for that session"})));
    }
    let id = card["id"].as_str().unwrap();
    if !body.is_object() {
        return Ok((400, json!({"error":"JSON object expected"})));
    }
    if body.get("page_id").is_some() || body.get("block_id").is_some() {
        let Some(page) = body["page_id"]
            .as_str()
            .filter(|s| crate::routes::valid_uuid(s))
        else {
            return Ok((
                400,
                json!({"error":"page_id (uuid) and block_id go together"}),
            ));
        };
        let Some(block) = body["block_id"].as_str().filter(|s| {
            !s.is_empty()
                && s.len() <= 64
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
        }) else {
            return Ok((
                400,
                json!({"error":"page_id (uuid) and block_id go together"}),
            ));
        };
        let row = first(
            db,
            "select content from pages where id=$1 and not deleted",
            &[json!(page)],
        )?;
        if !row["content"]
            .as_array()
            .is_some_and(|blocks| blocks.iter().any(|b| b["id"] == block))
        {
            return Ok((400, json!({"error":"no such block on that page"})));
        }
    }
    let p = match touch_agent_presence(id, body, now()) {
        Ok(p) => p,
        Err(e) => return Ok((400, json!({"error":e.to_string()}))),
    };
    journal(db, id, &p, body["ended"] == true)?;
    if let Some(block) = body["block_id"].as_str() {
        let page = body["page_id"].as_str().unwrap_or("");
        board::ensure_link(db, id, page, block, body["anchor"].as_str().unwrap_or(""))?;
    }
    Ok((200, p))
}
