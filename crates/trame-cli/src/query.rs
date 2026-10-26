use chrono::{Duration, Utc};
use regex::Regex;
use serde_json::Value;
use std::{collections::HashMap, sync::LazyLock};

static TERMS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)(-?)(?:([a-z]+):)?(?:"([^"]*)"?|(\S+))"#).unwrap());
const KEYS: [&str; 14] = [
    "status", "tag", "project", "story", "branch", "repo", "agent", "title", "summary", "next",
    "assigner", "touched", "has", "no",
];
#[derive(Clone)]
pub struct Term {
    pub neg: bool,
    pub key: Option<String>,
    pub values: Vec<String>,
}
pub struct Parsed {
    pub terms: Vec<Term>,
    pub errors: Vec<String>,
}
pub fn parse(query: &str) -> Parsed {
    let mut terms = Vec::new();
    let mut errors = Vec::new();
    for capture in TERMS.captures_iter(query) {
        let key = capture.get(2).map(|m| m.as_str().to_lowercase());
        let raw = capture
            .get(3)
            .or_else(|| capture.get(4))
            .map(|m| m.as_str())
            .unwrap_or("");
        // `status:` with no value yet is a key being typed, not a word to search
        if key.is_none()
            && raw
                .strip_suffix(':')
                .is_some_and(|k| KEYS.contains(&k.to_lowercase().as_str()))
        {
            continue;
        }
        if let Some(key) = &key {
            if !KEYS.contains(&key.as_str()) {
                errors.push(format!("unknown key \"{key}\""));
            }
        }
        let values = if key.is_some() {
            raw.split(',').collect::<Vec<_>>()
        } else {
            vec![raw]
        };
        let values = values
            .into_iter()
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .collect();
        if !Vec::<String>::is_empty(&values) {
            terms.push(Term {
                neg: capture.get(1).is_some_and(|m| m.as_str() == "-"),
                key,
                values,
            });
        }
    }
    Parsed { terms, errors }
}
/// Whether `assigner:`, `has:assigner` or `no:assigner` needs the plugin-provided assigners.
pub fn needs_assigners(terms: &[Term]) -> bool {
    terms.iter().any(|t| match t.key.as_deref() {
        Some("assigner") => true,
        Some("has" | "no") => t.values.iter().any(|v| v == "assigner"),
        _ => false,
    })
}
fn string(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or("").to_lowercase()
}
fn pages_by_id(board: &Value) -> HashMap<String, Value> {
    board["pages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| Some((p["id"].as_str()?.to_owned(), p.clone())))
        .collect()
}
fn ancestors<'a>(session: &Value, pages: &'a HashMap<String, Value>) -> Vec<&'a Value> {
    let mut out = Vec::new();
    let mut id = session["page_id"].as_str();
    for _ in 0..20 {
        let Some(page) = id.and_then(|id| pages.get(id)) else {
            break;
        };
        out.push(page);
        id = page["parent_id"].as_str();
    }
    out
}
/// Names of every project enclosing the card, innermost first; its `client_id` when it sits outside the tree.
pub fn project_names(session: &Value, board: &Value) -> Vec<String> {
    let pages = pages_by_id(board);
    let chain = ancestors(session, &pages);
    let mut ids = chain
        .iter()
        .filter(|p| p["kind"] == "project")
        .filter_map(|p| p["id"].as_str())
        .collect::<Vec<_>>();
    if ids.is_empty() {
        ids.extend(session["client_id"].as_str().filter(|s| !s.is_empty()));
    }
    ids.iter()
        .filter_map(|id| {
            board["projects"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|p| p["id"] == *id)
                .and_then(|p| p["name"].as_str())
                .or_else(|| pages.get(*id).and_then(|p| p["title"].as_str()))
                .map(str::to_owned)
        })
        .collect()
}
fn fields(session: &Value, board: &Value, assigners: &Value, key: Option<&str>) -> Vec<String> {
    let assigner = session["id"]
        .as_str()
        .map(|id| string(&assigners[id], "name"))
        .unwrap_or_default();
    let pages = pages_by_id(board);
    let chain = ancestors(session, &pages);
    let story = chain.iter().find(|p| p["kind"] == "story").copied();
    // every enclosing project, so a parent matches its whole subtree
    let mut projects = chain
        .iter()
        .filter(|p| p["kind"] == "project")
        .filter_map(|p| p["id"].as_str())
        .collect::<Vec<_>>();
    if projects.is_empty() {
        projects.extend(session["client_id"].as_str().filter(|s| !s.is_empty()));
    }
    let mut tags = session["tags"].as_array().cloned().unwrap_or_default();
    if let Some(page) = story.or_else(|| chain.first().copied()) {
        tags.extend(page["tags"].as_array().cloned().unwrap_or_default());
    }
    let tags = tags
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_lowercase)
        .collect::<Vec<_>>();
    let values = match key {
        None => ["title", "summary", "next_step", "branch"]
            .iter()
            .map(|k| string(session, k))
            .collect(),
        Some("status") => {
            let label = board["statuses"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|s| s["key"] == session["status"])
                .map(|s| string(s, "label"))
                .unwrap_or_default();
            vec![string(session, "status"), label]
        }
        Some("tag") => tags.clone(),
        Some("project") => project_names(session, board)
            .iter()
            .map(|name| name.to_lowercase())
            .collect(),
        Some("story") => chain
            .iter()
            .filter(|p| p["kind"] == "story")
            .map(|p| string(p, "title"))
            .collect(),
        Some("branch") => vec![string(session, "branch")],
        Some("repo") => vec![string(session, "repo_path")],
        Some("agent") => vec![string(session, "agent")],
        Some("title") => vec![string(session, "title")],
        Some("summary") => vec![string(session, "summary")],
        Some("next") => vec![string(session, "next_step")],
        Some("assigner") => vec![assigner],
        Some("touched") => vec![session["last_touched"].as_str().unwrap_or("").into()],
        Some("has") => {
            let mut out = Vec::new();
            for (field, name) in [
                ("pr_url", "pr"),
                ("branch", "branch"),
                ("next_step", "next"),
                ("claude_id", "transcript"),
            ] {
                if session[field].as_str().is_some_and(|s| !s.is_empty()) {
                    out.push(name.into());
                }
            }
            if session["specs_page_id"]
                .as_str()
                .is_some_and(|id| pages.contains_key(id))
            {
                out.push("specs".into());
            }
            if story.is_some() {
                out.push("story".into());
            }
            if !projects.is_empty() {
                out.push("project".into());
            }
            if !tags.is_empty() {
                out.push("tags".into());
            }
            if !assigner.is_empty() {
                out.push("assigner".into());
            }
            out
        }
        _ => vec![],
    };
    values.into_iter().filter(|s| !s.is_empty()).collect()
}
fn match_value(key: Option<&str>, field: &str, value: &str) -> bool {
    if value.starts_with('>') || value.starts_with('<') {
        let direction = value.chars().next().unwrap();
        let inclusive = value.as_bytes().get(1) == Some(&b'=');
        let raw = value.trim_start_matches(&['<', '>', '='][..]);
        let relative = raw
            .chars()
            .last()
            .filter(|c| matches!(c, 'h' | 'd' | 'w'))
            .and_then(|unit| {
                raw[..raw.len() - 1]
                    .parse::<i64>()
                    .ok()
                    .filter(|_| {
                        !raw[..raw.len() - 1].is_empty()
                            && raw[..raw.len() - 1].bytes().all(|b| b.is_ascii_digit())
                    })
                    .map(|n| (n, unit))
            });
        let bound = if let Some((n, unit)) = relative {
            let hours = n * match unit {
                'h' => 1,
                'd' => 24,
                _ => 168,
            };
            (Utc::now() - Duration::hours(hours))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        } else {
            raw.to_owned()
        };
        return (inclusive && field.starts_with(&bound))
            || if direction == '>' {
                field > bound.as_str()
            } else {
                field < bound.as_str()
            };
    }
    if value.contains('*') {
        let pattern = format!("^{}$", regex::escape(value).replace(r"\*", ".*"));
        return Regex::new(&pattern).is_ok_and(|r| r.is_match(field));
    }
    if key.is_some_and(|k| matches!(k, "status" | "tag" | "agent" | "has" | "no")) {
        field == value
    } else {
        field.contains(value)
    }
}
/// `assigners` maps session id → `{name}` (a plugin's card faces); `Value::Null` when unused.
pub fn matches(session: &Value, board: &Value, assigners: &Value, terms: &[Term]) -> bool {
    terms.iter().all(|term| {
        let key = if term.key.as_deref() == Some("no") {
            Some("has")
        } else {
            term.key.as_deref()
        };
        let flip = if term.key.as_deref() == Some("no") {
            !term.neg
        } else {
            term.neg
        };
        let values = fields(session, board, assigners, key);
        let hit = term
            .values
            .iter()
            .any(|value| values.iter().any(|field| match_value(key, field, value)));
        hit != flip
    })
}
