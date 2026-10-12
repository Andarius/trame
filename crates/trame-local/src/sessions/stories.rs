use super::{first, origin, query_param};
use crate::{db::Db, pages};
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::collections::HashSet;

const STOPWORDS: &[&str] = &[
    "a", "an", "and", "au", "aux", "d", "de", "des", "du", "en", "et", "for", "in", "l", "la",
    "le", "les", "of", "on", "pour", "sur", "the", "to", "un", "une", "vers", "with",
];

fn words(title: &str) -> Vec<String> {
    let ids = regex::Regex::new(r"\b[A-Z]+-\d+\b").unwrap();
    let no_ids = ids.replace_all(title, " ");
    let folded = no_ids
        .chars()
        .flat_map(|c| match c {
            'à' | 'á' | 'â' | 'ä' | 'À' | 'Á' | 'Â' | 'Ä' => {
                "a".chars().collect::<Vec<_>>()
            }
            'é' | 'è' | 'ê' | 'ë' | 'É' | 'È' | 'Ê' | 'Ë' => "e".chars().collect(),
            'î' | 'ï' | 'í' | 'Î' | 'Ï' | 'Í' => "i".chars().collect(),
            'ô' | 'ö' | 'ó' | 'Ô' | 'Ö' | 'Ó' => "o".chars().collect(),
            'ù' | 'û' | 'ü' | 'ú' | 'Ù' | 'Û' | 'Ü' | 'Ú' => "u".chars().collect(),
            'ç' | 'Ç' => "c".chars().collect(),
            _ => c.to_lowercase().collect(),
        })
        .collect::<String>();
    folded
        .split(|c: char| !c.is_ascii_lowercase() && !c.is_ascii_digit())
        .filter(|w| !w.is_empty() && !STOPWORDS.contains(w))
        .map(str::to_owned)
        .collect()
}

fn trigrams(words: &[String]) -> HashSet<String> {
    let value = format!(" {} ", words.join(" "));
    value
        .as_bytes()
        .windows(3)
        .map(|w| String::from_utf8_lossy(w).into_owned())
        .collect()
}

pub fn similarity(a: &str, b: &str) -> f64 {
    let wa = words(a);
    let wb = words(b);
    let sa: HashSet<_> = wa.iter().collect();
    let sb: HashSet<_> = wb.iter().collect();
    let union = sa.union(&sb).count();
    let jaccard = if union == 0 {
        0.0
    } else {
        sa.intersection(&sb).count() as f64 / union as f64
    };
    let ta = trigrams(&wa);
    let tb = trigrams(&wb);
    let total = ta.len() + tb.len();
    let dice = if total == 0 {
        0.0
    } else {
        2.0 * ta.intersection(&tb).count() as f64 / total as f64
    };
    jaccard.max(dice)
}

pub fn similar(title: &str, stories: Vec<Value>, min: f64) -> Vec<Value> {
    let mut ranked: Vec<_> = stories
        .into_iter()
        .enumerate()
        .filter_map(|(i, mut row)| {
            let score =
                (similarity(title, row["title"].as_str().unwrap_or("")) * 100.0).round() / 100.0;
            if score < min {
                return None;
            }
            row["score"] = json!(score);
            Some((i, row))
        })
        .collect();
    ranked.sort_by(|a, b| {
        b.1["score"]
            .as_f64()
            .partial_cmp(&a.1["score"].as_f64())
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.cmp(&b.0))
    });
    ranked.into_iter().map(|(_, row)| row).collect()
}

