use crate::{
    board, claude_hook, comment, db, deployments, due, help, mcp, open, page, plugin_cmd, plugins,
    presence, setup,
    target::{self, resolve_target},
    track, watch,
};
use anyhow::Result;
use serde_json::Value;
use std::{env, fs, time::Duration};
use tokio::io::{self, AsyncReadExt};

pub async fn read_json_input(args: &[String]) -> Result<Value> {
    let raw = if let Some(first) = args.first().filter(|s| !s.is_empty()) {
        first.clone()
    } else {
        let mut raw = String::new();
        io::stdin().read_to_string(&mut raw).await?;
        raw
    };
    Ok(serde_json::from_str(&raw)?)
}
fn newer(a: &str, b: &str) -> bool {
    let a = a
        .split('.')
        .take(3)
        .map(|s| s.parse::<i64>().unwrap_or(0))
        .collect::<Vec<_>>();
    let b = b
        .split('.')
        .take(3)
        .map(|s| s.parse::<i64>().unwrap_or(0))
        .collect::<Vec<_>>();
    for i in 0..3 {
        let aa = *a.get(i).unwrap_or(&0);
        let bb = *b.get(i).unwrap_or(&0);
        if aa != bb {
            return aa > bb;
        }
    }
    false
}
pub fn stale_warning(cli: &str, app: Option<&str>, path: &str) -> Option<String> {
    let app = app?;
    if !newer(app, cli.split('+').next().unwrap_or(cli)) {
        return None;
    }
    let how = if path.contains("/dist/tramecli") {
        "`just setup`"
    } else {
        "https://github.com/Andarius/trame/releases/latest"
    };
    Some(format!(
        "a new tramecli is available: {app} (you have {cli}) — {how}"
    ))
}
async fn warn_if_stale() {
    let path = env::var_os("TRACKER_PORT_FILE")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            env::var_os("TRAME_LOCAL_DIR")
                .map(|root| std::path::PathBuf::from(root).join("port.json"))
        })
        .unwrap_or_else(|| target::data_file("TRACKER_PORT_FILE", "port.json"));
    let Some(port) = fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v["port"].as_u64())
    else {
        return;
    };
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return;
    };
    let Ok(response) = client
        .get(format!("http://127.0.0.1:{port}/api/status"))
        .send()
        .await
    else {
        return;
    };
    let Ok(value) = response.json::<Value>().await else {
        return;
    };
    let path = env::current_exe().unwrap_or_default();
    if let Some(line) = stale_warning(
        &help::version(),
        value["version"].as_str(),
        &path.to_string_lossy(),
    ) {
        eprintln!("{line}");
    }
}
pub async fn run(args: &[String]) -> Result<i32> {
    let Some(command) = args.first().map(String::as_str) else {
        println!("{}", help::topic("OVERVIEW"));
        return Ok(0);
    };
    let raw = &args[1..];
    let json_out = raw.iter().any(|a| a == "--json");
    let rest = raw
        .iter()
        .filter(|s| s.as_str() != "--json")
        .cloned()
        .collect::<Vec<_>>();
    let wants_help = rest.iter().any(|s| s == "--help" || s == "-h");
    let topic = match command {
        "track" => Some("TRACK_HELP"),
        "page" => Some("PAGE_HELP"),
        "comment" => Some("COMMENT_HELP"),
        "presence" => Some("PRESENCE_HELP"),
        "show" => Some("SHOW_HELP"),
        "list" => Some("LIST_HELP"),
        "due" => Some("DUE_HELP"),
        "stories" => Some("STORIES_HELP"),
        "convert" => Some("CONVERT_HELP"),
        "archive" => Some("ARCHIVE_HELP"),
        "move" => Some("MOVE_HELP"),
        "open" => Some("OPEN_HELP"),
        "setup" => Some("SETUP_HELP"),
        "plugins" => Some("PLUGINS_HELP"),
        "deployments" => Some("DEPLOYMENTS_HELP"),
        "db" => Some("UDB_CONTRACT"),
        "query" => Some("QUERY_SYNTAX"),
        _ => None,
    };
    if !wants_help
        && matches!(
            command,
            "track"
                | "page"
                | "comment"
                | "presence"
                | "show"
                | "watch"
                | "answer"
                | "list"
                | "due"
                | "convert"
                | "mcp"
                | "db"
                | "deployments"
        )
    {
        warn_if_stale().await;
    }
    if matches!(command, "-h" | "--help") {
        println!("{}", help::topic("OVERVIEW"));
        return Ok(0);
    }
    if command == "help" {
        let topic = rest.first().and_then(|name| match name.as_str() {
            "track" => Some("TRACK_HELP"),
            "page" => Some("PAGE_HELP"),
            "comment" => Some("COMMENT_HELP"),
            "presence" => Some("PRESENCE_HELP"),
            "show" => Some("SHOW_HELP"),
            "list" => Some("LIST_HELP"),
            "due" => Some("DUE_HELP"),
            "stories" => Some("STORIES_HELP"),
            "convert" => Some("CONVERT_HELP"),
            "archive" => Some("ARCHIVE_HELP"),
            "move" => Some("MOVE_HELP"),
            "open" => Some("OPEN_HELP"),
            "setup" => Some("SETUP_HELP"),
            "plugins" => Some("PLUGINS_HELP"),
            "deployments" => Some("DEPLOYMENTS_HELP"),
            "db" => Some("UDB_CONTRACT"),
            "query" => Some("QUERY_SYNTAX"),
            _ => None,
        });
        println!("{}", help::topic(topic.unwrap_or("OVERVIEW")));
        return Ok(0);
    }
    if command == "-V" || command == "--version" {
        println!("{}", help::version());
        return Ok(0);
    }
    if command == "query" {
        println!("{}", help::topic("QUERY_SYNTAX"));
        return Ok(0);
    }
    if command == "hook" {
        if wants_help {
            println!(
                "Usage: tramecli hook\n\nClaude Code UserPromptSubmit map hook; reads hook JSON on stdin."
            );
        } else {
            claude_hook::run();
        }
        return Ok(0);
    }
    if let Some(topic) = topic {
        if wants_help
            || command == "db" && rest.is_empty()
            || command == "deployments" && rest.is_empty()
        {
            println!("{}", help::topic(topic));
            return Ok(0);
        }
    }
    match command {
        "track" => track::main(&rest, json_out).await?,
        "page" => {
            let input = read_json_input(&rest).await?;
            page::validate(&input)?;
            page::main(&input, &resolve_target().await?).await?;
        }
        "comment" => {
            let input = read_json_input(&rest).await?;
            comment::validate(&input)?;
            comment::main(&input, &resolve_target().await?).await?;
        }
        "presence" => presence::main(&rest).await?,
        "show" => board::show(&rest, json_out, &resolve_target().await?).await?,
        "watch" => watch::watch_main(&rest).await?,
        "answer" => watch::answer_main(&rest).await?,
        "list" => board::list(&rest, json_out, &resolve_target().await?).await?,
        "due" => due::main(&rest, json_out, &resolve_target().await?).await?,
        "stories" => board::stories(&rest, json_out, &resolve_target().await?).await?,
        "convert" => board::convert(&rest, json_out, &resolve_target().await?).await?,
        "archive" => board::archive(&rest, json_out, &resolve_target().await?).await?,
        "move" => board::move_page(&rest, json_out, &resolve_target().await?).await?,
        "db" => db::main(&rest, json_out, &resolve_target().await?).await?,
        "deployments" => deployments::main(&rest, json_out, &resolve_target().await?).await?,
        "open" => return open::main(&rest).await,
        "setup" => return setup::run(&rest),
        "plugins" => return plugins::main(&rest),
        "mcp" => mcp::serve().await?,
        other => {
            if let Some(code) = plugin_cmd::run(other, &rest, json_out).await? {
                return Ok(code);
            }
            eprintln!("unknown command: {other}\n\n{}", help::topic("OVERVIEW"));
            return Ok(2);
        }
    }
    Ok(0)
}
