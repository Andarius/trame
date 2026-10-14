use crate::db::Db;
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::sync::{Mutex, OnceLock};

pub struct MarkRule {
    pub mark: String,
    pub value: regex::Regex,
    pub role: String,
}

pub fn attach_udb(db: &mut Db, id: &str, page_id: &Value) -> Result<()> {
    db.query(
        "update udb_databases set page_id=$2, origin=$3, updated_at=clock_timestamp() where id=$1",
        &[json!(id), page_id.clone(), json!(db.origin)],
    )?;
    if page_id.is_string() {
        crate::comments::rehome_row_threads(db, id, page_id)?;
    }
    Ok(())
}

fn rules() -> &'static Mutex<Vec<MarkRule>> {
    static RULES: OnceLock<Mutex<Vec<MarkRule>>> = OnceLock::new();
    RULES.get_or_init(|| Mutex::new(Vec::new()))
}

pub fn add_mark_roles(add: Vec<MarkRule>) {
    rules().lock().unwrap().extend(add);
}

fn has_role(page: &Value, role: &str) -> bool {
    rules().lock().unwrap().iter().any(|rule| {
        rule.role == role
            && page["content"].as_array().is_some_and(|blocks| {
                blocks
                    .iter()
                    .filter_map(|block| block["text"].as_str())
                    .find_map(|text| {
                        trame_core::todo_marks::read_marks(text)
                            .get(&rule.mark)
                            .filter(|v| v.as_str().is_some_and(|v| !v.is_empty()))
                            .cloned()
                    })
                    .and_then(|v| v.as_str().map(|s| rule.value.is_match(s)))
                    .unwrap_or(false)
            })
    })
}

pub fn is_user_story(page: &Value) -> bool {
    has_role(page, "linked-story") || (page["kind"] == "story" && !has_role(page, "ticket"))
}

fn list_cols() -> String {
    let rules = rules().lock().unwrap();
    let mut sorted: Vec<_> = rules.iter().collect();
    sorted.sort_by_key(|r| r.role != "ticket");
    let role = if sorted.is_empty() {
        "null::text as mark_role".into()
    } else {
        format!(
            "case {} end as mark_role",
            sorted
                .iter()
                .map(|r| {
                    format!(
                        "when content::text like '%trame:{}=%' then '{}'",
                        r.mark.replace('\'', "''"),
                        r.role.replace('\'', "''")
                    )
                })
                .collect::<Vec<_>>()
                .join(" ")
        )
    };
    format!(
        "id, parent_id, kind, title, icon, status, client_id, color, tags, sort_key, owner_id, updated_at, {role}"
    )
}

pub fn mid_key(a: &str, b: &str) -> String {
    const AB: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let digit = |s: &str, i: usize, default: usize| {
        s.as_bytes()
            .get(i)
            .and_then(|c| AB.iter().position(|v| v == c))
            .unwrap_or(default)
    };
    let mut i = 0;
    let mut result = String::new();
    loop {
        let ca = digit(a, i, 0);
        let cb = digit(b, i, AB.len());
        if ca == cb {
            result.push(AB[ca] as char);
            i += 1;
            continue;
        }
        if cb > ca + 1 {
            result.push(AB[usize::midpoint(ca, cb)] as char);
            return result;
        }
        result.push(AB[ca] as char);
        i += 1;
        loop {
            let c = digit(a, i, 0);
            if AB.len() - c > 1 {
                result.push(AB[usize::midpoint(c, AB.len())] as char);
                return result;
            }
            result.push(AB[c] as char);
            i += 1;
        }
    }
}

pub fn story_above(db: &mut Db, id: &Value) -> Result<Value> {
    let rows = db.query(
        "with recursive up as (
       select id, parent_id, kind, content, array[id] as path from pages where id=$1 and not deleted
       union all
       select p.id, p.parent_id, p.kind, p.content, up.path || p.id
         from pages p join up on p.id=up.parent_id
        where not p.deleted and up.kind <> 'project' and not p.id=any(up.path)
     ) select id, kind, content from up order by cardinality(path)",
        std::slice::from_ref(id),
    )?;
    Ok(rows
        .iter()
        .find(|p| has_role(p, "linked-story"))
        .or_else(|| rows.iter().rev().find(|p| is_user_story(p)))
        .or_else(|| rows.iter().rev().find(|p| p["kind"] == "story"))
        .map(|p| p["id"].clone())
        .unwrap_or(Value::Null))
}

