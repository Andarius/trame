use crate::db::Db;
use anyhow::{Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use trame_core::{trim, truthy};

pub const AGENT_AUTHOR_ID: &str = "00000000-0000-4000-8000-0000000000aa";
/// Row threads live in `page_comments` on the database's page, `block_id` = `row:<row id>`.
pub const ROW_PREFIX: &str = "row:";
/// SQL for a `udb_rows` row's thread `block_id` (rows aliased as the bare table).
pub const ROW_BLOCK_SQL: &str = "'row:' || id::text";
const COLS: &str = "id, page_id, block_id, anchor, body, author, author_avatar, author_id, resolved, meta, updated_at";

pub fn list(db: &mut Db, page: &str) -> Result<Value> {
    let cols = COLS
        .split(", ")
        .map(|c| format!("c.{c}"))
        .collect::<Vec<_>>()
        .join(", ");
    Ok(json!(db.query(&format!("select {cols}, s.status as agent_status, s.agent as agent_status_agent from page_comments c left join lateral (select status,agent from comment_agent_status where comment_id=c.id and not deleted order by updated_at desc limit 1) s on true where c.page_id=$1 and not c.deleted order by c.updated_at"), &[json!(page)])?))
}

pub fn create(db: &mut Db, p: &Value) -> Result<String> {
    if p.is_null() {
        bail!("Cannot read properties of null (reading 'agent')");
    }
    if !p["author"].is_null() && !p["author"].is_string() {
        bail!("p.author?.trim is not a function");
    }
    let me = db.identity()?;
    let agent = if truthy(&p["agent"]) {
        Some(agent_identity(p["agent"].as_str().ok_or_else(|| {
            anyhow::anyhow!("agent.trim is not a function")
        })?)?)
    } else {
        None
    };
    let author = agent
        .as_ref()
        .map(|a| a["name"].as_str().unwrap())
        .unwrap_or_else(|| trim(p["author"].as_str().unwrap_or("")));
    let mut meta = p["meta"].clone();
    if agent.is_some() {
        if !meta.is_object() {
            meta = match meta {
                Value::Array(values) => Value::Object(
                    values
                        .into_iter()
                        .enumerate()
                        .map(|(i, v)| (i.to_string(), v))
                        .collect(),
                ),
                Value::String(value) => Value::Object(
                    value
                        .chars()
                        .enumerate()
                        .map(|(i, c)| (i.to_string(), json!(c.to_string())))
                        .collect(),
                ),
                _ => json!({}),
            };
        }
        let model = trim(p["meta"]["model"].as_str().unwrap_or(""));
        meta["model"] = json!(if model.is_empty() {
            trim(p["agent"].as_str().unwrap()).to_lowercase()
        } else {
            model.into()
        });
    }
    let avatar = if let Some(a) = &agent {
        a["avatar"].clone()
    } else if !author.is_empty() {
        p.get("author_avatar")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(json!(""))
    } else {
        me["avatar"].clone()
    };
    let origin = json!(db.origin);
    let rows = db.query("insert into page_comments (page_id,block_id,anchor,body,author,author_avatar,author_id,meta,origin) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id", &[
        p["page_id"].clone(),p["block_id"].clone(),p.get("anchor").filter(|v| !v.is_null()).cloned().unwrap_or(json!("")),p["body"].clone(),json!(if author.is_empty() {me["name"].as_str().unwrap()} else {author}),avatar,
        if agent.is_some() {json!(AGENT_AUTHOR_ID)} else {me["userId"].clone()}, if truthy(&meta) {json!(crate::json::stringify(&meta))} else {Value::Null},origin])?;
    Ok(rows[0]["id"].as_str().unwrap().into())
}
pub fn update(db: &mut Db, id: &str, p: &Value) -> Result<()> {
    if p.is_null() {
        bail!("Cannot read properties of null (reading 'body')");
    }
    if !p["author"].is_null() && !p["author"].is_string() {
        bail!("patch.author?.trim is not a function");
    }
    let author = trim(p["author"].as_str().unwrap_or(""));
    let origin = json!(db.origin);
    db.query(&format!("update page_comments set body=coalesce($2,body),resolved=coalesce($3,resolved),author=coalesce($4,author),author_avatar=case when $4::text is null then author_avatar else coalesce($5,'') end,author_id=case when $4::text is null then author_id else '{AGENT_AUTHOR_ID}'::uuid end,origin=$6,updated_at=clock_timestamp() where id=$1"), &[json!(id),p["body"].clone(),p["resolved"].clone(),if author.is_empty() {Value::Null} else {json!(author)},p["author_avatar"].clone(),origin])?;
    Ok(())
}
pub fn delete(db: &mut Db, id: &str) -> Result<()> {
    let origin = json!(db.origin);
    db.query(
        "update page_comments set deleted=true,origin=$2,updated_at=clock_timestamp() where id=$1",
        &[json!(id), origin],
    )?;
    Ok(())
}
pub fn set_status(db: &mut Db, id: &str, p: &Value) -> Result<()> {
    let rows = db.query(
        "select page_id,body from page_comments where id=$1 and not deleted",
        &[json!(id)],
    )?;
    let Some(c) = rows.first() else {
        bail!("comment \"{id}\" was not found")
    };
    let origin = json!(db.origin);
    if p["status"] == "clear" {
        db.query("update comment_agent_status set deleted=true,origin=$2,updated_at=clock_timestamp() where id=$1", &[json!(id),origin])?;
    } else {
        db.query("insert into comment_agent_status (id,comment_id,page_id,status,agent,body_hash,origin) values ($1,$1,$2,$3,coalesce($4,''),md5($5),$6) on conflict (id) do update set page_id=excluded.page_id,status=excluded.status,agent=coalesce($4,comment_agent_status.agent),body_hash=excluded.body_hash,deleted=false,origin=excluded.origin,updated_at=clock_timestamp()", &[json!(id),c["page_id"].clone(),p["status"].clone(),p["agent"].clone(),c["body"].clone(),origin])?;
    }
    Ok(())
}
pub fn inbox(db: &mut Db, stale: f64, pages: &[String], all: bool) -> Result<Value> {
    let origin = json!(db.origin);
    db.query("update comment_agent_status s set deleted=true,origin=$1,updated_at=clock_timestamp() where not s.deleted and not exists (select 1 from page_comments c where c.id=s.comment_id and not c.deleted)", &[origin])?;
    let mut params = vec![json!(AGENT_AUTHOR_ID), json!(stale)];
    let page_cond = if pages.is_empty() {
        ""
    } else {
        params.push(json!(pages));
        "and c.page_id=any($3::uuid[])"
    };
    let agent_cond = if all {
        ""
    } else {
        "and exists (select 1 from page_comments a where a.page_id=c.page_id and a.block_id=c.block_id and not a.deleted and a.author_id=$1 and a.updated_at<c.updated_at)"
    };
    let cols = COLS
        .split(", ")
        .map(|c| format!("c.{c}"))
        .collect::<Vec<_>>()
        .join(", ");
    let candidates=db.query(&format!("with latest as (select distinct on (comment_id) comment_id,status,body_hash,updated_at from comment_agent_status where not deleted order by comment_id,updated_at desc) select {cols} from page_comments c left join latest s on s.comment_id=c.id where not c.deleted and not c.resolved and c.author_id is distinct from $1::uuid {page_cond} {agent_cond} and not exists (select 1 from page_comments a where a.page_id=c.page_id and a.block_id=c.block_id and not a.deleted and a.id<>c.id and a.updated_at>c.updated_at) and (s.comment_id is null or s.status='seen' or s.body_hash is distinct from md5(c.body) or (s.status='answering' and s.updated_at<clock_timestamp()-make_interval(secs=>$2))) order by c.updated_at"), &params)?;
    let mut items = Vec::new();
    for c in candidates {
        let rows = db.query(
            "select id,title,content from pages where id=$1 and not deleted",
            &[c["page_id"].clone()],
        )?;
        let Some(page) = rows.first() else { continue };
        let block = c["block_id"].as_str().unwrap_or("");
        let row = match block.strip_prefix(ROW_PREFIX) {
            Some(row_id) => row_target(db, row_id)?,
            None => Value::Null,
        };
        let text = if row.is_null() {
            resolve_block(&page["content"], &json!({"block_id":block}))
                .map(|b| b["text"].clone())
                .unwrap_or_else(|_| c["anchor"].clone())
        } else {
            row["title"].clone()
        };
        let thread=db.query(&format!("select {COLS} from page_comments where page_id=$1 and block_id=$2 and not deleted order by updated_at"), &[c["page_id"].clone(),c["block_id"].clone()])?;
        let agent = thread
            .iter()
            .rev()
            .find(|t| t["author_id"] == AGENT_AUTHOR_ID)
            .and_then(|t| t["author"].as_str())
            .unwrap_or("claude")
            .to_lowercase();
        let mut item = json!({"comment":c,"page":{"id":page["id"],"title":page["title"]},"block":{"id":block,"text":text},"thread":thread,"agent":agent});
        if !row.is_null() {
            item["row"] = json!({"id":row["id"],"db_id":row["db_id"],"db_name":row["db_name"],"title":row["title"]});
        }
        items.push(item);
    }
    Ok(json!(items))
}
/// A row thread's target: the live row (`id`, `db_id`, `db_name`, `page_id`, `title`), or null once gone.
pub fn row_target(db: &mut Db, row_id: &str) -> Result<Value> {
    if !crate::routes::valid_uuid(row_id) {
        return Ok(Value::Null);
    }
    Ok(db.query("select r.id, r.db_id, d.name as db_name, d.page_id, coalesce(r.vals->>(select p.id::text from udb_properties p where p.db_id=r.db_id and p.type='title' and not p.deleted order by p.sort_key limit 1), '') as title from udb_rows r join udb_databases d on d.id=r.db_id and not d.deleted where r.id=$1 and not r.deleted", &[json!(row_id)])?.into_iter().next().unwrap_or(Value::Null))
}
pub fn delete_row_thread(db: &mut Db, row_id: &str) -> Result<()> {
    let origin = json!(db.origin);
    db.query(
        "update page_comments set deleted=true,origin=$2,updated_at=clock_timestamp() where block_id=$1 and not deleted",
        &[json!(format!("{ROW_PREFIX}{row_id}")), origin],
    )?;
    Ok(())
}
/// Row threads follow their database when it moves to another page (the hub ACL gates by `page_id`).
pub fn rehome_row_threads(db: &mut Db, db_id: &str, page_id: &Value) -> Result<()> {
    let origin = json!(db.origin);
    let params = [json!(db_id), page_id.clone(), origin];
    db.query(&format!("update comment_agent_status set page_id=$2,origin=$3,updated_at=clock_timestamp() where not deleted and page_id<>$2 and comment_id in (select id from page_comments where block_id in (select {ROW_BLOCK_SQL} from udb_rows where db_id=$1))"), &params)?;
    db.query(&format!("update page_comments set page_id=$2,origin=$3,updated_at=clock_timestamp() where not deleted and page_id<>$2 and block_id in (select {ROW_BLOCK_SQL} from udb_rows where db_id=$1)"), &params)?;
    Ok(())
}
pub fn resolve_block(content: &Value, target: &Value) -> Result<Value> {
    let blocks: Vec<_> = content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|b| {
            matches!(b["type"].as_str(), Some("text" | "heading" | "todo"))
                && b["id"].is_string()
                && b["text"].is_string()
        })
        .collect();
    let result = |b: &Value| json!({"id":b["id"],"text":b["text"]});
    if let Some(id) = target["block_id"].as_str().filter(|s| !s.is_empty()) {
        return blocks
            .iter()
            .find(|b| b["id"] == id)
            .map(|b| result(b))
            .ok_or_else(|| anyhow::anyhow!("block_id \"{id}\" was not found"));
    }
    let want = trame_core::todo_marks::strip_marks(target["block_text"].as_str().unwrap_or(""));
    let want = trim(&want);
    if !want.is_empty() {
        let mut matches: Vec<_> = blocks
            .iter()
            .filter(|b| {
                trim(&trame_core::todo_marks::strip_marks(
                    b["text"].as_str().unwrap(),
                )) == want
            })
            .collect();
        if matches.is_empty() {
            matches = blocks
                .iter()
                .filter(|b| {
                    trame_core::todo_marks::strip_marks(b["text"].as_str().unwrap()).contains(want)
                })
                .collect();
        }
        if matches.len() == 1 {
            return Ok(result(matches[0]));
        }
        if matches.len() > 1 {
            bail!("block_text \"{want}\" matches multiple blocks; use block_id")
        }
        bail!("block_text \"{want}\" was not found")
    }
    if blocks.len() == 1 {
        return Ok(result(blocks[0]));
    }
    let choices = blocks
        .iter()
        .take(8)
        .map(|b| {
            format!(
                "{}: {}",
                b["id"].as_str().unwrap(),
                trim(b["text"].as_str().unwrap())
                    .split(trame_core::whitespace)
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ")
                    .chars()
                    .take(80)
                    .collect::<String>()
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    bail!(
        "block_id or unique block_text is required{}",
        if choices.is_empty() {
            " (page has no commentable blocks)".into()
        } else {
            format!(":\n{choices}")
        }
    )
}

pub fn agent_identity(agent: &str) -> Result<Value> {
    let key = trim(agent).to_lowercase();
    if key.is_empty() {
        bail!("agent is required")
    }
    let (name, svg) = match key.as_str() {
        "codex" => (
            "Codex".into(),
            brand(
                "OpenAI",
                OPENAI_PATH,
                "#111827",
                "translate(5 5) scale(.9166667)",
            ),
        ),
        "claude" => (
            "Claude".into(),
            brand(
                "Anthropic",
                ANTHROPIC_PATH,
                "#D97757",
                "translate(5 5) scale(.9166667)",
            ),
        ),
        "glm" => (
            "GLM".into(),
            brand(
                "Z.ai",
                ZAI_PATH,
                "#2D2D2D",
                "translate(-1.4 -1.4) scale(1.16)",
            ),
        ),
        _ => {
            let initial = key.chars().next().unwrap().to_uppercase().to_string();
            let name = if key.encode_utf16().count() <= 4 {
                key.to_uppercase()
            } else {
                format!(
                    "{initial}{}",
                    &key[key.chars().next().unwrap().len_utf8()..]
                )
            };
            let palette = [
                "#7a9ee7", "#b590e7", "#c98a63", "#7bd88f", "#e3c567", "#e06c75", "#56b6c2",
                "#8b93a3",
            ];
            let sum: usize = key
                .chars()
                .map(|c| {
                    let mut buf = [0u16; 2];
                    c.encode_utf16(&mut buf)[0] as usize
                })
                .sum();
            let bg = palette[sum % palette.len()];
            let svg = format!(
                "<svg role=\"img\" viewBox=\"0 0 32 32\" xmlns=\"http://www.w3.org/2000/svg\"><title>{name}</title><circle cx=\"16\" cy=\"16\" r=\"16\" fill=\"{bg}\"/><text x=\"16\" y=\"22\" font-family=\"sans-serif\" font-size=\"17\" font-weight=\"600\" fill=\"white\" text-anchor=\"middle\">{initial}</text></svg>"
            );
            (name, svg)
        }
    };
    Ok(
        json!({"name":name,"avatar":format!("data:image/svg+xml;base64,{}",STANDARD.encode(svg.chars().map(|c| u8::try_from(c as u32)).collect::<Result<Vec<_>,_>>()?))}),
    )
}
fn brand(title: &str, path: &str, bg: &str, transform: &str) -> String {
    format!(
        "<svg role=\"img\" viewBox=\"0 0 32 32\" xmlns=\"http://www.w3.org/2000/svg\"><title>{title}</title><circle cx=\"16\" cy=\"16\" r=\"16\" fill=\"{bg}\"/><g transform=\"{transform}\" fill=\"white\"><path d=\"{path}\"/></g></svg>"
    )
}

const OPENAI_PATH: &str = "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";

const ANTHROPIC_PATH: &str = "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z";

const ZAI_PATH: &str = "M15.47,7.1l-1.3,1.85c-0.2,0.29-0.54,0.47-0.9,0.47h-7.1V7.09C6.16,7.1,15.47,7.1,15.47,7.1z M24.3,7.1 L13.14,22.91 L5.7,22.91 L16.86,7.1 Z M14.53,22.91l1.31-1.86c0.2-0.29,0.54-0.47,0.9-0.47h7.09v2.33H14.53z";