fn clean(title: &str) -> String {
    title.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn find_story(db: &mut Db, title: &str, client: &Value) -> Result<Value> {
    let title = clean(title);
    if title.is_empty() {
        return Ok(Value::Null);
    }
    Ok(first(db,"select id from pages where (kind='story' or (kind='page' and parent_id is null)) and not deleted and lower(regexp_replace(trim(title),'\\s+',' ','g'))=lower($1) and ($2::uuid is null or client_id=$2 or client_id is null) order by (title=$1) desc,(kind='story') desc,(client_id is not distinct from $2::uuid) desc,updated_at desc limit 1",&[json!(title),client.clone()])?["id"].clone())
}

fn open_stories(db: &mut Db, client: &Value) -> Result<Vec<Value>> {
    db.query("select id,title from pages where kind='story' and status='open' and not deleted and ($1::uuid is null or client_id=$1)",&[client.clone()])
}

pub fn match_story(
    db: &mut Db,
    title: &str,
    client: &Value,
    note: Option<&mut String>,
) -> Result<Value> {
    let exact = find_story(db, title, client)?;
    if !exact.is_null() {
        return Ok(exact);
    }
    let best = similar(title, open_stories(db, client)?, 0.8)
        .into_iter()
        .next();
    if let Some(best) = best {
        if let Some(note) = note {
            *note = format!(
                "matched existing story '{}' ({})",
                best["title"].as_str().unwrap_or(""),
                best["score"]
            );
        }
        Ok(best["id"].clone())
    } else {
        Ok(Value::Null)
    }
}

pub fn resolve_story(
    db: &mut Db,
    title: &str,
    client: &Value,
    tags: &[String],
    mut note: Option<&mut String>,
) -> Result<Value> {
    let title = clean(title);
    if title.is_empty() {
        bail!("a story needs a title");
    }
    let hit = match_story(db, &title, client, note.as_deref_mut())?;
    if !hit.is_null() {
        return Ok(hit);
    }
    let near = similar(&title, open_stories(db, client)?, 0.5)
        .into_iter()
        .take(3)
        .collect::<Vec<_>>();
    if let Some(note) = note.as_deref_mut() {
        if !near.is_empty() {
            *note = format!(
                "similar open stories: {}; re-track with one of them if it is the same topic",
                near.iter()
                    .map(|n| format!("'{}' ({})", n["title"].as_str().unwrap_or(""), n["score"]))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }
        let nested = first(
            db,
            "select id from pages where kind='page' and parent_id is not null and not deleted and lower(regexp_replace(trim(title),'\\s+',' ','g'))=lower($1) limit 1",
            &[json!(title)],
        )?;
        if !nested.is_null() {
            if !note.is_empty() {
                note.push_str("; ");
            }
            note.push_str(&format!("a page named '{}' exists ({}) and was left as is; use \"Convert to user story\" on it (or `tramecli convert --story {}`) if it should be this story",title,nested["id"],nested["id"]));
        }
    }
    if !client.is_null() && !pages::story_above(db, client)?.is_null() {
        bail!(
            "A user story cannot be nested under another user story. Create a ticket/session or a documentation page instead."
        );
    }
    let mut keys = Vec::new();
    for label in tags {
        keys.push(
            super::write::ensure_tag(db, label, None)?["key"]
                .as_str()
                .unwrap_or("")
                .to_owned(),
        );
    }
    let from = origin(db);
    Ok(first(db,"insert into pages(kind,title,client_id,parent_id,tags,origin,owner_id) values('story',$1,$2,$2,$3,$4,(select user_id from devices where node_id=$4 and not deleted limit 1)) returning id",&[json!(title),client.clone(),json!(serde_json::to_string(&keys)?),from])?["id"].clone())
}

pub fn find_similar_stories(db: &mut Db, query: &str) -> Result<Value> {
    let q = query_param(query, "q").unwrap_or_default();
    let client = if let Some(name) = query_param(query, "client").filter(|s| !s.is_empty()) {
        first(
            db,
            "select id from pages where kind='project' and title=$1 and not deleted limit 1",
            &[json!(name)],
        )?["id"]
            .clone()
    } else if let Some(path) = query_param(query, "repo_path").filter(|s| !s.is_empty()) {
        pages::resolve_home_project(db, &path)?
    } else {
        Value::Null
    };
    let mut hits = similar(&q, open_stories(db, &client)?, 0.5);
    hits.truncate(5);
    let ids = hits.iter().map(|h| h["id"].clone()).collect::<Vec<_>>();
    let counts=db.query("select page_id,count(*)::int as n from sessions where not deleted and page_id=any($1::uuid[]) and status not in (select key from statuses where terminal and not deleted) group by page_id",&[json!(ids)])?;
    for hit in &mut hits {
        hit["open_cards"] = counts
            .iter()
            .find(|r| r["page_id"] == hit["id"])
            .map(|r| r["n"].clone())
            .unwrap_or(json!(0));
    }
    Ok(json!(hits))
}

pub fn create_story(db: &mut Db, body: &Value) -> Result<Value> {
    let client = if let Some(name) = body["client"].as_str().filter(|s| !s.is_empty()) {
        pages::resolve_client(db, name)?
    } else {
        Value::Null
    };
    if !client.is_null() && !pages::story_above(db, &client)?.is_null() {
        bail!(
            "A user story cannot be nested under another user story. Create a ticket/session or a documentation page instead."
        );
    }
    let from = origin(db);
    Ok(first(db,"insert into pages(kind,title,brief,client_id,parent_id,origin,owner_id) values('story',$1,$2,$3,$3,$4,(select user_id from devices where node_id=$4 and not deleted limit 1)) returning id",&[body["title"].clone(),json!(body["brief"].as_str().unwrap_or("")),client,from])?["id"].clone())
}