pub fn project_above(db: &mut Db, id: &Value) -> Result<Value> {
    let rows = db.query(
        "with recursive up as (
       select id, parent_id, kind, 0 as d, array[id] as path
         from pages where id=$1 and not deleted
       union all
       select p.id, p.parent_id, p.kind, up.d + 1, up.path || p.id
         from pages p join up on p.id = up.parent_id
        where not p.deleted and not p.id = any(up.path)
     ) select id from up where kind='project' order by d limit 1",
        std::slice::from_ref(id),
    )?;
    Ok(rows.first().map(|r| r["id"].clone()).unwrap_or(Value::Null))
}

fn check_story_parent(db: &mut Db, parent: &Value) -> Result<()> {
    if trame_core::truthy(parent) && !story_above(db, parent)?.is_null() {
        bail!(
            "A user story cannot be nested under another user story. Create a ticket/session or a documentation page instead."
        );
    }
    Ok(())
}

fn end_key(db: &mut Db, parent: &Value) -> Result<String> {
    let rows = db.query("select max(sort_key) as k from pages where parent_id is not distinct from $1 and not deleted", std::slice::from_ref(parent))?;
    Ok(mid_key(rows[0]["k"].as_str().unwrap_or(""), ""))
}

pub fn list(db: &mut Db) -> Result<Value> {
    Ok(json!(db.query(
        &format!(
            "select {} from pages where not deleted order by sort_key, title",
            list_cols()
        ),
        &[]
    )?))
}

