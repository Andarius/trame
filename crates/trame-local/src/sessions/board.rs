use super::{first, origin};
use crate::db::Db;
use anyhow::Result;
use serde_json::{Value, json};

pub(super) fn board(db: &mut Db, deleted: bool) -> Result<Value> {
    let projects = db.query("select id,title as name,color,icon from pages where kind='project' and not deleted order by title", &[])?;
    let stories = db.query("select *,null::text as mark_role from pages where kind='story' and not deleted order by title", &[])?;
    let sessions = db.query(
        "select * from sessions where deleted=$1 order by last_touched desc",
        &[json!(deleted)],
    )?;
    let pages = db.query("select id,parent_id,kind,title,icon,client_id,color,tags,null::text as mark_role from pages where not deleted order by title", &[])?;
    let statuses = db.query("select id,key,label,color,terminal,sort_key from statuses where not deleted order by sort_key", &[])?;
    Ok(
        json!({"projects":projects,"stories":stories,"sessions":sessions,"pages":pages,"statuses":statuses}),
    )
}

pub fn search(db: &mut Db, q: &str) -> Result<Value> {
    let mut pat = String::from("%");
    for c in q.chars() {
        if matches!(c, '\\' | '%' | '_') {
            pat.push('\\');
        }
        pat.push(c);
    }
    pat.push('%');
    // an id or its first characters (6+ hex) also matches cards, pages, databases and agent sessions
    let id = q.trim().to_ascii_lowercase();
    let id_pat = (id.len() >= 6 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'))
        .then(|| format!("{id}%"));
    Ok(json!(db.query("select * from (
       select 'session' as kind,id::text as id,title,coalesce(summary,'') as sub,
              '' as icon,status as meta,'' as color,last_touched as at,null::text as mark_role
         from sessions where not deleted and (title ilike $1 or summary ilike $1 or coalesce(next_step,'') ilike $1
           or id::text like $2 or claude_id::text like $2)
       union all
       select case when kind='project' then 'client' else 'page' end,id::text,title,
              coalesce(brief,''),coalesce(icon,''),kind,coalesce(color,''),updated_at,null::text
         from pages where not deleted and (title ilike $1 or brief ilike $1 or content::text ilike $1 or id::text like $2)
       union all
       select 'database',id::text,name,'',coalesce(icon,''),'database','',updated_at,null::text
         from udb_databases where not deleted and (name ilike $1 or id::text like $2)
     ) hits order by at desc limit 20", &[json!(pat), json!(id_pat)])?))
}

pub(super) fn list_events(db: &mut Db, id: &str, limit: Option<i64>) -> Result<Value> {
    let sql = "select id,at,summary,kind,agent,model,tokens,cost_usd,agent_name from session_events where session_id=$1 and not deleted order by at desc,id desc";
    let rows = if let Some(limit) = limit {
        db.query(&format!("{sql} limit $2"), &[json!(id), json!(limit)])?
    } else {
        db.query(sql, &[json!(id)])?
    };
    Ok(json!(rows))
}

/// Worklog entries of the last `days` days, newest first, and each touched card's first and last entry ever.
pub fn timeline(db: &mut Db, days: i64) -> Result<Value> {
    let since = "now() - make_interval(days => $1::int)";
    let entries = db.query(&format!(
        "select e.id,e.session_id,e.at,e.summary,e.agent,e.agent_name from session_events e join sessions s on s.id=e.session_id
          where not e.deleted and not s.deleted and e.kind in ('track','log') and e.at >= {since} order by e.at desc,e.id desc"
    ), &[json!(days)])?;
    let spans = db.query(&format!(
        "select session_id,min(at) first,max(at) last,count(*)::int n from session_events
          where not deleted and kind in ('track','log') group by session_id having max(at) >= {since}"
    ), &[json!(days)])?;
    Ok(json!({"entries":entries,"spans":spans}))
}

pub fn add_event(db: &mut Db, id: &str, summary: &str, kind: &str, body: &Value) -> Result<()> {
    add_event_value(db, id, &json!(summary), kind, body)
}

pub(super) fn add_event_value(
    db: &mut Db,
    id: &str,
    summary: &Value,
    kind: &str,
    body: &Value,
) -> Result<()> {
    let agent = body["agent"].as_str().filter(|v| {
        !v.is_empty()
            && v.len() <= 32
            && v.bytes().enumerate().all(|(i, c)| {
                c.is_ascii_lowercase()
                    || c.is_ascii_digit()
                    || i > 0 && matches!(c, b'.' | b'_' | b'-')
            })
    });
    let trimmed = |key: &str, max: usize| {
        body[key]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(max).collect::<String>())
    };
    let number = |key: &str| {
        body[key]
            .as_f64()
            .filter(|v| v.is_finite() && *v >= 0.0)
            .map(f64::round)
    };
    let model = trimmed("model", 80);
    let name = trimmed("agent_name", 60);
    let tokens = number("tokens");
    let cost = body["cost_usd"]
        .as_f64()
        .filter(|v| v.is_finite() && *v >= 0.0);
    let from = origin(db);
    db.query("insert into session_events(session_id,summary,kind,origin,agent,model,tokens,cost_usd,agent_name) values($1,$2,$3,$4,$5,$6,$7,$8,$9)", &[json!(id),if summary.is_null() { json!("") } else { summary.clone() },json!(kind),from.clone(),json!(agent),json!(model),json!(tokens),json!(cost),json!(name)])?;
    db.query("update sessions set last_touched=clock_timestamp(),origin=$2,updated_at=clock_timestamp() where id=$1", &[json!(id),from])?;
    Ok(())
}

pub(super) fn add_track_event(db: &mut Db, id: &str, summary: &str, body: &Value) -> Result<()> {
    let agent = body["agent"].as_str();
    let last = first(
        db,
        "select summary,agent from session_events where session_id=$1 and kind='track' and not deleted order by at desc,id desc limit 1",
        &[json!(id)],
    )?;
    if !last.is_null()
        && last["summary"].as_str().unwrap_or("").trim() == summary.trim()
        && last["agent"].as_str() == agent
    {
        return Ok(());
    }
    add_event(db, id, summary, "track", body)
}

pub(super) fn links(db: &mut Db, id: &str) -> Result<Value> {
    Ok(json!(db.query("select l.id,l.page_id,l.block_id,l.anchor,p.title as page_title from session_links l join pages p on p.id=l.page_id and not p.deleted where l.session_id=$1 and not l.deleted order by l.updated_at", &[json!(id)])?))
}

pub(super) fn add_link(
    db: &mut Db,
    id: &str,
    page: &Value,
    block: &Value,
    anchor: &str,
) -> Result<Value> {
    let from = origin(db);
    Ok(first(db,"insert into session_links(session_id,page_id,block_id,anchor,origin) values($1,$2,$3,$4,$5) returning id",&[json!(id),page.clone(),block.clone(),json!(anchor),from])?["id"].clone())
}

pub fn ensure_link(db: &mut Db, id: &str, page: &str, block: &str, anchor: &str) -> Result<()> {
    let linked = first(
        db,
        "select 1 from session_links where session_id=$1 and page_id=$2 and block_id=$3 and not deleted",
        &[json!(id), json!(page), json!(block)],
    )?;
    if linked.is_null() {
        add_link(db, id, &json!(page), &json!(block), anchor)?;
    }
    Ok(())
}

pub fn get_session(db: &mut Db, id: &str, limit: i64) -> Result<Value> {
    let s = first(
        db,
        "select * from sessions where (id=$1 or claude_id=$1) and not deleted order by (id=$1) desc,last_touched desc limit 1",
        &[json!(id)],
    )?;
    if s.is_null() {
        return Ok(Value::Null);
    }
    let id = s["id"].as_str().unwrap_or(id);
    let project = if let Some(pid) = s["client_id"].as_str() {
        let p = first(
            db,
            "select id,title,kind from pages where id=$1 and kind='project' and not deleted",
            &[json!(pid)],
        )?;
        if p.is_null() {
            Value::Null
        } else {
            json!({"id":p["id"],"name":p["title"]})
        }
    } else {
        Value::Null
    };
    let story = if let Some(pid) = s["page_id"].as_str() {
        first(
            db,
            "select id,title,kind from pages where id=$1 and not deleted",
            &[json!(pid)],
        )?
    } else {
        Value::Null
    };
    let spec = if let Some(pid) = s["specs_page_id"].as_str() {
        let p = first(
            db,
            "select content from pages where id=$1 and not deleted",
            &[json!(pid)],
        )?;
        if p.is_null() {
            Value::Null
        } else {
            json!(
                trame_core::page_markdown::page_blocks_to_markdown(
                    p["content"].as_array().map(Vec::as_slice).unwrap_or(&[])
                )
                .map_err(anyhow::Error::msg)?
            )
        }
    } else {
        Value::Null
    };
    let activity = list_events(db, id, Some(limit))?;
    let count = first(
        db,
        "select count(*)::int as n from session_events where session_id=$1 and not deleted",
        &[json!(id)],
    )?;
    Ok(
        json!({"id":s["id"],"title":s["title"],"status":s["status"],"agent":s["agent"],"repo_path":s["repo_path"],"branch":s["branch"],"pr_url":s["pr_url"],"next_step":s["next_step"],"specs_page_id":s["specs_page_id"],"tags":s["tags"],"specs":spec,"project":project,"story":story,"links":links(db,id)?,"activity":activity,"activity_total":count["n"],"last_touched":s["last_touched"],"updated_at":s["updated_at"]}),
    )
}

pub(super) fn open_todos_note(db: &mut Db, id: &str) -> Result<Option<String>> {
    let open = db.query("select b->>'text' as text from sessions s join pages p on p.id=s.specs_page_id,jsonb_array_elements(case when jsonb_typeof(p.content)='array' then p.content else '[]' end) b where s.id=$1 and s.status in (select key from statuses where terminal and not deleted) and b->>'type'='todo' and coalesce((b->>'done')::boolean,false)=false",&[json!(id)])?;
    if open.is_empty() {
        return Ok(None);
    }
    Ok(Some(format!(
        "card closed with {} open todo(s) on its specs page: {} — tick the done ones, or move the rest to a follow-up card",
        open.len(),
        open.iter()
            .map(|r| format!(
                "'{}'",
                trame_core::todo_marks::strip_marks(r["text"].as_str().unwrap_or("")).trim()
            ))
            .collect::<Vec<_>>()
            .join(", ")
    )))
}

pub fn list_due(db: &mut Db) -> Result<Value> {
    let rows = db.query("select p.id as page_id,p.title as page_title,b->>'id' as block_id,b->>'text' as text,substring(b->>'text' from '\\{\\{trame:due=([0-9]{4}-[0-9]{2}-[0-9]{2})\\}\\}') as due,(select s.id from sessions s where s.specs_page_id=p.id and not s.deleted limit 1) as card_id from pages p,jsonb_array_elements(case when jsonb_typeof(p.content)='array' then p.content else '[]' end) b where not p.deleted and b->>'type'='todo' and coalesce((b->>'done')::boolean,false)=false and b->>'text' like '%{{trame:due=%'",&[])?;
    let mut due: Vec<Value> = rows
        .into_iter()
        .filter(|r| !r["due"].is_null())
        .map(|mut r| {
            r["text"] =
                json!(trame_core::todo_marks::strip_marks(r["text"].as_str().unwrap_or("")).trim());
            r
        })
        .collect();
    due.sort_by(|a, b| a["due"].as_str().cmp(&b["due"].as_str()));
    Ok(json!(due))
}
