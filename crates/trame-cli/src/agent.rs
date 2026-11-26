use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::io::Read;

use crate::target::local_target;

const USAGE: &str = "usage: tramecli agent list | send <run> <text…|-> | hook <run>";

/// `tramecli agent`: list the agent-view runs, message one, or print how a hook reaches it.
pub async fn main(args: &[String], json_out: bool) -> Result<i32> {
    let Some(target) = local_target().await? else {
        bail!("Trame app is not running: agent-view runs live in the desktop app");
    };
    let token = target.get("/api/term/token").await?["token"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    match args.first().map(String::as_str) {
        Some("list") => {
            let runs = target
                .get(&format!("/api/agent/runs?token={token}"))
                .await?;
            if json_out {
                println!("{runs}");
                return Ok(0);
            }
            for r in runs.as_array().into_iter().flatten() {
                let folder = r["cwd"]
                    .as_str()
                    .unwrap_or_default()
                    .rsplit('/')
                    .next()
                    .unwrap_or_default();
                println!(
                    "{}  {:<6}  {:<10}  {folder}",
                    r["id"].as_str().unwrap_or_default(),
                    r["provider"].as_str().unwrap_or("claude"),
                    r["status"].as_str().unwrap_or_default(),
                );
            }
        }
        Some("send") => {
            let (Some(run), Some(first)) = (args.get(1), args.get(2)) else {
                bail!(USAGE);
            };
            let text = if first == "-" {
                let mut text = String::new();
                std::io::stdin().read_to_string(&mut text)?;
                text
            } else {
                args[2..].join(" ")
            };
            // from inside a run, the message is signed with it so the receiver can answer
            let from = std::env::var("TRAME_AGENT_RUN").unwrap_or_else(|_| "tramecli".into());
            let body = json!({"token": token, "text": text, "from": from});
            let reply = target
                .post(&format!("/api/agent/runs/{run}/inbox"), &body)
                .await?;
            let queued = reply["queued"].as_u64().unwrap_or(0);
            println!(
                "sent to {run}{}",
                if queued > 1 {
                    format!(" ({queued} waiting)")
                } else {
                    String::new()
                }
            );
        }
        Some("hook") => {
            let Some(run) = args.get(1) else {
                bail!(USAGE);
            };
            let hook: Value = target
                .get(&format!("/api/agent/runs/{run}/hook?token={token}"))
                .await?;
            let (url, secret, header) = (
                hook["url"].as_str().unwrap_or_default(),
                hook["token"].as_str().unwrap_or_default(),
                hook["header"].as_str().unwrap_or_default(),
            );
            if json_out {
                println!("{hook}");
                return Ok(0);
            }
            println!(
                "curl -X POST {url} -H '{header}: {secret}' -H 'content-type: application/json' -d '{{\"text\":\"…\",\"from\":\"my-hook\"}}'"
            );
        }
        _ => bail!(USAGE),
    }
    Ok(0)
}