pub fn get(db: &mut Db, id: &str) -> Result<Value> {
    if !regex::Regex::new(r"(?i)^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$")?.is_match(id) {
        return Ok(Value::Null);
    }
    let Some(mut page) = db
        .query(
            "select * from pages where id=$1 and not deleted",
            &[json!(id)],
        )?
        .into_iter()
        .next()
    else {
        return Ok(Value::Null);
    };
    page["children"] = json!(db.query(
        &format!(
            "select {},
            (select count(*)::int from jsonb_array_elements(
               case when jsonb_typeof(content)='array' then content else '[]'::jsonb end) b
              where b->>'type'='todo') as todos,
            (select count(*)::int from jsonb_array_elements(
               case when jsonb_typeof(content)='array' then content else '[]'::jsonb end) b
              where b->>'type'='todo' and b->>'done'='true') as todos_done
       from pages where parent_id=$1 and not deleted order by sort_key, title",
            list_cols()
        ),
        &[json!(id)]
    )?);
    page["databases"] = json!(db.query("select d.id, d.name, d.icon,
            (select count(*)::int from udb_rows r where r.db_id = d.id and not r.deleted) as row_count
       from udb_databases d where d.page_id=$1 and not d.deleted order by d.sort_key, d.name", &[json!(id)])?);
    page["sessions"] = json!(db.query("select * from sessions where not deleted
        and (page_id=$1 or specs_page_id=$1
             or page_id in (select id from pages where parent_id=$1 and kind='story' and not deleted))
      order by last_touched desc", &[json!(id)])?);
    page["comments"] = crate::comments::list(db, id)?;
    page["links"] = json!(db.query(
        "select l.id, l.session_id, l.block_id, l.anchor,
            s.title as session_title, s.status as session_status
       from session_links l join sessions s on s.id = l.session_id and not s.deleted
      where l.page_id=$1 and not l.deleted order by l.updated_at",
        &[json!(id)]
    )?);
    Ok(page)
}

fn coalesce(p: &Value, key: &str, default: Value) -> Value {
    p.get(key)
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(default)
}

pub fn resolve_home_project(db: &mut Db, repo_path: &str) -> Result<Value> {
    let path = repo_path.trim_end_matches('/');
    if path.is_empty() {
        return Ok(Value::Null);
    }
    if let Some(row) = db
        .query(
            "select client_id from sessions
      where not deleted and client_id is not null and repo_path is not null
        and starts_with($1 || '/', repo_path || '/')
      order by length(repo_path) desc, last_touched desc limit 1",
            &[json!(path)],
        )?
        .first()
    {
        return Ok(row["client_id"].clone());
    }
    if let Some(row) = db.query("select id from pages where kind='project' and not deleted and position('/' || title || '/' in $1) > 0
     order by length(title) desc limit 1", &[json!(format!("{path}/"))])?.first() { return Ok(row["id"].clone()); }
    resolve_client(db, "Side-projects")
}

pub fn resolve_client(db: &mut Db, name: &str) -> Result<Value> {
    if let Some(row) = db
        .query(
            "select id from pages where kind='project' and title=$1 and not deleted limit 1",
            &[json!(name)],
        )?
        .first()
    {
        return Ok(row["id"].clone());
    }
    let h = name
        .chars()
        .fold(0_i32, |h, c| h.wrapping_mul(31).wrapping_add(c as i32));
    let color =
        ["#7a9ee7", "#b590e7", "#c98a63", "#7bd88f", "#e3c567"][h.unsigned_abs() as usize % 5];
    Ok(db.query("insert into pages (kind, title, color, origin, owner_id)
     values ('project',$1,$2,$3,(select user_id from devices where node_id=$3 and not deleted limit 1)) returning id",
        &[json!(name), json!(color), json!(db.origin)])?[0]["id"].clone())
}

pub const PAGE_STATUSES: [&str; 2] = ["open", "archived"];

pub fn is_page_status(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|status| PAGE_STATUSES.contains(&status))
}

fn validate_status(p: &Value) -> Result<()> {
    if p.is_null() {
        bail!("Cannot read properties of null (reading 'status')");
    }
    if let Some(status) = p.get("status").filter(|s| !s.is_null()) {
        if !is_page_status(status) {
            bail!("unknown page status: {}", trame_core::js_string(status));
        }
    }
    Ok(())
}

pub fn create(db: &mut Db, p: &Value) -> Result<Value> {
    validate_status(p)?;
    let parent = if let Some(parent) = p.get("parent_id") {
        parent.clone()
    } else if trame_core::truthy(&p["repo_path"]) {
        resolve_home_project(
            db,
            p["repo_path"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("repoPath.replace is not a function"))?,
        )?
    } else {
        Value::Null
    };
    if p.get("content").is_some_and(|c| !c.is_array()) {
        bail!("page content must be a block array");
    }
    if is_user_story(p) {
        check_story_parent(db, &parent)?;
    }
    let key = end_key(db, &parent)?;
    let owner = db.identity()?["userId"].clone();
    let kind = if p["kind"] == "project" || p["kind"] == "story" {
        p["kind"].clone()
    } else {
        json!("page")
    };
    let rows = db.query("insert into pages
       (kind, title, icon, client_id, parent_id, sort_key, brief, content, tags, status, owner_id, origin)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id", &[
        kind, coalesce(p,"title",json!("")), p["icon"].clone(), p["client_id"].clone(), parent, json!(key),
        coalesce(p,"brief",json!("")), json!(crate::json::stringify(&coalesce(p,"content",json!([])))), json!(crate::json::stringify(&coalesce(p,"tags",json!([])))),
        coalesce(p,"status",json!("open")), owner, json!(db.origin),
    ])?;
    Ok(rows[0]["id"].clone())
}

pub fn update(db: &mut Db, id: &str, p: &Value) -> Result<()> {
    validate_status(p)?;
    if !p.is_object() && !p.is_array() {
        bail!(
            "Cannot use 'in' operator to search for 'icon' in {}",
            trame_core::js_string(p)
        );
    }
    db.query("update pages set
       title=coalesce($2,title), brief=coalesce($3,brief), status=coalesce($4,status), content=coalesce($5,content),
       icon=case when $6 then $7 else icon end, client_id=case when $8 then $9 else client_id end,
       color=case when $11 then $12 else color end, tags=case when $13 then $14 else tags end,
       origin=$10, updated_at=clock_timestamp() where id=$1", &[
        json!(id), p["title"].clone(), p["brief"].clone(), p["status"].clone(),
        if trame_core::truthy(&p["content"]) { json!(crate::json::stringify(&p["content"])) } else { Value::Null },
        json!(p.get("icon").is_some()), p["icon"].clone(), json!(p.get("client_id").is_some()), p["client_id"].clone(),
        json!(db.origin), json!(p.get("color").is_some()), p["color"].clone(), json!(p.get("tags").is_some()), json!(crate::json::stringify(&coalesce(p,"tags",json!([])))),
    ])?;
    Ok(())
}

pub fn move_page(db: &mut Db, id: &str, to: &Value) -> Result<()> {
    let current = db.query(
        "select parent_id from pages where id=$1 and not deleted",
        &[json!(id)],
    )?;
    let Some(current) = current.first() else {
        bail!("page not found");
    };
    if to.is_null() {
        bail!("Cannot read properties of null (reading 'parent_id')");
    }
    let parent = to
        .get("parent_id")
        .cloned()
        .unwrap_or_else(|| current["parent_id"].clone());
    if trame_core::truthy(&parent)
        && !db
            .query(
                "with recursive up as (
         select id, parent_id from pages where id=$1
         union all
         select p.id, p.parent_id from pages p join up on p.id = up.parent_id
       ) select 1 from up where id=$2 limit 1",
                &[parent.clone(), json!(id)],
            )?
            .is_empty()
    {
        bail!("cannot move a page under itself");
    }
    if parent != current["parent_id"] && trame_core::truthy(&parent) {
        let subtree = db.query(
            "with recursive subtree as (
       select id, kind, content from pages where id=$1 and not deleted
       union
       select p.id, p.kind, p.content from pages p join subtree s on p.parent_id=s.id
        where not p.deleted and p.kind <> 'project'
     ) select kind, content from subtree",
            &[json!(id)],
        )?;
        if subtree.iter().any(is_user_story) {
            check_story_parent(db, &parent)?;
        }
    }
    let anchor = coalesce(to, "before_id", to["after_id"].clone());
    let key = if trame_core::truthy(&anchor) {
        let rows = db.query("select id, sort_key from pages where parent_id is not distinct from $1 and not deleted and id <> $2 order by sort_key, title", &[parent.clone(), json!(id)])?;
        let Some(i) = rows.iter().position(|r| r["id"] == anchor) else {
            bail!("anchor page not found");
        };
        let k = |i: Option<usize>| {
            i.and_then(|i| rows.get(i))
                .and_then(|r| r["sort_key"].as_str())
                .unwrap_or("")
        };
        if trame_core::truthy(&to["before_id"]) {
            mid_key(k(i.checked_sub(1)), k(Some(i)))
        } else {
            mid_key(k(Some(i)), k(Some(i + 1)))
        }
    } else {
        end_key(db, &parent)?
    };
    let project = if trame_core::truthy(&parent) {
        project_above(db, &parent)?
    } else {
        Value::Null
    };
    db.query(
        "update pages set parent_id=$2, sort_key=$3,
       client_id = case when kind='story' then $5 else client_id end,
       origin=$4, updated_at=clock_timestamp() where id=$1",
        &[json!(id), parent, json!(key), json!(db.origin), project],
    )?;
    Ok(())
}

