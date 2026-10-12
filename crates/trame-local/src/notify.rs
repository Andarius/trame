use crate::routes::Native;
use chrono::{Local, NaiveDate, Timelike};
use serde_json::{Value, json};

pub fn digest(due: &[Value], today: &str) -> Value {
    let Ok(today) = NaiveDate::parse_from_str(today, "%Y-%m-%d") else {
        return Value::Null;
    };
    let shown: Vec<_> = due
        .iter()
        .filter_map(|d| {
            let date = NaiveDate::parse_from_str(d["due"].as_str()?, "%Y-%m-%d").ok()?;
            let days = (date - today).num_days();
            (days <= 7).then_some((d, days))
        })
        .collect();
    if shown.is_empty() {
        return Value::Null;
    }
    let late = shown.iter().filter(|(_, days)| *days < 0).count();
    let soon = shown.len() - late;
    let mut counts = Vec::new();
    if late > 0 {
        counts.push(format!("{late} late"));
    }
    if soon > 0 {
        counts.push(format!("{soon} due this week"));
    }
    let mut lines: Vec<_> = shown
        .iter()
        .take(5)
        .map(|(d, days)| {
            let when = match *days {
                n if n < 0 => format!("{}d late", -n),
                0 => "today".into(),
                1 => "tomorrow".into(),
                _ => d["due"].as_str().unwrap_or("").into(),
            };
            format!("⚑ {} ({when})", d["text"].as_str().unwrap_or(""))
        })
        .collect();
    if shown.len() > 5 {
        lines.push(format!("+{} more", shown.len() - 5));
    }
    json!({"title":format!("Trame · {}",counts.join(", ")),"body":lines.join("\n")})
}

pub async fn background(state: Native) {
    if state.sync.offline {
        return;
    }
    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    loop {
        let state = state.clone();
        let _ = crate::blocking::spawn(move || -> anyhow::Result<()> {
            let now = Local::now();
            if now.hour() < 9 {
                return Ok(());
            }
            let today = now.format("%Y-%m-%d").to_string();
            let marker = std::env::var_os("TRACKER_PORT_FILE")
                .map(std::path::PathBuf::from)
                .and_then(|p| p.parent().map(|p| p.join("due-notified")))
                .unwrap_or_else(|| state.root.join("due-notified"));
            if std::fs::read_to_string(&marker).unwrap_or_default().trim() == today {
                return Ok(());
            }
            let mut db = crate::db::Db::connect(
                &state.root.join("socket"),
                &state.origin,
                Some(state.settings),
            )?;
            let due = crate::sessions::list_due(&mut db)?;
            let d = digest(due.as_array().unwrap_or(&Vec::new()), &today);
            if d.is_null() {
                return Ok(());
            }
            std::fs::write(marker, today)?;
            let title = d["title"].as_str().unwrap().to_owned();
            let body = d["body"].as_str().unwrap().to_owned();
            let port = state.port;
            std::thread::spawn(move || {
                use std::process::{Command, Stdio};
                if cfg!(target_os = "macos") {
                    let _ = Command::new("osascript")
                        .args([
                            "-e",
                            &format!(
                                "display notification {} with title {}",
                                json!(body),
                                json!(title)
                            ),
                        ])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status();
                } else if let Ok(output) = Command::new("notify-send")
                    .args([
                        "-a",
                        "Trame",
                        "-A",
                        "open=Open Trame",
                        "--wait",
                        &title,
                        &body,
                    ])
                    .stdin(Stdio::null())
                    .stderr(Stdio::null())
                    .output()
                {
                    if String::from_utf8_lossy(&output.stdout).trim() == "open" {
                        let _ = Command::new("xdg-open")
                            .arg(format!("http://127.0.0.1:{port}/"))
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .status();
                    }
                }
            });
            Ok(())
        })
        .await;
        tokio::time::sleep(std::time::Duration::from_mins(10)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_digest_assertions() {
        for (due, expected) in [
            (json!([{"text":"far away","due":"2026-11-30"}]), Value::Null),
            (
                json!([{"text":"rotate secret","due":"2026-10-06"},{"text":"bump polarsen","due":"2026-10-11"}]),
                json!({"title":"Trame · 1 late, 1 due this week","body":"⚑ rotate secret (3d late)\n⚑ bump polarsen (2026-10-11)"}),
            ),
            (
                json!([{"text":"bump","due":"2026-10-10"}]),
                json!({"title":"Trame · 1 due this week","body":"⚑ bump (tomorrow)"}),
            ),
        ] {
            assert_eq!(digest(due.as_array().unwrap(), "2026-10-09"), expected);
        }
    }
}
