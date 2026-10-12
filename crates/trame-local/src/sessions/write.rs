use super::{board, first, origin, stories};
use crate::{db::Db, pages};
use anyhow::{Result, bail};
use serde_json::{Map, Value, json};
use std::collections::HashSet;

const SPECS_WHEN: &str = r#"Write a spec page whenever the session produced knowledge worth keeping — planned
work (a goal paragraph, then scope and acceptance as `- [ ]` todos you check as you
go, with `links` back to the TODO/plan item; anything left blocked or waiting stays an
open todo with a `{{trame:due=YYYY-MM-DD}}` mark: when it unblocks, or when to check
again) and
investigations (what broke, what was ruled out, what is still open) alike; the page is
the only place that survives, `summary` is 1–3 lines. When the session's whole story
is its diff, the spec page and the PR description are the same text — write it once on
the page and reuse it for the PR: its goal is the PR's brief."#;

fn slug(label: &str, fallback: &str) -> String {
    let mut out = String::new();
    for c in label.chars() {
        if ('\u{0300}'..='\u{036f}').contains(&c) {
            continue;
        }
        let c = match c {
            'à' | 'á' | 'â' | 'ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'î' | 'ï' => 'i',
            'ô' | 'ö' => 'o',
            'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            _ => c.to_ascii_lowercase(),
        };
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_matches('-');
    if out.is_empty() {
        fallback.into()
    } else {
        out.into()
    }
}

fn mid_key(a: &str) -> String {
    pages::mid_key(a, "")
}

pub fn tag_key(label: &str) -> String {
    slug(label, "")
}

pub fn split_tag_label(label: &str) -> Value {
    if let Some((ns, value)) = label
        .split_once(':')
        .filter(|(ns, value)| !ns.is_empty() && !value.is_empty())
    {
        json!({"ns":ns.trim(),"value":value.trim()})
    } else {
        json!({"ns":null,"value":label})
    }
}

pub fn tag_color(key: &str) -> &'static str {
    let mut hash: u32 = 2166136261;
    for c in key.encode_utf16() {
        hash = (hash ^ c as u32).wrapping_mul(16777619);
    }
    let palette = [
        "#6b7280", "#c98a63", "#e3c567", "#7bd88f", "#5fc2b0", "#6aa9e0", "#a78bd8", "#dd8ab8",
        "#e06c75",
    ];
    palette[(hash as i32 as i64).abs() as usize % palette.len()]
}

pub fn ensure_tag(db: &mut Db, label: &str, color: Option<&Value>) -> Result<Value> {
    let key = slug(label, "tag");
    let id = uuid::Uuid::new_v5(
        &uuid::uuid!("3c9e0b71-2f45-4d18-a6c3-8e5417b9d0aa"),
        key.as_bytes(),
    )
    .to_string();
    let last = first(
        db,
        "select max(sort_key) as k from tags where not deleted",
        &[],
    )?;
    let from = origin(db);
    db.query("insert into tags(id,key,label,color,sort_key,origin) values($1,$2,$3,$4,$5,$6) on conflict(id) do update set label=excluded.label,deleted=false,origin=excluded.origin,updated_at=clock_timestamp()",&[json!(id),json!(key),json!(label),color.cloned().filter(|v|!v.is_null()).unwrap_or(json!(tag_color(&key))),json!(mid_key(last["k"].as_str().unwrap_or(""))),from])?;
    Ok(json!({"id":id,"key":key}))
}

fn status_key(db: &mut Db, wanted: &Value) -> Result<Value> {
    let want = wanted
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or("active");
    let rows = db.query(
        "select key from statuses where not deleted order by terminal,sort_key",
        &[],
    )?;
    Ok(
        if rows.is_empty() || rows.iter().any(|r| r["key"] == want) {
            json!(want)
        } else {
            rows[0]["key"].clone()
        },
    )
}

