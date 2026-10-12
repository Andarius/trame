#![allow(
    unsafe_code,
    reason = "libc FFI (flock/kill/killpg/prctl/getppid/waitpid/gethostname/fcntl/pre_exec)"
)]

use crate::{
    presence::{read_tail, usage_of},
    refs::{RefKind, parse_session_ref},
    target::{RequestFailure, Target, data_file, resolve_target},
};
use anyhow::{Result, bail};
use chrono::{DateTime, Utc};
use reqwest::Method;
use serde_json::{Value, json};
#[cfg(unix)]
use std::os::fd::AsRawFd;
use std::{
    env,
    fs::{self, OpenOptions},
    io::Write,
    time::Duration,
};

fn session_from_map() -> Option<String> {
    let cwd = env::current_dir().ok()?.to_string_lossy().into_owned();
    let map = fs::read_to_string(data_file("TRACKER_CLAUDE_MAP", "claude-sessions.json")).ok()?;
    let map: Value = serde_json::from_str(&map).ok()?;
    let entry = &map[&cwd];
    let at: DateTime<Utc> = entry["at"].as_str()?.parse().ok()?;
    if (Utc::now() - at).num_seconds() >= 3600 {
        return None;
    }
    entry["id"].as_str().map(str::to_owned)
}
fn stamp_transcript(input: &mut Value) {
    if input["agent"] == "codex" || input["agent_name"].is_string() && input["model"].is_string() {
        return;
    }
    let Some(id) = input["agent_id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            env::var("CLAUDE_CODE_SESSION_ID")
                .ok()
                .filter(|s| !s.is_empty())
        })
    else {
        return;
    };
    let Some(home) = env::var_os("HOME") else {
        return;
    };
    let root = env::var_os("CLAUDE_CONFIG_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(home).join(".claude"))
        .join("projects");
    if let Ok(dirs) = fs::read_dir(root) {
        for dir in dirs.flatten() {
            let path = dir.path().join(format!("{id}.jsonl"));
            if let Ok(tail) = read_tail(&path) {
                let usage = usage_of(&tail);
                if !input["agent_name"].is_string() && usage["name"].is_string() {
                    input["agent_name"] = usage["name"].clone();
                }
                if !input["model"].is_string() && usage["model"].is_string() {
                    input["model"] = usage["model"].clone();
                }
                break;
            }
        }
    }
}
fn queue(input: &Value, error: &str, json_out: bool) -> Result<()> {
    let path = env::var_os("TRACKER_OUTBOX")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            env::var_os("TRAME_LOCAL_DIR")
                .map(|root| std::path::PathBuf::from(root).join("outbox.jsonl"))
        })
        .unwrap_or_else(|| data_file("TRACKER_OUTBOX", "outbox.jsonl"));
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(format!("{}.lock", path.display()))?;
    #[cfg(unix)]
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    writeln!(
        OpenOptions::new().create(true).append(true).open(path)?,
        "{input}"
    )?;
    if json_out {
        println!("{}", json!({"queued":true,"error":error}));
    } else {
        println!(
            "Trame app not reachable ({error}) — queued to outbox, applied on next app launch"
        );
    }
    Ok(())
}
pub async fn run(mut input: Value, json_out: bool) -> Result<()> {
    if let Some(card) = input["card"].as_str() {
        let Some(reference) = parse_session_ref(card).filter(|r| r.kind == RefKind::Session) else {
            bail!("card: not a card id or card link: {card}");
        };
        input["card"] = json!(reference.id);
    }
    stamp_transcript(&mut input);
    if input["agent_id"].as_str().is_none_or(str::is_empty) {
        if let Some(id) = env::var("CODEX_THREAD_ID").ok().filter(|s| !s.is_empty()) {
            input["agent"] = json!("codex");
            input["agent_id"] = json!(id);
        } else if let Some(id) = input["claude_id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .or_else(|| {
                env::var("CLAUDE_CODE_SESSION_ID")
                    .ok()
                    .filter(|s| !s.is_empty())
            })
            .or_else(session_from_map)
        {
            input["claude_id"] = json!(id);
            input["agent"] = json!("claude");
            input["agent_id"] = json!(id);
        }
    }
    if input["story"].as_str().is_none_or(|s| s.trim().is_empty()) {
        eprintln!(
            "warning: no story — the story is what groups this session's branches onto one card"
        );
    }
    let target = match resolve_target().await {
        Ok(target) => target,
        Err(error) => return queue(&input, &error.to_string(), json_out),
    };
    let result = target
        .request(
            Method::POST,
            "/api/sessions",
            Some(&input),
            Some(Duration::from_secs(4)),
        )
        .await;
    let result = match result {
        Ok(value) => value,
        Err(error)
            if matches!(
                error.downcast_ref::<RequestFailure>(),
                Some(RequestFailure::Transport(_))
            ) || !target.hub
                && matches!(
                    error.downcast_ref::<RequestFailure>(),
                    Some(RequestFailure::Http { .. })
                ) =>
        {
            return queue(&input, &error.to_string(), json_out);
        }
        Err(error)
            if matches!(
                error.downcast_ref::<RequestFailure>(),
                Some(RequestFailure::InvalidJson(_))
            ) =>
        {
            return Err(error);
        }
        Err(error) => bail!("the hub rejected the track — {error}"),
    };
    print_result(&target, &input, &result, json_out);
    Ok(())
}
fn print_result(target: &Target, input: &Value, result: &Value, json_out: bool) {
    let id = result["id"].as_str().unwrap_or("");
    if json_out {
        println!(
            "{}",
            json!({"id":result["id"],"specs_page_id":result["specs_page_id"],"note":result["note"],"story_note":result["story_note"]})
        );
        return;
    }
    let status = input["status"].as_str().unwrap_or("active");
    let title = input["title"].as_str().unwrap_or("");
    println!(
        "ok: session {id} tracked in Trame ({status} — {title}){}",
        target.app_link(&format!("view=card&card={id}"))
    );
    if let Some(specs) = result["specs_page_id"].as_str().filter(|s| !s.is_empty()) {
        println!("specs page: {specs}");
    }
    if let Some(story) = result["story_note"].as_str().filter(|s| !s.is_empty()) {
        println!("story: {story}");
    }
    if let Some(note) = result["note"].as_str().filter(|s| !s.is_empty()) {
        println!("note: {note}");
    }
}
pub async fn main(args: &[String], json_out: bool) -> Result<()> {
    run(crate::cli::read_json_input(args).await?, json_out).await
}
