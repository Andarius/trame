use serde_json::{Map, Value, json};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

use super::transcript::harness_note;

/// Bytes read per page when paging back; doubled while one line is longer.
const PAGE: u64 = 1 << 20;
const TEXT_CAP: usize = 64 << 10;
const RESULT_CAP: usize = 8 << 10;
const INPUT_CAP: usize = 16 << 10;

/// A window of a transcript's history: `items` read from whole lines in `[start, end)`.
pub struct Page {
    pub items: Vec<Value>,
    pub start: u64,
    pub end: u64,
}

impl Page {
    pub fn to_json(&self) -> Value {
        json!({"items": self.items, "start": self.start, "end": self.end, "more": self.start > 0})
    }
}

/// The page ending at byte `before` (or the end of the file), reaching back about one page of whole lines.
pub fn before(path: &Path, before: Option<u64>, codex: bool) -> std::io::Result<Page> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    // a partial last line is still being written: stop at the last newline
    let end = match before {
        Some(at) => at.min(size),
        None => last_newline(&mut file, size)?,
    };
    let mut want = PAGE;
    loop {
        let start = end.saturating_sub(want);
        let bytes = read_range(&mut file, start, end)?;
        // the window starts mid-line: drop that fragment, unless it is all there is
        let skip = if start == 0 {
            0
        } else {
            match bytes.iter().position(|&b| b == b'\n') {
                Some(i) if i + 1 < bytes.len() => i + 1,
                _ => {
                    want *= 2;
                    continue;
                }
            }
        };
        let start = start + skip as u64;
        return Ok(Page {
            items: items(&bytes[skip..], codex),
            start,
            end,
        });
    }
}

/// Every whole line appended since byte `after`, for following a live session.
pub fn after(path: &Path, after: u64, codex: bool) -> std::io::Result<Page> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let after = after.min(size);
    let end = last_newline(&mut file, size)?.max(after);
    let bytes = read_range(&mut file, after, end)?;
    Ok(Page {
        items: items(&bytes, codex),
        start: after,
        end,
    })
}

fn read_range(file: &mut File, start: u64, end: u64) -> std::io::Result<Vec<u8>> {
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(end - start).read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// The offset just past the file's last newline.
fn last_newline(file: &mut File, size: u64) -> std::io::Result<u64> {
    let mut end = size;
    while end > 0 {
        let start = end.saturating_sub(64 << 10);
        let bytes = read_range(file, start, end)?;
        if let Some(i) = bytes.iter().rposition(|&b| b == b'\n') {
            return Ok(start + i as u64 + 1);
        }
        end = start;
    }
    Ok(0)
}

fn items(bytes: &[u8], codex: bool) -> Vec<Value> {
    String::from_utf8_lossy(bytes)
        .split('\n')
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .flat_map(|event| {
            if codex {
                codex_items(&event)
            } else {
                claude_items(&event)
            }
        })
        .collect()
}

fn cap(text: &str, max: usize) -> (String, bool) {
    if text.len() <= max {
        return (text.to_owned(), false);
    }
    let mut cut = max;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    (text[..cut].to_owned(), true)
}

fn item(kind: &str, event: &Value, fields: Value) -> Value {
    let mut out = Map::new();
    out.insert("kind".into(), kind.into());
    if let Some(ts) = event["timestamp"].as_str() {
        out.insert("ts".into(), ts.into());
    }
    if let Value::Object(fields) = fields {
        out.extend(fields);
    }
    Value::Object(out)
}

fn text_item(kind: &str, event: &Value, text: &str) -> Option<Value> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let (text, cut) = cap(text, TEXT_CAP);
    Some(item(kind, event, json!({"text": text, "truncated": cut})))
}

/// A user turn: injected context and command echoes are dropped, harness messages become notes.
fn user_item(event: &Value, text: &str) -> Option<Value> {
    let trimmed = text.trim_start();
    if trimmed.starts_with('<') || trimmed.starts_with("Caveat:") {
        return None;
    }
    if trimmed.starts_with("[Request interrupted") {
        return Some(item("note", event, json!({"text": "interrupted"})));
    }
    match harness_note(text) {
        Some(note) => Some(item("note", event, json!({"text": note}))),
        None => text_item("user", event, text),
    }
}

