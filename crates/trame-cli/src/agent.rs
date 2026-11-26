use anyhow::{Context, Result, bail};
use reqwest::Method;
use serde_json::{Value, json};
use std::io::Read;
use std::time::Duration;

use crate::target::local_target;

const USAGE: &str =
    "usage: tramecli agent list | send <run> <text…|-> | send --peer <peer> <text…|-> | hook <run>";

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
            let to_peer = args.get(1).is_some_and(|arg| arg == "--peer");
            let address = if to_peer { 2 } else { 1 };
            let (Some(recipient), Some(first)) = (args.get(address), args.get(address + 1)) else {
                bail!(USAGE);
            };
            let text = if first == "-" {
                let mut text = String::new();
                std::io::stdin().read_to_string(&mut text)?;
                text
            } else {
                args[address + 1..].join(" ")
            };
            // Include the sending run if the CLI was called from one.
            let from = std::env::var("TRAME_AGENT_RUN").unwrap_or_else(|_| "tramecli".into());
            let mut body = json!({"token": token, "text": text, "from": from});
            if to_peer {
                body["peer"] = json!(recipient);
                let reply = target
                    .request(
                        Method::POST,
                        "/api/agent/relay/send",
                        Some(&body),
                        Some(Duration::from_secs(22)),
                    )
                    .await?;
                let id = reply["id"]
                    .as_str()
                    .context("Trame returned no delivery ID")?;
                if json_out {
                    println!("{reply}");
                } else {
                    println!("delivered to {recipient} ({id})");
                }
                return Ok(0);
            }
            let reply = target
                .post(&format!("/api/agent/runs/{recipient}/inbox"), &body)
                .await?;
            let queued = reply["queued"].as_u64().unwrap_or(0);
            println!(
                "sent to {recipient}{}",
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
