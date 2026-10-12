use serde_json::{Value, json};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

const HEAD: usize = 524_288;
const TAIL: usize = 262_144;

pub fn read_chunks(path: &Path) -> std::io::Result<(String, String)> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let mut head = vec![0; size.min(HEAD as u64) as usize];
    file.read_exact(&mut head)?;
    let tail = if size > HEAD as u64 {
        file.seek(SeekFrom::Start(size.saturating_sub(TAIL as u64)))?;
        let mut tail = vec![0; size.min(TAIL as u64) as usize];
        file.read_exact(&mut tail)?;
        tail
    } else {
        head.clone()
    };
    Ok((
        String::from_utf8_lossy(&head).into_owned(),
        String::from_utf8_lossy(&tail).into_owned(),
    ))
}

fn lines(text: &str) -> impl Iterator<Item = Value> + '_ {
    text.split('\n')
        .filter_map(|line| serde_json::from_str(line).ok())
}

fn first_line(text: &str, codex: bool) -> Option<String> {
    let line = text.trim().lines().next()?.trim();
    if line.is_empty()
        || line.starts_with('<')
        || line.starts_with("Caveat:")
        || line.starts_with("This session is being continued")
        || codex && line.starts_with('#')
    {
        None
    } else {
        Some(line.to_owned())
    }
}

fn claude_user(event: &Value) -> Option<String> {
    if event["type"] != "user" {
        return None;
    }
    let content = &event["message"]["content"];
    let text = if let Some(s) = content.as_str() {
        s.to_owned()
    } else if let Some(parts) = content.as_array() {
        parts
            .iter()
            .filter(|p| p["type"] == "text")
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        String::new()
    };
    first_line(&text, false)
}

fn codex_user(event: &Value) -> Option<String> {
    let p = &event["payload"];
    let text = if event["type"] == "event_msg" && p["type"] == "user_message" {
        p["message"].as_str()?.to_owned()
    } else if event["type"] == "response_item" && p["type"] == "message" && p["role"] == "user" {
        p["content"]
            .as_array()?
            .iter()
            .filter(|c| c["type"] == "input_text")
            .filter_map(|c| c["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        return None;
    };
    first_line(&text, true)
}

pub fn codex_meta(head: &str, tail: &str) -> Value {
    let (mut id, mut cwd, mut branch, mut prompt) = (None, None, None, None);
    let mut subagent = false;
    for event in lines(head) {
        if event["type"] == "session_meta" {
            let p = &event["payload"];
            id = p["id"]
                .as_str()
                .or_else(|| p["session_id"].as_str())
                .map(str::to_owned)
                .or(id);
            cwd = p["cwd"].as_str().map(str::to_owned).or(cwd);
            branch = p["git"]["branch"].as_str().map(str::to_owned).or(branch);
            subagent = trame_core::truthy(&p["parent_thread_id"])
                || p["thread_source"] == "subagent"
                || p["source"].get("subagent").is_some();
        }
        if prompt.is_none() {
            prompt = codex_user(&event);
        }
    }
    let (mut last, mut active) = (None, prompt.is_some());
    for event in lines(tail) {
        if let Some(s) = event["timestamp"].as_str() {
            last = Some(s.to_owned());
        }
        if codex_user(&event).is_some() {
            active = true;
        }
    }
    if matches!(branch.as_deref(), Some("HEAD" | "")) {
        branch = None;
    }
    json!({"id":id,"cwd":cwd,"firstPrompt":prompt,"branch":branch,"lastTs":last,"hasActivity":active,"subagent":subagent})
}

pub fn claude_meta(head: &str, tail: &str) -> Value {
    let (mut cwd, mut prompt) = (None, None);
    for event in lines(head) {
        if cwd.is_none() {
            cwd = event["cwd"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
        }
        if prompt.is_none() {
            prompt = claude_user(&event);
        }
        if cwd.is_some() && prompt.is_some() {
            break;
        }
    }
    let (mut title, mut last_prompt, mut branch, mut last) = (None, None, None, None);
    let mut active = prompt.is_some();
    for event in lines(tail) {
        if event["type"] == "ai-title" {
            if let Some(s) = event["aiTitle"].as_str() {
                title = Some(s.to_owned());
            }
        }
        if event["type"] == "last-prompt" {
            if let Some(s) = event["lastPrompt"].as_str() {
                last_prompt = Some(s.to_owned());
            }
        }
        if event["type"] == "user" || event["type"] == "assistant" {
            active = true;
        }
        if let Some(s) = event["gitBranch"].as_str() {
            branch = Some(s.to_owned());
        }
        if let Some(s) = event["timestamp"].as_str() {
            last = Some(s.to_owned());
        }
        if cwd.is_none() {
            cwd = event["cwd"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
        }
    }
    if matches!(branch.as_deref(), Some("HEAD" | "")) {
        branch = None;
    }
    json!({"cwd":cwd,"aiTitle":title,"lastPrompt":last_prompt,"firstPrompt":prompt,"branch":branch,"lastTs":last,"hasActivity":active})
}
