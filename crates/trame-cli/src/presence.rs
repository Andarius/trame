use crate::target::{data_file, resolve_target};
use anyhow::{Result, bail};
use chrono::Utc;
use serde_json::{Value, json};
use std::{
    env, fs,
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

pub fn state_of(event: &str) -> Option<&'static str> {
    match event {
        "UserPromptSubmit" | "PreToolUse" => Some("working"),
        "Notification" => Some("waiting"),
        "Stop" | "SessionEnd" => Some("idle"),
        _ => None,
    }
}
pub fn usage_of(tail: &str) -> Value {
    let mut out = json!({});
    for line in tail.lines().rev() {
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let msg = &row["message"];
        if row["type"] == "assistant" && msg["usage"].is_object() && !out["tokens"].is_number() {
            let usage = &msg["usage"];
            if out["model"].is_null() && msg["model"].is_string() {
                out["model"] = msg["model"].clone();
            }
            let tokens: i64 = [
                "input_tokens",
                "cache_creation_input_tokens",
                "cache_read_input_tokens",
                "output_tokens",
            ]
            .iter()
            .map(|key| usage[key].as_i64().unwrap_or(0))
            .sum();
            out["tokens"] = json!(tokens);
        }
        if row["payload"]["type"] == "token_count" && !out["tokens"].is_number() {
            let info = &row["payload"]["info"];
            if info.is_object() {
                if let Some(tokens) = info["last_token_usage"]["input_tokens"]
                    .as_i64()
                    .or_else(|| info["total_token_usage"]["total_tokens"].as_i64())
                {
                    out["tokens"] = json!(tokens);
                }
                if info["model_context_window"].is_number() {
                    out["context_max"] = info["model_context_window"].clone();
                }
            }
        }
        if row["type"] == "turn_context"
            && out["model"].is_null()
            && row["payload"]["model"].is_string()
        {
            out["model"] = row["payload"]["model"].clone();
        }
        if row["type"] == "agent-name" && out["name"].is_null() && row["agentName"].is_string() {
            out["name"] = row["agentName"].clone();
        }
        if row["type"] == "custom-title" && out["name"].is_null() && row["customTitle"].is_string()
        {
            out["name"] = row["customTitle"].clone();
        }
        if out["model"].is_string() && out["tokens"].is_number() && out["name"].is_string() {
            break;
        }
    }
    out
}
pub fn provider_from_base(base: Option<&str>) -> String {
    let Some(base) = base.filter(|s| !s.is_empty()) else {
        return "Anthropic".into();
    };
    let Ok(url) = reqwest::Url::parse(base) else {
        return "Anthropic".into();
    };
    let Some(host) = url.host_str() else {
        return "Anthropic".into();
    };
    if host == "anthropic.com" || host.ends_with(".anthropic.com") {
        return "Anthropic".into();
    }
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.into(),
    }
}
fn state_file(id: &str) -> PathBuf {
    let mut path = data_file("TRACKER_CLAUDE_MAP", "claude-sessions.json");
    path.set_file_name(format!("presence-{id}.json"));
    path
}
pub(crate) fn read_tail(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let size = file.metadata()?.len();
    file.seek(SeekFrom::Start(size.saturating_sub(256 * 1024)))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
fn name_in(path: &Path) -> io::Result<Option<String>> {
    let mut name = None;
    for line in BufReader::new(fs::File::open(path)?).lines() {
        let line = line?;
        if !line.contains("\"agent-name\"") && !line.contains("\"custom-title\"") {
            continue;
        }
        if let Some(found) = usage_of(&line)["name"].as_str() {
            name = Some(found.to_owned());
        }
    }
    Ok(name)
}
fn step_of(event: &Value) -> Option<String> {
    let name = event["tool_name"].as_str()?;
    let target = [
        "file_path",
        "path",
        "command",
        "pattern",
        "url",
        "description",
    ]
    .iter()
    .filter_map(|key| event["tool_input"][key].as_str())
    .find(|s| !s.trim().is_empty());
    let short = target.map(|s| {
        if s.contains('/') && !s.contains(' ') {
            s.split('/')
                .rev()
                .take(2)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("/")
        } else {
            s.to_owned()
        }
    });
    Some(format!(
        "{name}{}",
        short
            .map(|s| format!(
                " {}",
                s.split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .chars()
                    .take(80)
                    .collect::<String>()
            ))
            .unwrap_or_default()
    ))
}
async fn post(mut push: Value) -> Result<()> {
    let id = push["session_id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("session_id is required"))?
        .to_owned();
    push.as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("presence must be an object"))?
        .remove("session_id");
    let target = resolve_target().await?;
    target
        .post(&format!("/api/sessions/{id}/presence"), &push)
        .await?;
    Ok(())
}
async fn from_hook(harness: &str, event: &Value) -> Result<()> {
    let Some(id) = event["session_id"].as_str() else {
        return Ok(());
    };
    let Some(name) = event["hook_event_name"].as_str() else {
        return Ok(());
    };
    let Some(state) = state_of(name) else {
        return Ok(());
    };
    let file = state_file(id);
    let last = fs::read_to_string(&file)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or(Value::Null);
    let now = Utc::now().timestamp_millis();
    let ending = name == "SessionEnd";
    if !ending && last["state"] == state && now - last["at"].as_i64().unwrap_or(0) < 20_000 {
        return Ok(());
    }
    let transcript = event["transcript_path"].as_str().map(Path::new);
    let usage = transcript
        .and_then(|path| read_tail(path).ok())
        .map(|tail| usage_of(&tail))
        .unwrap_or(json!({}));
    let session_name = usage["name"]
        .as_str()
        .or_else(|| last["name"].as_str())
        .map(str::to_owned)
        .or_else(|| {
            if last.get("name").is_none() {
                transcript.and_then(|path| name_in(path).ok().flatten())
            } else {
                None
            }
        });
    if ending {
        let _ = fs::remove_file(&file);
    } else {
        let _ = fs::write(
            &file,
            json!({"state":state,"at":now,"name":session_name}).to_string(),
        );
    }
    let provider = if harness == "codex" {
        "OpenAI".into()
    } else {
        let env_base = env::var("ANTHROPIC_BASE_URL")
            .ok()
            .filter(|s| !s.is_empty());
        let setting_base = env::var_os("CLAUDE_CONFIG_DIR")
            .and_then(|dir| fs::read_to_string(PathBuf::from(dir).join("settings.json")).ok())
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|s| s["env"]["ANTHROPIC_BASE_URL"].as_str().map(str::to_owned));
        provider_from_base(env_base.as_deref().or(setting_base.as_deref()))
    };
    let mut push = json!({
        "session_id":id, "state":state,
        "harness":if harness=="codex" {"codex"} else {"claude-code"},
        "provider":provider, "name":session_name,
    });
    for key in ["model", "tokens", "context_max"] {
        let value = if key == "model" && event["model"].is_string() {
            &event["model"]
        } else {
            &usage[key]
        };
        if !value.is_null() {
            push[key] = value.clone();
        }
    }
    if let Some(step) = step_of(event).or_else(|| {
        if name == "UserPromptSubmit" {
            Some("reading the prompt".into())
        } else {
            None
        }
    }) {
        push["step"] = json!(step);
    }
    if state == "waiting" && event["message"].is_string() {
        push["question"] = event["message"].clone();
    }
    if ending {
        push["ended"] = json!(true);
    }
    post(push).await
}
pub async fn main(args: &[String]) -> Result<()> {
    if args.iter().any(|a| a == "--install-hooks") {
        if let Ok(home) = env::var("HOME") {
            let _ = crate::setup::install_presence_hooks(&home, false);
        }
        return Ok(());
    }
    if let Some(index) = args.iter().position(|a| a == "--hook") {
        let harness = args.get(index + 1).map(String::as_str).unwrap_or("");
        if !matches!(harness, "claude" | "codex") {
            bail!("--hook takes claude or codex");
        }
        let input = crate::cli::read_json_input(&[])
            .await
            .unwrap_or(Value::Null);
        let _ = from_hook(harness, &input).await;
        return Ok(());
    }
    post(crate::cli::read_json_input(args).await?).await
}