pub fn create_status(db: &mut Db, body: &Value) -> Result<Value> {
    let base = slug(body["label"].as_str().unwrap_or(""), "status");
    let taken: HashSet<String> = db
        .query("select key from statuses where not deleted", &[])?
        .iter()
        .filter_map(|r| r["key"].as_str().map(str::to_owned))
        .collect();
    let key = if !taken.contains(&base) {
        base
    } else {
        (2..)
            .map(|n| format!("{base}-{n}"))
            .find(|k| !taken.contains(k))
            .unwrap()
    };
    let id = uuid::Uuid::new_v5(
        &uuid::uuid!("6f1d4a2e-8c3b-4f9a-9d2e-5b7c1a0e3f84"),
        key.as_bytes(),
    )
    .to_string();
    let last = first(
        db,
        "select max(sort_key) as k from statuses where not deleted",
        &[],
    )?;
    let from = origin(db);
    db.query("insert into statuses(id,key,label,color,terminal,sort_key,origin) values($1,$2,$3,$4,$5,$6,$7) on conflict(id) do update set label=$3,color=$4,terminal=$5,sort_key=$6,deleted=false,origin=$7,updated_at=clock_timestamp()",&[json!(id),json!(key),body["label"].clone(),body["color"].clone(),json!(body["terminal"].as_bool().unwrap_or(false)),json!(mid_key(last["k"].as_str().unwrap_or(""))),from])?;
    Ok(json!(id))
}

pub fn status_route(
    db: &mut Db,
    id: &str,
    action: Option<&str>,
    body: &Value,
) -> Result<(u16, Value)> {
    let from = origin(db);
    let result: Result<()> = (|| {
        match action {
            Some("delete") => {
                let all=db.query("select id,key,terminal from statuses where not deleted order by terminal asc,sort_key",&[])?;
                if let Some(victim) = all.iter().find(|r| r["id"] == id) {
                    if all.len() <= 1 {
                        bail!("cannot delete the last status");
                    }
                    let fallback = all.iter().find(|r| r["id"] != id).unwrap();
                    db.query("update sessions set status=$2,origin=$3,updated_at=clock_timestamp() where status=$1 and not deleted",&[victim["key"].clone(),fallback["key"].clone(),from.clone()])?;
                    db.query("update statuses set deleted=true,origin=$2,updated_at=clock_timestamp() where id=$1",&[json!(id),from.clone()])?;
                }
            }
            Some("move") => {
                let rows = db.query(
                    "select id,sort_key from statuses where not deleted order by sort_key",
                    &[],
                )?;
                if let Some(i) = rows.iter().position(|r| r["id"] == id) {
                    let j = if body["dir"] == -1 {
                        i.checked_sub(1)
                    } else {
                        i.checked_add(1).filter(|j| *j < rows.len())
                    };
                    if let Some(j) = j {
                        db.query("update statuses set sort_key=case id when $1 then $4 when $2 then $3 else sort_key end,origin=$5,updated_at=clock_timestamp() where id in ($1,$2)",&[rows[i]["id"].clone(),rows[j]["id"].clone(),rows[i]["sort_key"].clone(),rows[j]["sort_key"].clone(),from.clone()])?;
                    }
                }
            }
            _ => {
                db.query("update statuses set label=coalesce($2,label),color=coalesce($3,color),terminal=coalesce($4,terminal),origin=$5,updated_at=clock_timestamp() where id=$1",&[json!(id),body["label"].clone(),body["color"].clone(),body["terminal"].clone(),from.clone()])?;
            }
        }
        Ok(())
    })();
    Ok(match result {
        Ok(()) => (200, json!({"ok":true})),
        Err(e) => (400, json!({"error":e.to_string()})),
    })
}

