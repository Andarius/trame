use crate::{db::Db, sessions, settings};
use anyhow::{Context, Result};
use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub mod transcript;

fn transcript_dir(db: &Db, key: &str, fallback: &str) -> Result<PathBuf> {
    let scratch = crate::isolated_mode() || crate::scratch_path(db.settings_path()?).is_ok();
    // the demo never lists the user's real transcripts
    let demo = crate::demo::active();
    let default = if scratch || demo {
        db.settings_path()?
            .parent()
            .context("settings parent missing")?
            .join(fallback)
    } else {
        let home = PathBuf::from(std::env::var_os("HOME").context("HOME unavailable")?);
        home.join(if key == "TRACKER_CLAUDE_DIR" {
            ".claude/projects"
        } else {
            ".codex/sessions"
        })
    };
    let path = if demo {
        default
    } else {
        std::env::var_os(key).map(PathBuf::from).unwrap_or(default)
    };
    if scratch {
        crate::scratch_path(&path)?;
    }
    Ok(path)
}
fn valid_uuid(id: &str) -> bool {
    id.len() == 36 && uuid::Uuid::parse_str(id).is_ok()
}
#[allow(
    clippy::cast_possible_truncation,
    reason = "values fit by construction (timestamps, ids, pids, JS-number parity)"
)]
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
#[allow(
    clippy::cast_possible_truncation,
    reason = "values fit by construction (timestamps, ids, pids, JS-number parity)"
)]
fn modified_ms(path: &Path) -> Result<i64> {
    Ok(fs::metadata(path)?
        .modified()?
        .duration_since(UNIX_EPOCH)?
        .as_millis() as i64)
}
fn timestamp_ms(value: &Value, fallback: i64) -> i64 {
    value
        .as_str()
        .and_then(|s| {
            DateTime::parse_from_rfc3339(s)
                .or_else(|_| DateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f%z"))
                .ok()
                .map(|v| v.timestamp_millis())
                .or_else(|| {
                    NaiveDate::parse_from_str(s, "%Y-%m-%d")
                        .ok()?
                        .and_hms_opt(0, 0, 0)
                        .map(|v| v.and_utc().timestamp_millis())
                })
                .or_else(|| {
                    [
                        "%Y-%m-%dT%H:%M:%S%.f",
                        "%Y-%m-%dT%H:%M",
                        "%Y-%m-%d %H:%M:%S%.f",
                    ]
                    .iter()
                    .find_map(|format| NaiveDateTime::parse_from_str(s, format).ok())
                    .and_then(|v| Local.from_local_datetime(&v).earliest())
                    .map(|v| v.timestamp_millis())
                })
        })
        .unwrap_or(fallback)
}
fn iso(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn cut(text: &str, n: usize) -> String {
    if text.encode_utf16().count() <= n {
        return text.to_owned();
    }
    let mut out = String::new();
    let mut units = 0;
    for ch in text.chars() {
        if units + ch.len_utf16() >= n {
            break;
        }
        out.push(ch);
        units += ch.len_utf16();
    }
    out.push('…');
    out
}
fn repo_name(path: &str) -> &str {
    path.split('/')
        .rfind(|s| !s.is_empty())
        .unwrap_or("unknown")
}
fn client_for(path: &str) -> String {
    let map = std::env::var("TRACKER_CLIENTS")
        .ok()
        .and_then(|v| serde_json::from_str::<Value>(&v).ok())
        .unwrap_or(Value::Null);
    sessions::client_for(path, &map)
}
fn ignored(db: &Db) -> Result<HashSet<String>> {
    Ok(settings::read(db.settings_path()?)["sessionIgnored"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default())
}
fn make_item(
    source: &str,
    id: &str,
    cwd: &str,
    branch: &Value,
    topic: Option<&str>,
    last: i64,
    ignored: &HashSet<String>,
    now: i64,
) -> Value {
    json!({"source":source,"claudeId":id,"title":format!("{} — {}",repo_name(cwd),topic.map(|s|cut(s,80)).unwrap_or_else(||"untitled session".into())),"repoPath":cwd,"branch":branch,"lastActive":iso(last),"suggestedStatus":if last>now-48*3_600_000{"active"}else{"paused"},"suggestedClient":client_for(cwd),"suggestedProject":repo_name(cwd),"alreadyImported":false,"ignored":ignored.contains(&format!("{source}:{id}"))})
}
fn codex_files(dir: &Path, depth: u8, out: &mut Vec<PathBuf>) {
    if depth > 4 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            codex_files(&path, depth + 1, out);
        } else if path.extension().is_some_and(|e| e == "jsonl") {
            out.push(path);
        }
    }
}
pub fn transcript_is_local(db: &Db, source: &str, id: &str) -> Result<bool> {
    if !valid_uuid(id) {
        return Ok(false);
    }
    if source == "codex" {
        let dir = transcript_dir(db, "TRACKER_CODEX_DIR", "codex-sessions")?;
        let mut files = Vec::new();
        codex_files(&dir, 0, &mut files);
        return Ok(files.iter().any(|path| {
            path.file_name()
                .and_then(|v| v.to_str())
                .is_some_and(|name| name.ends_with(&format!("{id}.jsonl")))
        }));
    }
    if source == "claude" {
        let dir = transcript_dir(db, "TRACKER_CLAUDE_DIR", "claude-projects")?;
        let Ok(projects) = fs::read_dir(dir) else {
            return Ok(false);
        };
        return Ok(projects.flatten().any(|project| {
            project.path().is_dir() && project.path().join(format!("{id}.jsonl")).is_file()
        }));
    }
    Ok(false)
}
#[allow(
    clippy::cast_possible_truncation,
    reason = "values fit by construction (timestamps, ids, pids, JS-number parity)"
)]
fn scan(db: &mut Db, days: f64) -> Result<Value> {
    let claude_dir = transcript_dir(db, "TRACKER_CLAUDE_DIR", "claude-projects")?;
    let codex_dir = transcript_dir(db, "TRACKER_CODEX_DIR", "codex-sessions")?;
    let now = now_ms();
    let cutoff = now - (days * 86_400_000.0) as i64;
    let ignored = ignored(db)?;
    let mut found = Vec::new();
    let mut files = Vec::new();
    codex_files(&codex_dir, 0, &mut files);
    for path in files {
        let Ok(mtime) = modified_ms(&path) else {
            continue;
        };
        if mtime < cutoff {
            continue;
        }
        let Some(filename) = path.file_stem().and_then(|n| n.to_str()) else {
            continue;
        };
        let fallback = filename
            .get(filename.len().saturating_sub(36)..)
            .filter(|s| valid_uuid(s));
        let Ok((head, tail)) = transcript::read_chunks(&path) else {
            continue;
        };
        let meta = transcript::codex_meta(&head, &tail);
        let id = meta["id"].as_str().or(fallback);
        let Some(id) = id.filter(|id| valid_uuid(id)) else {
            continue;
        };
        let Some(cwd) = meta["cwd"].as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        if meta["subagent"] == true || meta["hasActivity"] != true {
            continue;
        }
        let last = timestamp_ms(&meta["lastTs"], mtime);
        if last < cutoff {
            continue;
        }
        found.push(make_item(
            "codex",
            id,
            cwd,
            &meta["branch"],
            meta["firstPrompt"].as_str(),
            last,
            &ignored,
            now,
        ));
    }
    if let Ok(projects) = fs::read_dir(&claude_dir) {
        for project in projects.flatten() {
            let name = project.file_name().to_string_lossy().into_owned();
            if !project.path().is_dir() || name.starts_with("-tmp-") {
                continue;
            }
            let Ok(entries) = fs::read_dir(project.path()) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() || path.extension().is_none_or(|e| e != "jsonl") {
                    continue;
                }
                let Some(id) = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .filter(|s| valid_uuid(s))
                else {
                    continue;
                };
                let Ok(mtime) = modified_ms(&path) else {
                    continue;
                };
                if mtime < cutoff {
                    continue;
                }
                let Ok((head, tail)) = transcript::read_chunks(&path) else {
                    continue;
                };
                let meta = transcript::claude_meta(&head, &tail);
                if meta["hasActivity"] != true {
                    continue;
                }
                let last = timestamp_ms(&meta["lastTs"], mtime);
                if last < cutoff {
                    continue;
                }
                let cwd = meta["cwd"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| name.replace('-', "/"));
                let topic = meta["aiTitle"]
                    .as_str()
                    .or_else(|| meta["firstPrompt"].as_str())
                    .or_else(|| meta["lastPrompt"].as_str());
                found.push(make_item(
                    "claude",
                    id,
                    &cwd,
                    &meta["branch"],
                    topic,
                    last,
                    &ignored,
                    now,
                ));
            }
        }
    }
    if !found.is_empty() {
        let ids: Vec<Value> = found.iter().map(|s| s["claudeId"].clone()).collect();
        let existing=db.query("select id, claude_id from sessions where id = any($1::uuid[]) or claude_id = any($1::uuid[])",&[json!(ids)])?;
        let existing: HashSet<String> = existing
            .iter()
            .flat_map(|s| {
                [
                    s["id"].as_str(),
                    s["claude_id"].as_str().or(s["id"].as_str()),
                ]
            })
            .flatten()
            .map(str::to_owned)
            .collect();
        for item in &mut found {
            item["alreadyImported"] =
                json!(existing.contains(item["claudeId"].as_str().unwrap_or("")));
        }
    }
    let mut groups: HashMap<String, Vec<Value>> = HashMap::new();
    let mut group_order = Vec::new();
    for item in found.iter().cloned() {
        let path = item["repoPath"].as_str().unwrap_or("").to_owned();
        if !groups.contains_key(&path) {
            group_order.push(path.clone());
        }
        groups.entry(path).or_default().push(item);
    }
    let mut groups: Vec<Value> = group_order
        .into_iter()
        .map(|path| {
            let mut sessions = groups.remove(&path).unwrap_or_default();
            sessions.sort_by(|a, b| b["lastActive"].as_str().cmp(&a["lastActive"].as_str()));
            json!({"repoPath":path,"repoName":repo_name(&path),"suggestedClient":client_for(&path),"sessions":sessions})
        })
        .collect();
    groups.sort_by(|a, b| {
        b["sessions"][0]["lastActive"]
            .as_str()
            .cmp(&a["sessions"][0]["lastActive"].as_str())
    });
    Ok(
        json!({"groups":groups,"total":found.len(),"dir":format!("{} + {}",claude_dir.display(),codex_dir.display()),"node":db.origin}),
    )
}
fn set_ignored(db: &mut Db, body: &Value) -> Result<Value> {
    let source = if body["source"] == "codex" {
        "codex"
    } else {
        "claude"
    };
    let id = trame_core::js_string(&body["claudeId"]);
    let value = trame_core::truthy(&body["ignored"]);
    let key = format!("{source}:{id}");
    settings::update(db.settings_path()?, |settings| {
        let mut ids: Vec<String> = settings["sessionIgnored"]
            .as_array()
            .map(|v| v.iter().map(trame_core::js_string).collect())
            .unwrap_or_default();
        ids.retain(|s| s != &key);
        if value {
            ids.push(key);
        }
        settings["sessionIgnored"] = json!(ids);
        Ok(())
    })?;
    Ok(json!({"ignored":value}))
}
fn import(db: &mut Db, body: &Value) -> Result<Value> {
    let items = body["items"].as_array().cloned().unwrap_or_default();
    let (mut imported, mut skipped, mut ids) = (0, 0, Vec::new());
    for item in items {
        let Some(id) = item["claudeId"].as_str().filter(|s| valid_uuid(s)) else {
            skipped += 1;
            continue;
        };
        if !trame_core::truthy(&item["title"]) {
            skipped += 1;
            continue;
        }
        if !db
            .query(
                "select 1 from sessions where id=$1 or claude_id=$1",
                &[json!(id)],
            )?
            .is_empty()
        {
            skipped += 1;
            continue;
        }
        let source = item["source"].as_str().unwrap_or("claude");
        let mut card = json!({"id":id,"title":item["title"],"status":if item["status"]=="paused"{"paused"}else{"active"},"repo_path":item["repoPath"],"branch":item["branch"],"agent":source,"agent_id":id});
        if let Some(client) = item["client"].as_str().filter(|s| !s.is_empty()) {
            card["client"] = json!(client);
        }
        if let Some(project) = item["project"].as_str().filter(|s| !s.is_empty()) {
            card["page"] = json!(project);
        }
        sessions::upsert(db, &card, None)?;
        let label = if source == "codex" {
            "Codex"
        } else {
            "Claude Code"
        };
        sessions::add_event(
            db,
            id,
            &format!("Imported from {label} · {}", db.origin),
            "import",
            &json!({"agent":source}),
        )?;
        db.query(
            "update sessions set last_touched=$2 where id=$1",
            &[json!(id), item["lastActive"].clone()],
        )?;
        imported += 1;
        ids.push(id.to_owned());
    }
    Ok(json!({"imported":imported,"skipped":skipped,"ids":ids}))
}

pub fn owns(_method: &str, path: &str) -> bool {
    matches!(path, "/api/import/claude" | "/api/import/claude/ignore")
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
    Some((|| {
        let result = match (method, path) {
            ("POST", "/api/import/claude/ignore") => set_ignored(db, body)?,
            ("POST", "/api/import/claude") => import(db, body)?,
            (_, "/api/import/claude") => {
                let params = reqwest::Url::parse(&format!("http://localhost/?{query}"))?;
                let days = params
                    .query_pairs()
                    .find(|(k, _)| k == "days")
                    .and_then(|(_, v)| v.parse::<f64>().ok())
                    .filter(|n| n.is_finite() && *n != 0.0)
                    .unwrap_or(7.0)
                    .clamp(1.0, 90.0);
                scan(db, days)?
            }
            _ => return Ok((404, json!({"error":"not found"}))),
        };
        Ok((200, result))
    })())
}
