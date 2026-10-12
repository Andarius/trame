use crate::target::{Target, resolve_target};
use anyhow::{Result, bail};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::{
    collections::{HashMap, HashSet},
    env,
    path::PathBuf,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::AsyncWriteExt,
    process::Command,
    time::{sleep, timeout},
};

const AGENT_AUTHOR_ID: &str = "00000000-0000-4000-8000-0000000000aa";
static WARNED_SELECTORS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));
static CODEX_MODELS: LazyLock<Mutex<HashMap<PathBuf, Option<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const WATCH_USAGE: &str = "Waits for human feedback on a Trame page, then exits (0 = feedback ready).\n\nUsage: tramecli watch --page <id-or-title[,…]> [options]\n\nOptions:\n  --page P,P       pages to watch, by id or exact title, subpages included\n  --agent ID       answer as this agent (default: claude)\n  --interval SECS  poll + presence heartbeat cadence (default: 10, keep < 20)\n  --quiet SECS     required quiet period after the last human comment (default: 45)\n  --stale SECS     re-surface stuck \"answering…\" after this long (default: 600)\n  -h, --help       show this help";
const ANSWER_USAGE: &str = "Answers human replies on agent comment threads in Trame.\n\nUsage: tramecli answer [options]\n\nOptions:\n  --agents a,b       only answer these agents (default: all runnable)\n  --page P,P         only these pages + their subtrees\n  --model ID         model for built-in codex/claude runners\n  --force-agent ID   answer every thread as this agent\n  --interval SECS    poll interval (default: 5)\n  --stale SECS       re-surface stuck answering after this long (default: 600)\n  --once             single pass, then exit\n  --dry-run          print prompts instead of running agents\n  --cwd DIR          working directory for the agent CLI\n  -h, --help         show this help\n\nCustom agents need TRAME_WATCH_<AGENT>_CMD ({} = prompt, else stdin).\nTRAME_WATCH_TIMEOUT caps a run in seconds (default: 300).";
fn csv(input: &str) -> Vec<String> {
    input
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}
fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .rposition(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}
fn validate_flags(args: &[String], values: &[&str], switches: &[&str]) -> Result<()> {
    let mut i = 0;
    while i < args.len() {
        if values.contains(&args[i].as_str()) {
            if i + 1 >= args.len() {
                bail!("{} needs a value", args[i]);
            }
            i += 2;
        } else if switches.contains(&args[i].as_str()) {
            i += 1;
        } else {
            bail!("unknown flag: {}", args[i]);
        }
    }
    Ok(())
}
fn parse_num(args: &[String], name: &str, default: f64) -> f64 {
    flag(args, name)
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}
async fn status(target: &Target, id: &str, state: &str, agent: &str) -> Result<()> {
    target
        .post(
            &format!("/api/comments/{id}/agent-status"),
            &json!({"status":state,"agent":agent}),
        )
        .await?;
    Ok(())
}
pub async fn resolve_pages(
    target: &Target,
    selectors: &HashSet<String>,
) -> Result<HashSet<String>> {
    let pages = target.get("/api/pages").await?;
    let pages = pages.as_array().cloned().unwrap_or_default();
    let mut out = HashSet::new();
    for selector in selectors {
        let lower = selector.to_lowercase();
        let mut found = false;
        for page in &pages {
            if page["id"] == selector.as_str()
                || page["title"]
                    .as_str()
                    .is_some_and(|s| s.trim().to_lowercase() == lower)
            {
                if let Some(id) = page["id"].as_str() {
                    out.insert(id.to_owned());
                    found = true;
                }
            }
        }
        if !found
            && WARNED_SELECTORS
                .lock()
                .is_ok_and(|mut warned| warned.insert(selector.clone()))
        {
            eprintln!("--page \"{selector}\" matches no page (by id or title)");
        }
    }
    loop {
        let before = out.len();
        for page in &pages {
            if page["parent_id"]
                .as_str()
                .is_some_and(|id| out.contains(id))
            {
                if let Some(id) = page["id"].as_str() {
                    out.insert(id.into());
                }
            }
        }
        if out.len() == before {
            break;
        }
    }
    Ok(out)
}
pub fn build_prompt(item: &Value, agent: &str) -> String {
    let who = match agent.trim().to_lowercase().as_str() {
        "codex" => "Codex".into(),
        "claude" => "Claude".into(),
        "glm" => "GLM".into(),
        other if other.chars().count() <= 4 => other.to_uppercase(),
        other => {
            let mut chars = other.chars();
            format!(
                "{}{}",
                chars.next().unwrap_or_default().to_uppercase(),
                chars.as_str()
            )
        }
    };
    let title = item["page"]["title"].as_str().unwrap_or("");
    let block = item["block"]["text"].as_str().unwrap_or("");
    let thread = item["thread"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| {
            let mine = if c["author_id"] == AGENT_AUTHOR_ID {
                " (you)"
            } else {
                ""
            };
            format!(
                "[{}{}] {}",
                c["author"].as_str().unwrap_or(""),
                mine,
                c["body"].as_str().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "You are {who}. You left a review comment on the Trame page \"{title}\".\nA human replied; write your answer as the next comment in the thread.\n\nBlock under discussion:\n> {block}\n\nThread (oldest first):\n{thread}\n\nAnswer the last human message. Be concise (a few sentences), plain text for a\nsmall comment box. Output ONLY the comment body — no preamble, no markdown headings."
    )
}
pub fn tokenize(command: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut started = false;
    let mut chars = command.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '"' || ch == '\'' {
            started = true;
            for next in chars.by_ref() {
                if next == ch {
                    break;
                } else {
                    current.push(next)
                }
            }
        } else if ch.is_whitespace() {
            if started || !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            started = false;
        } else {
            current.push(ch);
        }
    }
    if started || !current.is_empty() {
        tokens.push(current);
    }
    tokens
}
pub fn has_command(agent: &str) -> bool {
    matches!(agent, "codex" | "claude")
        || env::var_os(format!("TRAME_WATCH_{}_CMD", agent.to_uppercase())).is_some()
}
pub struct AgentCommand {
    pub cmd: String,
    pub args: Vec<String>,
    pub stdin: Option<String>,
}
pub fn agent_command(agent: &str, prompt: &str, model: Option<&str>) -> Result<AgentCommand> {
    if let Ok(override_cmd) = env::var(format!("TRAME_WATCH_{}_CMD", agent.to_uppercase())) {
        let parts = tokenize(&override_cmd)
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>();
        if parts.is_empty() {
            bail!("empty command override for {agent}");
        }
        let slot = parts.iter().any(|s| s == "{}");
        return Ok(AgentCommand {
            cmd: parts[0].clone(),
            args: parts[1..]
                .iter()
                .map(|s| if s == "{}" { prompt.into() } else { s.clone() })
                .collect(),
            stdin: if slot { None } else { Some(prompt.into()) },
        });
    }
    let model_args = model
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| vec!["--model".into(), s.into()])
        .unwrap_or_default();
    match agent {
        "codex" => {
            let mut args = vec![
                "exec".into(),
                "--json".into(),
                "--sandbox".into(),
                "read-only".into(),
            ];
            args.extend(model_args);
            args.push(prompt.into());
            Ok(AgentCommand {
                cmd: "codex".into(),
                args,
                stdin: None,
            })
        }
        "claude" => {
            let mut args = vec![
                "-p".into(),
                prompt.into(),
                "--output-format".into(),
                "json".into(),
            ];
            args.extend(model_args);
            Ok(AgentCommand {
                cmd: "claude".into(),
                args,
                stdin: None,
            })
        }
        other => bail!(
            "no command for agent \"{other}\" — set TRAME_WATCH_{}_CMD",
            other.to_uppercase()
        ),
    }
}
pub fn parse_codex_doctor_model(output: &str) -> Option<String> {
    let value: Value = serde_json::from_str(output).ok()?;
    value["checks"]["config.load"]["details"]["model"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().into())
}
pub fn parse_agent_output(
    agent: &str,
    output: &str,
    ms: i64,
    fallback_model: Option<&str>,
) -> Value {
    if agent == "codex" {
        let mut saw = false;
        let mut body = String::new();
        let mut model = None;
        let mut usage = Value::Null;
        for line in output.lines() {
            let Ok(event) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let Some(kind) = event["type"].as_str() else {
                continue;
            };
            if !matches!(
                kind,
                "thread.started" | "turn.started" | "turn.completed" | "turn.failed" | "error"
            ) && !kind.starts_with("item.")
            {
                continue;
            }
            saw = true;
            for candidate in [
                &event["model"],
                &event["model_id"],
                &event["model_name"],
                &event["item"]["model"],
                &event["metadata"]["model"],
            ] {
                if let Some(value) = candidate.as_str().filter(|s| !s.trim().is_empty()) {
                    model = Some(value.to_owned());
                    break;
                }
            }
            if kind == "item.completed" && event["item"]["type"] == "agent_message" {
                if let Some(text) = event["item"]["text"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                {
                    body = text.trim().into();
                }
            }
            if kind == "turn.completed" && event["usage"].is_object() {
                usage = event["usage"].clone();
            }
        }
        if saw {
            let mut meta = json!({"model":model.or_else(||fallback_model.map(str::to_owned)).unwrap_or_else(||"codex".into()),"ms":ms});
            if usage["input_tokens"].is_number() {
                meta["in"] = usage["input_tokens"].clone();
            }
            if usage["output_tokens"].is_number() {
                meta["out"] = usage["output_tokens"].clone();
            }
            return json!({"body":body,"meta":meta});
        }
    }
    if let Ok(value) = serde_json::from_str::<Value>(output) {
        if let Some(body) = value["result"].as_str().filter(|s| !s.trim().is_empty()) {
            let usage = &value["usage"];
            let input = [
                "input_tokens",
                "cache_read_input_tokens",
                "cache_creation_input_tokens",
            ]
            .iter()
            .map(|key| usage[key].as_i64().unwrap_or(0))
            .sum::<i64>();
            let model = value["modelUsage"]
                .as_object()
                .and_then(|m| m.keys().next());
            let mut meta = json!({"ms":value["duration_ms"].as_i64().unwrap_or(ms)});
            if let Some(model) = model {
                meta["model"] = json!(model);
            }
            if input > 0 {
                meta["in"] = json!(input);
            }
            if usage["output_tokens"].is_number() {
                meta["out"] = usage["output_tokens"].clone();
            }
            return json!({"body":body.trim(),"meta":meta});
        }
    }
    json!({"body":output,"meta":{"model":fallback_model.unwrap_or(agent),"ms":ms}})
}
async fn run_agent(
    agent: &str,
    prompt: &str,
    cwd: Option<&str>,
    model: Option<&str>,
) -> Result<Value> {
    let command = agent_command(agent, prompt, model)?;
    let mut process = Command::new(&command.cmd);
    process
        .args(&command.args)
        .stdin(if command.stdin.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if let Some(cwd) = cwd {
        process.current_dir(cwd);
    }
    #[cfg(unix)]
    process.as_std_mut().process_group(0);
    let duration = env::var("TRAME_WATCH_TIMEOUT")
        .ok()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(300.0);
    let started = Instant::now();
    process.kill_on_drop(true);
    let mut child = process.spawn()?;
    let child_pid = child.id();
    if let Some(stdin) = command.stdin {
        if let Some(mut writer) = child.stdin.take() {
            writer.write_all(stdin.as_bytes()).await?;
        }
    }
    let output = match timeout(
        Duration::from_secs_f64(duration.max(0.001)),
        child.wait_with_output(),
    )
    .await
    {
        Ok(output) => output?,
        Err(error) => {
            #[cfg(unix)]
            if let Some(pid) = child_pid {
                unsafe {
                    libc::killpg(pid as i32, libc::SIGKILL);
                }
            }
            return Err(error.into());
        }
    };
    if !output.status.success() {
        bail!(
            "{} exited {}: {}",
            command.cmd,
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stderr)
                .trim()
                .chars()
                .take(500)
                .collect::<String>()
        );
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if text.is_empty() {
        bail!("{} produced no output", command.cmd);
    }
    let fallback = command
        .args
        .windows(2)
        .find(|pair| pair[0] == "--model" || pair[0] == "-m")
        .map(|pair| pair[1].as_str());
    let mut result =
        parse_agent_output(agent, &text, started.elapsed().as_millis() as i64, fallback);
    if result["body"].as_str().is_none_or(|s| s.trim().is_empty()) {
        bail!("{} produced no answer text", command.cmd);
    }
    if agent == "codex"
        && result["meta"]["model"] == "codex"
        && PathBuf::from(&command.cmd)
            .file_name()
            .is_some_and(|s| s == "codex")
    {
        let key = cwd
            .map(PathBuf::from)
            .unwrap_or_else(|| env::current_dir().unwrap_or_default());
        let cached = CODEX_MODELS
            .lock()
            .ok()
            .and_then(|models| models.get(&key).cloned());
        if let Some(Some(model)) = cached.as_ref() {
            result["meta"]["model"] = json!(model);
        } else if cached.is_none() {
            let mut doctor = Command::new("codex");
            doctor
                .args(["doctor", "--json", "--summary"])
                .stdin(std::process::Stdio::null());
            doctor.kill_on_drop(true);
            if let Some(cwd) = cwd {
                doctor.current_dir(cwd);
            }
            let model =
                if let Ok(Ok(output)) = timeout(Duration::from_secs(15), doctor.output()).await {
                    parse_codex_doctor_model(&String::from_utf8_lossy(&output.stdout))
                } else {
                    None
                };
            if let Some(model) = &model {
                result["meta"]["model"] = json!(model);
            }
            if let Ok(mut models) = CODEX_MODELS.lock() {
                models.insert(key, model);
            }
        }
    }
    Ok(result)
}
async fn handle_answer(
    target: &Target,
    item: &Value,
    agent: &str,
    model: Option<&str>,
    cwd: Option<&str>,
    dry: bool,
    dry_logged: &mut HashSet<String>,
) -> Result<()> {
    let id = item["comment"]["id"].as_str().unwrap_or("");
    let prompt = build_prompt(item, agent);
    if dry {
        if dry_logged.insert(id.into()) {
            println!("[dry-run] would answer {id} as {agent}:\n{prompt}\n");
        }
        return Ok(());
    }
    status(target, id, "seen", agent).await?;
    status(target, id, "answering", agent).await?;
    let mut last_error = String::new();
    for attempt in 1..=3 {
        let result = match run_agent(agent, &prompt, cwd, model).await {
            Ok(result) => result,
            Err(error) => {
                last_error = error.to_string();
                eprintln!("attempt {attempt} for {id} failed: {error}");
                continue;
            }
        };
        let page = item["page"]["id"].as_str().unwrap_or("");
        let comments = target
            .get(&format!("/api/comments?page={}", url_encode(page)))
            .await
            .ok();
        let current = comments
            .as_ref()
            .and_then(Value::as_array)
            .and_then(|rows| rows.iter().find(|c| c["id"] == id))
            .and_then(|c| c["body"].as_str());
        if current != item["comment"]["body"].as_str() {
            println!("skipped {id}: reply changed during generation");
            return Ok(());
        }
        let body = json!({"page_id":page,"block_id":item["block"]["id"],"anchor":item["block"]["text"],
            "body":result["body"],"agent":agent,"meta":result["meta"]});
        if let Err(error) = target.post("/api/comments", &body).await {
            last_error = error.to_string();
            eprintln!("attempt {attempt} for {id} failed: {error}");
            continue;
        }
        if let Err(error) = status(target, id, "answered", agent).await {
            eprintln!("answered {id} but status set failed: {error}");
        }
        let elapsed = result["meta"]["ms"].as_f64().unwrap_or(0.0);
        let time = if elapsed > 0.0 {
            format!(" ({:.1}s)", elapsed / 1000.0)
        } else {
            String::new()
        };
        println!(
            "answered {id} on \"{}\" as {agent}{time}",
            item["page"]["title"].as_str().unwrap_or("")
        );
        return Ok(());
    }
    let _ = status(target, id, "failed", agent).await;
    eprintln!("gave up on {id}: {last_error}");
    Ok(())
}
fn url_encode(input: &str) -> String {
    let mut url = reqwest::Url::parse("http://localhost/").unwrap();
    url.query_pairs_mut().append_pair("q", input);
    url.query()
        .unwrap_or("")
        .trim_start_matches("q=")
        .to_owned()
}
fn configured_agents() -> HashSet<String> {
    let mut out = HashSet::from(["codex".into(), "claude".into()]);
    for (key, _) in env::vars() {
        if let Some(name) = key
            .strip_prefix("TRAME_WATCH_")
            .and_then(|s| s.strip_suffix("_CMD"))
        {
            out.insert(name.to_lowercase());
        }
    }
    out
}
async fn answer_pass(args: &[String], dry_logged: &mut HashSet<String>) -> Result<bool> {
    let Ok(target) = resolve_target().await else {
        eprintln!("Trame app not running and no hub reachable — waiting…");
        return Ok(false);
    };
    let selectors = flag(args, "--page").map(csv);
    let pages = if let Some(selectors) = selectors {
        match resolve_pages(&target, &selectors.into_iter().collect()).await {
            Ok(pages) => Some(pages),
            Err(error) => {
                eprintln!("pages unreachable: {error}");
                return Ok(false);
            }
        }
    } else {
        None
    };
    let force = flag(args, "--force-agent").map(|s| s.trim().to_lowercase());
    let allowed = flag(args, "--agents").map(|s| {
        csv(s)
            .into_iter()
            .map(|s| s.to_lowercase())
            .collect::<HashSet<_>>()
    });
    let agents = if let Some(force) = &force {
        HashSet::from([force.clone()])
    } else {
        allowed.clone().unwrap_or_else(configured_agents)
    };
    for agent in agents.iter().filter(|a| has_command(a)) {
        let body = if let Some(pages) = &pages {
            json!({"watcher":agent,"pages":pages})
        } else {
            json!({"watcher":agent})
        };
        let _ = target.post("/api/presence", &body).await;
    }
    let inbox = match target
        .get(&format!(
            "/api/comments/inbox?stale={}",
            parse_num(args, "--stale", 600.0)
        ))
        .await
    {
        Ok(value) => value,
        Err(error) => {
            eprintln!("inbox unreachable: {error}");
            return Ok(false);
        }
    };
    let mut skipped = HashSet::new();
    for item in inbox.as_array().into_iter().flatten() {
        if pages.as_ref().is_some_and(|pages| {
            !item["page"]["id"]
                .as_str()
                .is_some_and(|id| pages.contains(id))
        }) {
            continue;
        }
        let agent = force
            .clone()
            .unwrap_or_else(|| item["agent"].as_str().unwrap_or("").to_owned());
        if allowed.as_ref().is_some_and(|set| !set.contains(&agent)) {
            continue;
        }
        if !has_command(&agent) {
            skipped.insert(agent);
            continue;
        }
        handle_answer(
            &target,
            item,
            &agent,
            flag(args, "--model"),
            flag(args, "--cwd"),
            args.iter().any(|a| a == "--dry-run"),
            dry_logged,
        )
        .await?;
    }
    if !skipped.is_empty() {
        eprintln!(
            "no command for agent(s): {} — set TRAME_WATCH_<AGENT>_CMD",
            skipped.into_iter().collect::<Vec<_>>().join(", ")
        );
    }
    Ok(true)
}
pub async fn answer_main(args: &[String]) -> Result<()> {
    if args.iter().any(|a| a == "-h" || a == "--help") {
        println!("{ANSWER_USAGE}");
        return Ok(());
    }
    let accepted = [
        "--agents",
        "--page",
        "--model",
        "--force-agent",
        "--interval",
        "--stale",
        "--cwd",
    ];
    validate_flags(args, &accepted, &["--once", "--dry-run"])?;
    if let Some(force) = flag(args, "--force-agent") {
        if force.trim().is_empty() {
            bail!("--force-agent needs an agent id");
        }
    }
    let once = args.iter().any(|a| a == "--once");
    let mut logged = HashSet::new();
    if once {
        let _ = answer_pass(args, &mut logged).await?;
        return Ok(());
    }
    let agents = flag(args, "--force-agent")
        .map(|s| vec![s.trim().to_lowercase()])
        .or_else(|| flag(args, "--agents").map(csv))
        .unwrap_or_else(|| configured_agents().into_iter().collect());
    let agents = agents
        .into_iter()
        .filter(|a| has_command(a))
        .collect::<Vec<_>>();
    let interval = parse_num(args, "--interval", 5.0);
    println!(
        "watching Trame comments (agents: {}, every {interval}s)…",
        if agents.is_empty() {
            "none — set TRAME_WATCH_<AGENT>_CMD".into()
        } else {
            agents.join(",")
        }
    );
    let mut backoff = interval;
    loop {
        let okay = answer_pass(args, &mut logged).await?;
        backoff = if okay {
            interval
        } else {
            (backoff * 2.0).min(60.0)
        };
        sleep(Duration::from_secs_f64(backoff.max(0.001))).await;
    }
}
async fn last_human_activity(target: &Target, pages: &[String]) -> Result<i64> {
    let mut newest = 0;
    for page in pages {
        let comments = target
            .get(&format!("/api/comments?page={}", url_encode(page)))
            .await?;
        let comments = comments
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("comments response is not an array"))?;
        for comment in comments {
            if comment["author_id"] == AGENT_AUTHOR_ID {
                continue;
            }
            if let Some(at) = comment["updated_at"]
                .as_str()
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            {
                newest = newest.max(at.timestamp_millis());
            }
        }
    }
    Ok(newest)
}
pub async fn watch_main(args: &[String]) -> Result<()> {
    if args.iter().any(|a| a == "-h" || a == "--help") {
        println!("{WATCH_USAGE}");
        return Ok(());
    }
    validate_flags(
        args,
        &["--page", "--agent", "--interval", "--quiet", "--stale"],
        &[],
    )?;
    let pages = flag(args, "--page").map(csv).unwrap_or_default();
    if pages.is_empty() {
        bail!("no page to watch — pass --page <id-or-title>");
    }
    let agent = flag(args, "--agent")
        .unwrap_or("claude")
        .trim()
        .to_lowercase();
    let interval = parse_num(args, "--interval", 10.0);
    let quiet = parse_num(args, "--quiet", 45.0);
    let stale = parse_num(args, "--stale", 600.0);
    let mut pages = pages;
    if let Ok(target) = resolve_target().await {
        let resolved = resolve_pages(&target, &pages.into_iter().collect()).await?;
        if resolved.is_empty() {
            bail!("no page matched (by id or title)");
        }
        pages = resolved.into_iter().collect();
        pages.sort();
        if let Ok(presence) = target
            .get(&format!("/api/presence?page={}", url_encode(&pages[0])))
            .await
        {
            if presence
                .as_array()
                .into_iter()
                .flatten()
                .any(|p| p["id"] == format!("watcher:{agent}") && p["page_id"] == "*")
            {
                eprintln!(
                    "warning: a global {agent} watcher is running — both may answer the same thread"
                );
            }
        }
    }
    println!(
        "watching page(s) {} for {agent} feedback (every {interval}s, quiet {quiet}s)…",
        pages.join(",")
    );
    let mut seen: HashSet<String> = HashSet::new();
    loop {
        if let Ok(target) = resolve_target().await {
            let result=async{
                target.post("/api/presence",&json!({"watcher":agent,"pages":pages})).await?;
                let inbox=target.get(&format!("/api/comments/inbox?page={}&mode=all&stale={stale}",pages.join(","))).await?;
                let mine=inbox.as_array().into_iter().flatten().filter(|item|item["agent"]==agent).collect::<Vec<_>>();
                if !mine.is_empty(){
                    for item in &mine{
                        let id=item["comment"]["id"].as_str().unwrap_or("");
                        if seen.insert(id.into()){let _=status(&target,id,"seen",&agent).await;}
                    }
                    let elapsed=Utc::now().timestamp_millis()-last_human_activity(&target,&pages).await?;
                    if elapsed as f64>quiet*1000.0{
                        for item in &mine{
                            let id=item["comment"]["id"].as_str().unwrap_or("");
                            let _=status(&target,id,"answering",&agent).await;
                        }
                        let pending=mine.iter().map(|item|json!({"comment_id":item["comment"]["id"],
                            "page":item["page"],"block_id":item["block"]["id"],"body":item["comment"]["body"]})).collect::<Vec<_>>();
                        println!("{} pending comment(s) — feedback ready:\n{}",mine.len(),serde_json::to_string_pretty(&pending)?);
                        return Ok::<bool,anyhow::Error>(true);
                    }
                    println!("{} pending, commenter still active ({}s ago) — waiting for quiet",mine.len(),((elapsed as f64)/1000.0).round());
                }
                Ok(false)
            }.await;
            match result {
                Ok(true) => return Ok(()),
                Ok(false) => {}
                Err(error) => eprintln!("pass failed: {error}"),
            }
        } else {
            eprintln!("Trame app not running and no hub reachable — waiting…");
        }
        sleep(Duration::from_secs_f64(interval.max(0.001))).await;
    }
}