fn merge_lines(current: &Value, incoming: &Value) -> String {
    let lines = |v: &Value| {
        v.as_str()
            .unwrap_or("")
            .lines()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    let add = lines(incoming);
    let mut merged = lines(current)
        .into_iter()
        .filter(|s| !add.contains(s))
        .collect::<Vec<_>>();
    merged.extend(add);
    merged.join("\n")
}

fn set_if_absent(s: &mut Map<String, Value>, key: &str, value: Value) {
    if !s.contains_key(key) {
        s.insert(key.into(), value);
    }
}
fn get(s: &Map<String, Value>, key: &str) -> Value {
    s.get(key).cloned().unwrap_or(Value::Null)
}

pub fn default_tags(path: &str) -> Vec<String> {
    let map = std::env::var("TRACKER_CLIENTS")
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or(Value::Null);
    default_tags_for(path, &map)
}

pub fn client_for(path: &str, map: &Value) -> String {
    let Some(entries) = map.as_object() else {
        return "Side-projects".into();
    };
    let has_segment = |segment: &str| {
        path.contains(&format!("/{segment}/"))
            || path.ends_with(&format!("/{segment}"))
            || path.starts_with("/tmp/claude-")
                && (path.contains(&format!("-{segment}-"))
                    || path.contains(&format!("-{segment}/")))
    };
    entries
        .iter()
        .find(|(segment, _)| has_segment(segment))
        .and_then(|(_, entry)| entry.as_str().or_else(|| entry["project"].as_str()))
        .map(str::to_owned)
        .unwrap_or_else(|| "Side-projects".into())
}

pub fn default_tags_for(path: &str, map: &Value) -> Vec<String> {
    let Some(entries) = map.as_object() else {
        return Vec::new();
    };
    let has_segment = |segment: &str| {
        path.contains(&format!("/{segment}/"))
            || path.ends_with(&format!("/{segment}"))
            || path.starts_with("/tmp/claude-")
                && (path.contains(&format!("-{segment}-"))
                    || path.contains(&format!("-{segment}/")))
    };
    for (segment, entry) in entries {
        if !has_segment(segment) {
            continue;
        }
        let tags = entry["tags"]
            .as_array()
            .map(|v| {
                v.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if entry["repos"]
            .as_array()
            .is_some_and(|repos| !repos.iter().filter_map(Value::as_str).any(has_segment))
        {
            return Vec::new();
        }
        return tags;
    }
    Vec::new()
}

pub fn upsert(db: &mut Db, raw: &Value, note: Option<&mut String>) -> Result<Value> {
    let mut raw = raw.clone();
    upsert_mut(db, &mut raw, note)
}

fn upsert_mut(db: &mut Db, raw: &mut Value, note: Option<&mut String>) -> Result<Value> {
    let mut s = raw.as_object().cloned().unwrap_or_default();
    let explicit = s.get("id").is_some_and(trame_core::truthy);
    if let Some(tags) = s.get("tags") {
        let Some(tags) = tags.as_array() else {
            bail!("tags must be an array of non-empty tag keys");
        };
        if tags
            .iter()
            .any(|t| !t.as_str().is_some_and(|s| !s.trim().is_empty()))
        {
            bail!("tags must be an array of non-empty tag keys");
        }
        let mut seen = HashSet::new();
        s.insert(
            "tags".into(),
            json!(
                tags.iter()
                    .filter_map(Value::as_str)
                    .map(|t| slug(t, ""))
                    .filter(|t| seen.insert(t.clone()))
                    .collect::<Vec<_>>()
            ),
        );
    }
    if !trame_core::truthy(&get(&s, "claude_id")) {
        if let Some(v) = s.get("agent_id").cloned() {
            s.insert("claude_id".into(), v);
        }
    }
    if trame_core::truthy(&get(&s, "claude_id")) && !trame_core::truthy(&get(&s, "agent")) {
        s.insert("agent".into(), json!("claude"));
    }
    if let Some(name) = get(&s, "client")
        .as_str()
        .filter(|_| !trame_core::truthy(&get(&s, "client_id")))
    {
        s.insert("client_id".into(), pages::resolve_client(db, name)?);
    }
    let project_omitted = !s.contains_key("client_id");
    let story = get(&s, "story")
        .as_str()
        .filter(|v| !v.trim().is_empty())
        .map(str::to_owned);
    if !trame_core::truthy(&get(&s, "id")) && trame_core::truthy(&get(&s, "claude_id")) {
        let matched = if let Some(story) = story.as_deref() {
            stories::match_story(db, story, &get(&s, "client_id"), None)?
        } else {
            Value::Null
        };
        let anchor = if matched.is_null() {
            Value::Null
        } else {
            let above = pages::story_above(db, &matched)?;
            if above.is_null() { matched } else { above }
        };
        let found = if !anchor.is_null() {
            first(
                db,
                "select id from sessions where (claude_id=$1 or id=$1) and page_id=$2 and not deleted and status not in(select key from statuses where terminal and not deleted) order by last_touched desc limit 1",
                &[get(&s, "claude_id"), anchor],
            )?
        } else if story.is_some() {
            Value::Null
        } else {
            first(
                db,
                "select id from sessions where (claude_id=$1 or id=$1) and not deleted and status not in(select key from statuses where terminal and not deleted) and ($2='' or coalesce(branches,'')='' or $2=any(string_to_array(branches,E'\\n'))) order by last_touched desc limit 1",
                &[
                    get(&s, "claude_id"),
                    json!(get(&s, "branch").as_str().unwrap_or("")),
                ],
            )?
        };
        if !found.is_null() {
            s.insert("id".into(), found["id"].clone());
        }
    }
    if !trame_core::truthy(&get(&s, "id")) && trame_core::truthy(&get(&s, "repo_path")) {
        let found = first(
            db,
            "select id from sessions where repo_path=$1 and not deleted and status not in(select key from statuses where terminal and not deleted) and (coalesce(branch,'')=$2 or $2=any(string_to_array(branches,E'\\n'))) and ($3::uuid is null or claude_id is null) order by last_touched desc limit 1",
            &[
                get(&s, "repo_path"),
                json!(get(&s, "branch").as_str().unwrap_or("")),
                get(&s, "claude_id"),
            ],
        )?;
        if !found.is_null() {
            s.insert("id".into(), found["id"].clone());
        }
    }
    if !trame_core::truthy(&get(&s, "id"))
        && trame_core::truthy(&get(&s, "repo_path"))
        && trame_core::truthy(&get(&s, "branch"))
    {
        let planned=db.query("select id,page_id from sessions where repo_path=$1 and coalesce(branch,'')='' and not deleted and status not in(select key from statuses where terminal and not deleted) order by last_touched desc",&[get(&s,"repo_path")])?;
        if !planned.is_empty() {
            let anchor = if let Some(story) = story.as_deref() {
                stories::find_story(db, story, &get(&s, "client_id"))?
            } else {
                Value::Null
            };
            if let Some(hit) = planned
                .iter()
                .find(|r| r["page_id"].is_null() || r["page_id"] == anchor)
            {
                s.insert("id".into(), hit["id"].clone());
            }
        }
    }
    let mut note = note;
    if !s.contains_key("page_id") {
        if let Some(story) = story.as_deref() {
            let current = if trame_core::truthy(&get(&s, "id")) {
                first(
                    db,
                    "select page_id from sessions where id=$1 and not deleted",
                    &[get(&s, "id")],
                )?
            } else {
                Value::Null
            };
            if !trame_core::truthy(&current["page_id"]) {
                let mut client = get(&s, "client_id");
                let reused = if client.is_null() {
                    stories::match_story(db, story, &Value::Null, note.as_deref_mut())?
                } else {
                    Value::Null
                };
                if client.is_null() && project_omitted {
                    if let Some(path) = get(&s, "repo_path").as_str() {
                        client = pages::resolve_home_project(db, path)?;
                    }
                }
                let tags = get(&s, "repo_path")
                    .as_str()
                    .map(default_tags)
                    .unwrap_or_default();
                let anchor = if reused.is_null() {
                    stories::resolve_story(db, story, &client, &tags, note)?
                } else {
                    reused
                };
                s.insert("page_id".into(), anchor);
            }
        }
    }
    let id = get(&s, "id")
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let cur = if trame_core::truthy(&get(&s, "id")) {
        first(
            db,
            "select title,status,client_id,repo_path,next_step,pr_url,summary,branch,branches from sessions where id=$1",
            &[json!(id)],
        )?
    } else {
        Value::Null
    };
    if let Some(row) = cur.as_object() {
        for key in [
            "title",
            "status",
            "client_id",
            "repo_path",
            "next_step",
            "pr_url",
            "summary",
        ] {
            set_if_absent(&mut s, key, row[key].clone());
        }
    }
    if trame_core::truthy(&get(&s, "page_id")) {
        let above = pages::story_above(db, &get(&s, "page_id"))?;
        if !above.is_null() {
            s.insert("page_id".into(), above);
        }
        if project_omitted && !trame_core::truthy(&get(&s, "client_id")) {
            let mut project = pages::project_above(db, &get(&s, "page_id"))?;
            if project.is_null() {
                if let Some(path) = get(&s, "repo_path").as_str() {
                    project = pages::resolve_home_project(db, path)?;
                }
            }
            if !project.is_null() {
                s.insert("client_id".into(), project);
            }
        }
        let from = origin(db);
        db.query("update pages set kind='story',client_id=coalesce(client_id,$2),parent_id=coalesce(parent_id,$2),origin=$3,updated_at=clock_timestamp() where id=$1 and kind='page' and not deleted",&[get(&s,"page_id"),get(&s,"client_id"),from])?;
    }
    if !cur.is_null() && !explicit {
        set_if_absent(&mut s, "branch", cur["branch"].clone());
        let merged = merge_lines(&cur["pr_url"], &get(&s, "pr_url"));
        s.insert(
            "pr_url".into(),
            if merged.is_empty() {
                Value::Null
            } else {
                json!(merged)
            },
        );
    }
    let branches = merge_lines(&cur["branches"], &get(&s, "branch"));
    let status = status_key(db, &get(&s, "status"))?;
    let from = origin(db);
    db.query("insert into sessions(id,title,status,client_id,page_id,repo_path,branch,next_step,pr_url,summary,claude_id,agent,last_touched,origin,updated_at,tags,branches) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$12,$13,clock_timestamp(),$11,clock_timestamp(),$16::jsonb,$17) on conflict(id) do update set title=$2,status=$3,client_id=$4,repo_path=$6,branch=$7,branches=$17,page_id=case when $14 then $5 else sessions.page_id end,tags=case when $15 then excluded.tags else sessions.tags end,next_step=$8,pr_url=$9,summary=$10,claude_id=coalesce($12,sessions.claude_id),agent=coalesce($13,sessions.agent),last_touched=clock_timestamp(),origin=$11,updated_at=clock_timestamp()",&[json!(id),get(&s,"title"),status,get(&s,"client_id"),get(&s,"page_id"),get(&s,"repo_path"),get(&s,"branch"),get(&s,"next_step"),get(&s,"pr_url"),s.get("summary").cloned().filter(|v|!v.is_null()).unwrap_or(json!("")),from,get(&s,"claude_id"),get(&s,"agent"),json!(s.contains_key("page_id")),json!(s.contains_key("tags")),json!(s.get("tags").cloned().unwrap_or(json!([])).to_string()),json!(branches)])?;
    *raw = Value::Object(s);
    Ok(json!(id))
}

pub fn ensure_specs_page(db: &mut Db, id: &str) -> Result<Value> {
    let s = first(
        db,
        "select title,client_id,page_id,specs_page_id from sessions where id=$1 and not deleted",
        &[json!(id)],
    )?;
    if s.is_null() {
        bail!("unknown session {id}");
    }
    if let Some(pid) = s["specs_page_id"].as_str() {
        if !first(
            db,
            "select 1 from pages where id=$1 and not deleted",
            &[json!(pid)],
        )?
        .is_null()
        {
            return Ok(json!(pid));
        }
    }
    let pid = uuid::Uuid::new_v5(
        &uuid::uuid!("b2f6c1d8-4e5a-4b7c-8f1d-2a9e6c3b0d47"),
        id.as_bytes(),
    )
    .to_string();
    let from = origin(db);
    let parent = if s["page_id"].is_null() {
        s["client_id"].clone()
    } else {
        s["page_id"].clone()
    };
    db.query("insert into pages(id,kind,title,client_id,parent_id,origin,owner_id) values($1,'page',$2,$3,$4,$5,(select user_id from devices where node_id=$5 and not deleted limit 1)) on conflict(id) do update set deleted=false,origin=$5,updated_at=clock_timestamp() where pages.deleted",&[json!(pid),json!(format!("Specs — {}",s["title"].as_str().unwrap_or(""))),s["client_id"].clone(),parent,from.clone()])?;
    db.query(
        "update sessions set specs_page_id=$2,origin=$3,updated_at=clock_timestamp() where id=$1",
        &[json!(id), json!(pid), from],
    )?;
    Ok(json!(pid))
}

pub fn create_route(db: &mut Db, body: &Value) -> Result<(u16, Value)> {
    let mut body = body.clone();
    if let Some(card) = body.get("card") {
        let card = trame_core::js_string(card).to_lowercase();
        if !crate::routes::valid_uuid(&card) {
            return Ok((400, json!({"error":"card must be a session id"})));
        }
        if first(
            db,
            "select 1 from sessions where id=$1 and not deleted",
            &[json!(card)],
        )?
        .is_null()
        {
            return Ok((404, json!({"error":format!("no card {card}")})));
        }
        body["id"] = json!(card);
        body.as_object_mut().unwrap().remove("card");
    }
    let mut story_note = String::new();
    let id = match upsert_mut(db, &mut body, Some(&mut story_note)) {
        Ok(id) => id,
        Err(e) if e.to_string() == "tags must be an array of non-empty tag keys" => {
            return Ok((400, json!({"error":e.to_string()})));
        }
        Err(e) => return Err(e),
    };
    let id = id.as_str().unwrap();
    if let Some(summary) = body["summary"].as_str().filter(|s| !s.trim().is_empty()) {
        if body["no_event"] != true {
            board::add_track_event(db, id, summary, &body)?;
        }
    }
    if let Some(links) = body["links"].as_array() {
        let existing = board::links(db, id)?;
        let mut have: HashSet<String> = existing
            .as_array()
            .unwrap()
            .iter()
            .map(|l| {
                format!(
                    "{}:{}:{}",
                    l["page_id"],
                    l["block_id"].as_str().unwrap_or(""),
                    l["anchor"].as_str().unwrap_or("")
                )
            })
            .collect();
        for link in links {
            let Some(page) = link["page_id"].as_str() else {
                continue;
            };
            let anchor = link["anchor"].as_str().unwrap_or("");
            let mut block = link["block_id"].clone();
            if !trame_core::truthy(&block) && !anchor.trim().is_empty() {
                let row = first(
                    db,
                    "select content from pages where id=$1 and not deleted",
                    &[json!(page)],
                )?;
                if let Ok(resolved) =
                    crate::comments::resolve_block(&row["content"], &json!({"block_text":anchor}))
                {
                    block = resolved["id"].clone();
                }
            }
            let key = format!(
                "{}:{}:{}",
                json!(page),
                block.as_str().unwrap_or(""),
                anchor
            );
            if have.insert(key) {
                board::add_link(db, id, &json!(page), &block, anchor)?;
            }
        }
    }
    let s = first(
        db,
        "select specs_page_id from sessions where id=$1",
        &[json!(id)],
    )?;
    let spec = if let Some(pid) = s["specs_page_id"].as_str() {
        first(
            db,
            "select 1 from pages where id=$1 and not deleted and content::text<>'[]'",
            &[json!(pid)],
        )?
    } else {
        Value::Null
    };
    let mut result = json!({"id":id,"specs_page_id":s["specs_page_id"]});
    if spec.is_null() {
        result["note"] = json!(format!(
            "card has no specs page. {} Write it with the page writer/trame_update_page using {{\"session_id\": \"{id}\"}}",
            SPECS_WHEN.replace('\n', " ")
        ));
    } else if let Some(note) = board::open_todos_note(db, id)? {
        result["note"] = json!(note);
    }
    if !story_note.is_empty() {
        result["story_note"] = json!(story_note);
    }
    Ok((200, result))
}