pub fn delete(db: &mut Db, id: &str) -> Result<()> {
    for table in ["udb_databases", "page_comments", "pages"] {
        let condition = if table == "pages" {
            "id in (select id from sub)"
        } else {
            "not deleted and page_id in (select id from sub)"
        };
        db.query(
            &format!(
                "with recursive sub as (
       select id from pages where id=$1
       union all
       select p.id from pages p join sub on p.parent_id = sub.id where not p.deleted
     ) update {table} set deleted=true, origin=$2, updated_at=clock_timestamp() where {condition}"
            ),
            &[json!(id), json!(db.origin)],
        )?;
    }
    Ok(())
}

pub fn story_from_page(db: &mut Db, id: &str) -> Result<Value> {
    let rows = db.query(
        "select kind, parent_id, client_id from pages where id=$1 and not deleted",
        &[json!(id)],
    )?;
    let Some(page) = rows.first() else {
        bail!("unknown page {id}");
    };
    if page["kind"] == "story" {
        return Ok(json!({"id":id}));
    }
    if page["kind"] != "page" {
        bail!("a project cannot become a user story");
    }
    if !db
        .query(
            "select 1 from sessions where specs_page_id=$1 and not deleted limit 1",
            &[json!(id)],
        )?
        .is_empty()
    {
        bail!("this page is a card's specs — it belongs to that card");
    }
    if trame_core::truthy(&page["parent_id"]) && !story_above(db, &page["parent_id"])?.is_null() {
        bail!(
            "this page is already under a user story — stories don't nest; convert it to a session instead"
        );
    }
    if !db
        .query(
            "with recursive down as (
       select id, kind, array[id] as path from pages where parent_id=$1 and not deleted
       union all
       select p.id, p.kind, down.path || p.id from pages p join down on p.parent_id=down.id
        where not p.deleted and not p.id = any(down.path)
     ) select 1 from down where kind='story' limit 1",
            &[json!(id)],
        )?
        .is_empty()
    {
        bail!("a user story sits below this page — stories don't nest");
    }
    let project = project_above(db, &json!(id))?;
    let project = if project.is_null() {
        page["client_id"].clone()
    } else {
        project
    };
    if !trame_core::truthy(&project) {
        bail!("file this page under a project first");
    }
    db.query("update pages set kind='story', parent_id=$2, client_id=$2, origin=$3, updated_at=clock_timestamp() where id=$1", &[json!(id),project,json!(db.origin)])?;
    Ok(json!({"id":id}))
}