/// Tool input with long strings cut, so a big `Write` does not ship megabytes.
fn capped_input(input: &Value) -> Value {
    match input {
        Value::String(s) => {
            let (s, _) = cap(s, INPUT_CAP);
            Value::String(s)
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), capped_input(v)))
                .collect(),
        ),
        Value::Array(list) => Value::Array(list.iter().map(capped_input).collect()),
        other => other.clone(),
    }
}

fn result_item(event: &Value, id: &str, output: &str, error: bool) -> Value {
    let (text, cut) = cap(output, RESULT_CAP);
    item(
        "result",
        event,
        json!({"toolId": id, "text": text, "error": error, "truncated": cut}),
    )
}

/// Text parts of a content value that is either a string or a list of typed blocks.
fn content_text(content: &Value, kinds: &[&str]) -> String {
    if let Some(s) = content.as_str() {
        return s.to_owned();
    }
    content
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter(|p| p["type"].as_str().is_some_and(|t| kinds.contains(&t)))
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

pub(crate) fn claude_items(event: &Value) -> Vec<Value> {
    // subagent turns are folded into their Agent tool call
    if event["isSidechain"] == true || event["isMeta"] == true {
        return Vec::new();
    }
    let content = &event["message"]["content"];
    match event["type"].as_str() {
        Some("user") => {
            if let Some(text) = content.as_str() {
                return user_item(event, text).into_iter().collect();
            }
            let Some(parts) = content.as_array() else {
                return Vec::new();
            };
            parts
                .iter()
                .filter_map(|p| match p["type"].as_str() {
                    Some("text") => p["text"].as_str().and_then(|t| user_item(event, t)),
                    Some("tool_result") => Some(result_item(
                        event,
                        p["tool_use_id"].as_str().unwrap_or_default(),
                        &content_text(&p["content"], &["text"]),
                        p["is_error"] == true,
                    )),
                    _ => None,
                })
                .collect()
        }
        Some("assistant") => content
            .as_array()
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|p| match p["type"].as_str() {
                        Some("text") => text_item("assistant", event, p["text"].as_str()?),
                        Some("thinking") => text_item("thinking", event, p["thinking"].as_str()?),
                        Some("tool_use") => Some(item(
                            "tool",
                            event,
                            json!({"id": p["id"], "name": p["name"], "input": capped_input(&p["input"])}),
                        )),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn codex_items(event: &Value) -> Vec<Value> {
    if event["type"] != "response_item" {
        return Vec::new();
    }
    let p = &event["payload"];
    let one = |v: Option<Value>| v.into_iter().collect();
    match (p["type"].as_str(), p["role"].as_str()) {
        (Some("message"), Some("user")) => {
            let text = content_text(&p["content"], &["input_text"]);
            // AGENTS.md and environment context arrive as user messages
            if text.trim_start().starts_with('#') {
                return Vec::new();
            }
            one(user_item(event, &text))
        }
        (Some("message"), Some("assistant")) => one(text_item(
            "assistant",
            event,
            &content_text(&p["content"], &["output_text"]),
        )),
        (Some("reasoning"), _) => one(text_item(
            "thinking",
            event,
            &content_text(&p["summary"], &["summary_text"]),
        )),
        (Some("function_call"), _) => {
            let args = p["arguments"].as_str().unwrap_or_default();
            let input = serde_json::from_str(args).unwrap_or_else(|_| json!({"input": args}));
            one(Some(item(
                "tool",
                event,
                json!({"id": p["call_id"], "name": p["name"], "input": capped_input(&input)}),
            )))
        }
        (Some("custom_tool_call"), _) => one(Some(item(
            "tool",
            event,
            json!({"id": p["call_id"], "name": p["name"], "input": capped_input(&json!({"input": p["input"]}))}),
        ))),
        (Some("function_call_output" | "custom_tool_call_output"), _) => {
            let output = &p["output"];
            let text = match output.as_str() {
                // structured outputs are a JSON list of text blocks
                Some(s) => serde_json::from_str::<Value>(s)
                    .ok()
                    .filter(Value::is_array)
                    .map_or_else(
                        || s.to_owned(),
                        |v| content_text(&v, &["input_text", "output_text", "text"]),
                    ),
                None => content_text(output, &["input_text", "output_text", "text"]),
            };
            one(Some(result_item(
                event,
                p["call_id"].as_str().unwrap_or_default(),
                &text,
                false,
            )))
        }
        _ => Vec::new(),
    }
}
