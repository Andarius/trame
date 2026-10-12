use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::Value;

use crate::{
    page_markdown::is_folder_block,
    todo_marks::{carry_marks, strip_marks},
    trim,
};

fn text_like(block: &Value) -> bool {
    matches!(
        block.get("type").and_then(Value::as_str),
        Some("text" | "heading" | "todo")
    )
}

pub fn merge_page_blocks(existing: &[Value], next: &[Value]) -> Vec<Value> {
    let mut pool: HashMap<String, VecDeque<(&str, &str)>> = HashMap::new();
    for b in existing.iter().filter(|b| text_like(b)) {
        if let (Some(text), Some(id)) = (
            b.get("text").and_then(Value::as_str),
            b.get("id").and_then(Value::as_str),
        ) {
            pool.entry(trim(&strip_marks(text)).to_owned())
                .or_default()
                .push_back((id, text));
        }
    }
    let rewrites_folders = next.iter().any(is_folder_block);
    let folders = existing
        .iter()
        .filter(|b| is_folder_block(b) && b.get("id").is_some_and(Value::is_string))
        .collect::<Vec<_>>();
    let mut claimed = HashSet::new();
    let merged = next
        .iter()
        .map(|b| {
            let mut out = b.clone();
            if is_folder_block(b) {
                let free = |f: &&&Value| !claimed.contains(f["id"].as_str().unwrap());
                let hit = folders
                    .iter()
                    .find(|f| free(f) && f.get("path") == b.get("path"))
                    .or_else(|| folders.iter().find(free));
                if let Some(hit) = hit {
                    let id = hit["id"].as_str().unwrap();
                    claimed.insert(id);
                    if !id.is_empty() {
                        out["id"] = Value::String(id.to_owned());
                    }
                }
            } else if let Some(text) = b.get("text").and_then(Value::as_str) {
                if let Some((id, old)) = pool
                    .get_mut(trim(&strip_marks(text)))
                    .and_then(VecDeque::pop_front)
                {
                    out["id"] = Value::String(id.to_owned());
                    out["text"] = Value::String(carry_marks(old, text));
                }
            }
            out
        })
        .collect::<Vec<_>>();
    let survived = merged
        .iter()
        .filter_map(|b| b.get("id").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    let mut groups: HashMap<Option<&str>, Vec<Value>> = HashMap::new();
    let mut anchor = None;
    for b in existing {
        if text_like(b) {
            if let Some(id) = b
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| survived.contains(id))
            {
                anchor = Some(id);
            }
            continue;
        }
        if rewrites_folders && is_folder_block(b) {
            continue;
        }
        groups.entry(anchor).or_default().push(b.clone());
    }
    let mut out = groups.get(&None).cloned().unwrap_or_default();
    for b in &merged {
        out.push(b.clone());
        if let Some(id) = b.get("id").and_then(Value::as_str) {
            if let Some(group) = groups.get(&Some(id)) {
                out.extend(group.iter().cloned());
            }
        }
    }
    out
}
