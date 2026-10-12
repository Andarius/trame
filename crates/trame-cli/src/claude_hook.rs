use crate::target::data_file;
use anyhow::Result;
use chrono::{DateTime, Duration, Utc};
use serde_json::{Map, Value, json};
#[cfg(unix)]
use std::os::{fd::AsRawFd, unix::fs::OpenOptionsExt};
use std::{
    fs::{self, OpenOptions},
    io::{self, Read, Write},
};

pub fn record(event: &Value) -> Result<()> {
    let Some(id) = event["session_id"].as_str().filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    let Some(cwd) = event["cwd"].as_str().filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    let path = data_file("TRACKER_CLAUDE_MAP", "claude-sessions.json");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(format!("{}.lock", path.display()))?;
    #[cfg(unix)]
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return Err(io::Error::last_os_error().into());
    }
    let mut map = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<Map<String, Value>>(&s).ok())
        .unwrap_or_default();
    let now = Utc::now();
    map.retain(|_, entry| {
        entry["at"]
            .as_str()
            .and_then(|s| s.parse::<DateTime<Utc>>().ok())
            .is_some_and(|at| now - at <= Duration::days(30))
    });
    let mut entry = json!({"id": id, "at": now.to_rfc3339()});
    if let Some(transcript) = event["transcript_path"].as_str() {
        entry["transcript"] = json!(transcript);
    }
    map.insert(cwd.into(), entry);
    let temp = format!("{}.{}.tmp", path.display(), uuid::Uuid::new_v4());
    let mut writer = OpenOptions::new();
    writer.write(true).create_new(true);
    #[cfg(unix)]
    writer.mode(0o600);
    let mut file = writer.open(&temp)?;
    writeln!(file, "{}", serde_json::to_string_pretty(&map)?)?;
    file.sync_all()?;
    fs::rename(temp, path)?;
    Ok(())
}

pub fn run() {
    let mut input = String::new();
    if io::stdin().read_to_string(&mut input).is_ok() {
        if let Ok(event) = serde_json::from_str::<Value>(&input) {
            let _ = record(&event);
        }
    }
}