pub fn session_from_page(db: &mut Db, page_id: &str) -> Result<Value> {
    let rows = db.query(
        "select title, kind, parent_id, client_id from pages where id=$1 and not deleted",
        &[json!(page_id)],
    )?;
    let Some(page) = rows.first() else {
        bail!("unknown page {page_id}");
    };
    if page["kind"] != "page" {
        bail!("a project or a story is where cards live, not a card's specs");
    }
    if let Some(hit) = db
        .query(
            "select id from sessions where specs_page_id=$1 and not deleted limit 1",
            &[json!(page_id)],
        )?
        .first()
    {
        return Ok(json!({"id":hit["id"], "created":false}));
    }
    let mut anchor = if trame_core::truthy(&page["parent_id"]) {
        story_above(db, &page["parent_id"])?
    } else {
        Value::Null
    };
    let id = uuid::Uuid::new_v5(
        &uuid::uuid!("9c1f4a02-7d3e-4c85-b6a1-0e58d2f7c934"),
        page_id.as_bytes(),
    )
    .to_string();
    let title = trame_core::trim(page["title"].as_str().unwrap_or(""));
    let title = if title.is_empty() { "Untitled" } else { title };
    let project = if page["client_id"].is_null() {
        project_above(db, &json!(page_id))?
    } else {
        page["client_id"].clone()
    };
    let current = db.query("select title,status,client_id,repo_path,next_step,pr_url,summary,branch,branches from sessions where id=$1", &[json!(id)])?;
    let cur = current.first().cloned().unwrap_or(Value::Null);
    if trame_core::truthy(&anchor) {
        let above = story_above(db, &anchor)?;
        if !above.is_null() {
            anchor = above;
        }
        db.query("update pages set kind='story', client_id=coalesce(client_id,$2), parent_id=coalesce(parent_id,$2),
       origin=$3, updated_at=clock_timestamp() where id=$1 and kind='page' and not deleted", &[anchor.clone(),project.clone(),json!(db.origin)])?;
    }
    let wanted = cur["status"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or("active");
    let statuses = db.query(
        "select key from statuses where not deleted order by terminal, sort_key",
        &[],
    )?;
    let status = if statuses.is_empty() || statuses.iter().any(|r| r["key"] == wanted) {
        json!(wanted)
    } else {
        statuses[0]["key"].clone()
    };
    let branches = cur["branches"]
        .as_str()
        .unwrap_or("")
        .lines()
        .map(trame_core::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    db.query("insert into sessions
       (id,title,status,client_id,page_id,repo_path,branch,next_step,pr_url,summary,claude_id,agent,last_touched,origin,updated_at,tags,branches)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$12,$13,clock_timestamp(),$11,clock_timestamp(),$16::jsonb,$17)
     on conflict (id) do update set
       title=$2,status=$3,client_id=$4,repo_path=$6,branch=$7,branches=$17,
       page_id=case when $14 then $5 else sessions.page_id end,
       tags=case when $15 then excluded.tags else sessions.tags end,
       next_step=$8,pr_url=$9,summary=$10,claude_id=coalesce($12,sessions.claude_id), agent=coalesce($13,sessions.agent),
       last_touched=clock_timestamp(),origin=$11,updated_at=clock_timestamp()", &[
        json!(id),json!(title),status,project,anchor,cur["repo_path"].clone(),Value::Null,cur["next_step"].clone(),cur["pr_url"].clone(),
        coalesce(&cur,"summary",json!("")),json!(db.origin),Value::Null,Value::Null,json!(true),json!(false),json!([]),json!(branches),
    ])?;
    db.query("update sessions set specs_page_id=$2, deleted=false, origin=$3, updated_at=clock_timestamp() where id=$1", &[json!(id),json!(page_id),json!(db.origin)])?;
    Ok(json!({"id":id,"created":true}))
}

pub fn events(db: &mut Db, id: &str) -> Result<Value> {
    Ok(json!(db.query("select distinct e.id, e.at, e.summary, e.kind, e.agent, e.model, e.tokens, e.cost_usd, e.agent_name, e.session_id,
            s.title as session_title, s.status as session_status
       from session_events e
       join session_links l on l.session_id = e.session_id and not l.deleted
       join sessions s on s.id = e.session_id and not s.deleted
      where l.page_id=$1 and not e.deleted order by e.at desc, e.id desc limit $2", &[json!(id),json!(100)])?))
}

pub fn handle(db: &mut Db, method: &str, path: &str, body: &Value) -> Option<Result<(u16, Value)>> {
    if path == "/api/pages" {
        return Some(if method == "POST" {
            Ok(match create(db, body) {
                Ok(id) => (200, json!({"id":id})),
                Err(e) => (400, json!({"error":e.to_string()})),
            })
        } else {
            list(db).map(|v| (200, v))
        });
    }
    let parts: Vec<_> = path.strip_prefix("/api/pages/")?.split('/').collect();
    if parts[0].is_empty() {
        return None;
    }
    let id = parts[0];
    if parts.len() == 2 && parts[1] == "events" && method == "GET" {
        return Some(events(db, id).map(|v| (200, v)));
    }
    if parts.len() == 1 && method == "GET" {
        return Some(get(db, id).map(|v| {
            if v.is_null() {
                (404, json!({"error":"not found"}))
            } else {
                (200, v)
            }
        }));
    }
    if method == "POST" {
        let result = match parts.as_slice() {
            [_] => update(db, id, body).map(|()| json!({"ok":true})),
            [_, "delete"] => delete(db, id).map(|()| json!({"ok":true})),
            [_, "move"] => move_page(db, id, body).map(|()| json!({"ok":true})),
            [_, "story"] => story_from_page(db, id),
            [_, "session"] => session_from_page(db, id),
            _ => return None,
        };
        return Some(Ok(match result {
            Ok(v) => (200, v),
            Err(e) => (400, json!({"error":e.to_string()})),
        }));
    }
    if parts.len() == 1 || (parts.len() == 2 && matches!(parts[1], "delete" | "move")) {
        return Some(Ok((
            405,
            json!({"error":format!("{method} not allowed; update a page with POST")}),
        )));
    }
    None
}

#[cfg(test)]
mod status_tests {
    use super::*;
    #[test]
    fn page_status_typescript_assertions() {
        for status in PAGE_STATUSES {
            assert!(is_page_status(&json!(status)));
        }
        for status in [
            json!(""),
            json!("Archived"),
            json!("todo"),
            json!("in_progress"),
            Value::Null,
            json!(3),
        ] {
            assert!(!is_page_status(&status));
        }
        assert!(!is_page_status(&json!({})["undefined"]));
        assert!(!is_page_status(&json!("done")));
        assert!(PAGE_STATUSES.contains(&"archived"));
    }
}
