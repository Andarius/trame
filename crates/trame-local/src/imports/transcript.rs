use serde_json::{Value, json};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

const HEAD: usize = 524_288;
const TAIL: usize = 262_144;

#[allow(
    clippy::cast_possible_truncation,
    reason = "values fit by construction (timestamps, ids, pids, JS-number parity)"
)]
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

/// The last `max` bytes of a transcript, from its first whole line.
pub fn read_tail(path: &Path, max: u64) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let start = file.metadata()?.len().saturating_sub(max);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(if start == 0 {
        text.into_owned()
    } else {
        text.split_once('\n')
            .map_or_else(String::new, |(_, rest)| rest.to_owned())
    })
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

pub(crate) fn claude_user(event: &Value) -> Option<String> {
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

pub(crate) fn codex_user(event: &Value) -> Option<String> {
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

/// A message's full text, or None for tool results, command echoes and injected context.
fn said(text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty() || text.starts_with('<') || text.starts_with("Caveat:") {
        return None;
    }
    let mut out: String = text.chars().take(TAIL_TEXT).collect();
    if out.len() < text.len() {
        // end on a sentence or a line when one ends late enough, not mid-word
        if let Some(cut) = out.rfind(['\n', '.']).filter(|&i| i > out.len() * 3 / 5) {
            out.truncate(cut + 1);
        }
        out.push_str(" …");
    }
    Some(out)
}

/// A user turn the harness wrote (another session's message, a context summary): a short note instead.
fn harness_note(text: &str) -> Option<&'static str> {
    [
        (
            "Another Claude session sent a message",
            "message from another session",
        ),
        (
            "This session is being continued",
            "continued from a previous conversation",
        ),
        ("[SYSTEM NOTIFICATION", "background task finished"),
    ]
    .into_iter()
    .find(|(start, _)| text.trim_start().starts_with(start))
    .map(|(_, note)| note)
}

/// A tool call as Claude Code prints it: `Bash(cargo test)`, `Edit(pty.rs)`, or the bare name.
fn tool_label(name: &str, input: &Value) -> String {
    let arg = match name {
        "Bash" | "shell" | "exec_command" => input["command"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| input["cmd"].as_str().map(str::to_owned))
            .or_else(|| {
                input["command"].as_array().map(|parts| {
                    let parts: Vec<&str> = parts.iter().filter_map(Value::as_str).collect();
                    parts.join(" ")
                })
            }),
        "Edit" | "Write" | "Read" | "NotebookEdit" => input["file_path"]
            .as_str()
            .map(|p| p.rsplit('/').next().unwrap_or(p).to_owned()),
        "Grep" | "Glob" => input["pattern"].as_str().map(str::to_owned),
        "Agent" | "Task" => input["description"].as_str().map(str::to_owned),
        "WebFetch" => input["url"].as_str().map(str::to_owned),
        "WebSearch" => input["query"].as_str().map(str::to_owned),
        "Skill" => input["skill"].as_str().map(str::to_owned),
        _ => None,
    };
    let Some(arg) = arg.and_then(|a| a.lines().next().map(str::trim).map(str::to_owned)) else {
        return name.to_owned();
    };
    let mut short: String = arg.chars().take(TOOL_ARG).collect();
    if short.len() < arg.len() {
        short.push('…');
    }
    format!("{name}({short})")
}

const TOOL_ARG: usize = 60;
const TAIL_TEXT: usize = 600;

/// One step of the conversation: who spoke and what, with tool calls folded into one `tools` step.
fn steps(event: &Value, codex: bool) -> Vec<Value> {
    let texts = |parts: &Value, kind: &str| -> Option<String> {
        let joined = parts
            .as_array()?
            .iter()
            .filter(|p| p["type"] == kind)
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        said(&joined)
    };
    if codex {
        let p = &event["payload"];
        if event["type"] != "response_item" {
            return Vec::new();
        }
        return match (p["type"].as_str(), p["role"].as_str()) {
            (Some("message"), Some("user")) => texts(&p["content"], "input_text")
                .filter(|t| !t.starts_with('#'))
                .map(|t| vec![json!({"role":"user","text":t})])
                .unwrap_or_default(),
            (Some("message"), Some("assistant")) => texts(&p["content"], "output_text")
                .map(|t| vec![json!({"role":"agent","text":t})])
                .unwrap_or_default(),
            (Some("function_call"), _) => p["name"]
                .as_str()
                .map(|n| {
                    let args = p["arguments"]
                        .as_str()
                        .and_then(|a| serde_json::from_str::<Value>(a).ok())
                        .unwrap_or(Value::Null);
                    vec![json!({"role":"tools","tools":[tool_label(n, &args)]})]
                })
                .unwrap_or_default(),
            _ => Vec::new(),
        };
    }
    let content = &event["message"]["content"];
    match event["type"].as_str() {
        Some("user") => content
            .as_str()
            .and_then(said)
            .or_else(|| texts(content, "text"))
            .map(|t| match harness_note(&t) {
                Some(note) => vec![json!({"role":"note","text":note})],
                None => vec![json!({"role":"user","text":t})],
            })
            .unwrap_or_default(),
        Some("assistant") => content
            .as_array()
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|p| match p["type"].as_str() {
                        Some("text") => p["text"]
                            .as_str()
                            .and_then(said)
                            .map(|t| json!({"role":"agent","text":t})),
                        Some("tool_use") => p["name"]
                            .as_str()
                            .map(|n| json!({"role":"tools","tools":[tool_label(n, &p["input"])]})),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// The last `limit` turns of a transcript tail: what you said (or a harness note), its tool calls folded, then the agent's final reply.
pub fn conversation_tail(tail: &str, codex: bool, limit: usize) -> Value {
    #[derive(Default)]
    struct Turn {
        user: Option<Value>,
        tools: Vec<Value>,
        reply: Option<Value>,
    }
    let mut turns: Vec<Turn> = Vec::new();
    for step in lines(tail).flat_map(|e| steps(&e, codex)) {
        if step["role"] == "user" || step["role"] == "note" || turns.is_empty() {
            turns.push(Turn::default());
        }
        let turn = turns.last_mut().unwrap();
        match step["role"].as_str() {
            Some("user" | "note") => turn.user = Some(step),
            Some("tools") => turn.tools.push(step["tools"][0].clone()),
            _ => turn.reply = Some(step["text"].clone()),
        }
    }
    let more = turns.len() > limit;
    let start = turns.len().saturating_sub(limit);
    let steps: Vec<Value> = turns
        .split_off(start)
        .into_iter()
        .flat_map(|t| {
            let user = t.user;
            let tools = (!t.tools.is_empty()).then(|| json!({"role":"tools","tools":t.tools}));
            let reply = t.reply.map(|text| json!({"role":"agent","text":text}));
            [user, tools, reply].into_iter().flatten()
        })
        .collect();
    json!({"steps": steps, "more": more})
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
