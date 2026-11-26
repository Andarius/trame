use serde::Deserialize;
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
    pub reset: bool,
}

impl Page {
    pub fn to_json(&self) -> Value {
        let mut page = json!({"items": self.items, "start": self.start, "end": self.end, "more": self.start > 0});
        if self.reset {
            page["reset"] = true.into();
        }
        page
    }
}

/// The page ending at byte `before` (or the end of the file), reaching back about one page of whole lines.
pub fn before(path: &Path, before: Option<u64>, codex: bool) -> std::io::Result<Page> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    // a partial last line is still being written: stop at the last newline
    let tail = last_newline(&mut file, size)?;
    let end = before.unwrap_or(tail).min(tail);
    page_before(&mut file, end, tail, codex)
}

fn page_before(file: &mut File, end: u64, tail: u64, codex: bool) -> std::io::Result<Page> {
    let (start, bytes) = window_before(file, 0, end)?;
    let items = if codex {
        items(&bytes, codex_items)
    } else {
        let mut lineage = Lineage::default();
        // Older pages use the current tip so rewound branches stay out of every page.
        visit_links(file, end, tail, |link| {
            lineage.includes(link);
            !lineage.found_tip || lineage.parent.is_some()
        })?;
        lineage.items(&bytes)
    };
    Ok(Page {
        items,
        start,
        end,
        reset: false,
    })
}

fn window_before(file: &mut File, floor: u64, end: u64) -> std::io::Result<(u64, Vec<u8>)> {
    let mut want = PAGE;
    loop {
        let start = end.saturating_sub(want).max(floor);
        let mut bytes = read_range(file, start, end)?;
        // the window starts mid-line: drop that fragment, unless it is all there is
        let skip = if start == floor {
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
        drop(bytes.drain(..skip));
        return Ok((start + skip as u64, bytes));
    }
}

/// Every whole line appended since byte `after`, for following a live session.
pub fn after(path: &Path, after: u64, codex: bool) -> std::io::Result<Page> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let end = last_newline(&mut file, size)?;
    if after > end {
        let mut page = page_before(&mut file, end, end, codex)?;
        page.reset = true;
        return Ok(page);
    }
    let bytes = read_range(&mut file, after, end)?;
    let items = if codex {
        items(&bytes, codex_items)
    } else {
        let mut lineage = Lineage::default();
        let items = lineage.items(&bytes);
        if lineage.found_tip {
            let mut previous = None;
            visit_links(&mut file, 0, after, |link| {
                previous = link.uuid;
                false
            })?;
            if previous.is_some() && previous != lineage.parent {
                let mut page = page_before(&mut file, end, end, codex)?;
                page.reset = true;
                return Ok(page);
            }
        }
        items
    };
    Ok(Page {
        items,
        start: after,
        end,
        reset: false,
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

fn items(bytes: &[u8], parse: fn(&Value) -> Vec<Value>) -> Vec<Value> {
    String::from_utf8_lossy(bytes)
        .split('\n')
        .filter_map(|line| serde_json::from_str(line).ok())
        .flat_map(|event| parse(&event))
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeLink {
    uuid: Option<String>,
    parent_uuid: Option<String>,
    logical_parent_uuid: Option<String>,
    compact_metadata: Option<CompactMetadata>,
    subtype: Option<String>,
    #[serde(default)]
    is_sidechain: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompactMetadata {
    preserved_segment: Option<PreservedSegment>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreservedSegment {
    tail_uuid: Option<String>,
}

#[derive(Default)]
struct Lineage {
    found_tip: bool,
    parent: Option<String>,
}

impl Lineage {
    fn includes(&mut self, link: ClaudeLink) -> bool {
        if link.is_sidechain {
            return false;
        }
        let Some(id) = &link.uuid else {
            return true; // older transcripts can omit message IDs
        };
        if self.found_tip && self.parent.as_ref() != Some(id) {
            return false;
        }
        self.found_tip = true;
        self.parent = if link.subtype.as_deref() == Some("compact_boundary") {
            link.compact_metadata
                .and_then(|meta| meta.preserved_segment)
                .and_then(|segment| segment.tail_uuid)
                .or(link.logical_parent_uuid)
                .or(link.parent_uuid)
        } else {
            link.parent_uuid
        };
        true
    }

    fn items(&mut self, bytes: &[u8]) -> Vec<Value> {
        let mut items = Vec::new();
        for line in String::from_utf8_lossy(bytes).rsplit('\n') {
            let Ok(link) = serde_json::from_str::<ClaudeLink>(line) else {
                continue;
            };
            if self.includes(link)
                && let Ok(event) = serde_json::from_str(line)
            {
                items.extend(claude_items(&event).into_iter().rev());
            }
        }
        items.reverse();
        items
    }
}

fn visit_links(
    file: &mut File,
    floor: u64,
    mut end: u64,
    mut visit: impl FnMut(ClaudeLink) -> bool,
) -> std::io::Result<()> {
    while end > floor {
        let (start, bytes) = window_before(file, floor, end)?;
        for line in String::from_utf8_lossy(&bytes).rsplit('\n') {
            if let Ok(link) = serde_json::from_str::<ClaudeLink>(line)
                && link.uuid.is_some()
                && !link.is_sidechain
                && !visit(link)
            {
                return Ok(());
            }
        }
        end = start;
    }
    Ok(())
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
    // a skill's instructions arrive as a user message: show which skill, not its text
    if let Some(dir) = trimmed.strip_prefix("Base directory for this skill:") {
        let name = dir
            .lines()
            .next()
            .unwrap_or_default()
            .trim()
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or_default();
        return Some(item(
            "note",
            event,
            json!({"text": format!("skill: {name}")}),
        ));
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
    if event["isSidechain"] == true || event["isMeta"] == true || event["isCompactSummary"] == true
    {
        return Vec::new();
    }
    let content = &event["message"]["content"];
    match event["type"].as_str() {
        Some("system") if event["subtype"] == "compact_boundary" => vec![compaction_item(event)],
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
    if event["type"] == "compacted" {
        return vec![compaction_item(event)];
    }
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

fn compaction_item(event: &Value) -> Value {
    item("compaction", event, Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_turns_keep_prompts_and_name_injected_skills() {
        let event = json!({});
        for (text, want) in [
            ("fix the cart", Some(("user", "fix the cart"))),
            (
                "Base directory for this skill: /home/u/.claude/skills/trame-track\n\n# Track",
                Some(("note", "skill: trame-track")),
            ),
            ("<command-name>/clear</command-name>", None),
        ] {
            let got = user_item(&event, text);
            assert_eq!(
                got.as_ref()
                    .map(|v| (v["kind"].as_str().unwrap(), v["text"].as_str().unwrap())),
                want,
                "{text}"
            );
        }
    }
}
