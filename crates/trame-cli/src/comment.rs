use crate::{page::resolve_by_title, target::Target};
use anyhow::{Result, bail};
use serde_json::{Value, json};
use trame_core::todo_marks::strip_marks;

pub fn resolve_agent(input: &Value) -> String {
    input["agent"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| {
            if std::env::var("CODEX_THREAD_ID")
                .ok()
                .is_some_and(|s| !s.is_empty())
            {
                "codex"
            } else {
                "claude"
            }
            .into()
        })
}
fn nonempty<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input[key].as_str().filter(|s| !s.is_empty())
}
pub fn validate(input: &Value) -> Result<String> {
    if nonempty(input, "body").is_none_or(|s| s.trim().is_empty()) {
        bail!("body is required");
    }
    if nonempty(input, "page_id").is_some() == nonempty(input, "page_title").is_some() {
        bail!("use exactly one of page_id or page_title");
    }
    if nonempty(input, "block_id").is_some() && nonempty(input, "block_text").is_some() {
        bail!("use block_id or block_text, not both");
    }
    let agent = resolve_agent(input);
    if input["meta"]["model"]
        .as_str()
        .is_none_or(|s| s.trim().is_empty())
    {
        bail!(
            "meta.model is required — the exact model id you run as (e.g. claude-opus-5, gpt-5.6-sol)"
        );
    }
    if matches!(agent.as_str(), "claude" | "codex") {
        for key in ["in", "out", "ms"] {
            if !input["meta"][key].is_number() {
                let label = if key == "ms" {
                    "elapsed time in ms".into()
                } else {
                    format!("{key}put tokens")
                };
                bail!(
                    "meta.{key} is required for {agent} — pass the run's own {label}, measured not guessed"
                );
            }
        }
    }
    Ok(agent)
}
pub fn resolve_block(content: &Value, input: &Value) -> Result<Value> {
    let blocks: Vec<_> = content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|b| {
            matches!(b["type"].as_str(), Some("text" | "heading" | "todo"))
                && b["id"].is_string()
                && b["text"].is_string()
        })
        .collect();
    if let Some(id) = nonempty(input, "block_id") {
        let found = blocks
            .iter()
            .find(|b| b["id"] == id)
            .ok_or_else(|| anyhow::anyhow!("block_id \"{id}\" was not found"))?;
        return Ok(json!({"id":found["id"],"text":found["text"]}));
    }
    let want = nonempty(input, "block_text")
        .map(|s| strip_marks(s).trim().to_owned())
        .unwrap_or_default();
    if !want.is_empty() {
        let exact: Vec<_> = blocks
            .iter()
            .filter(|b| strip_marks(b["text"].as_str().unwrap()).trim() == want)
            .collect();
        let found: Vec<_> = if exact.is_empty() {
            blocks
                .iter()
                .filter(|b| strip_marks(b["text"].as_str().unwrap()).contains(&want))
                .collect()
        } else {
            exact
        };
        return match found.len() {
            1 => Ok(json!({"id":found[0]["id"],"text":found[0]["text"]})),
            0 => bail!("block_text \"{want}\" was not found"),
            _ => bail!("block_text \"{want}\" matches multiple blocks; use block_id"),
        };
    }
    if blocks.len() == 1 {
        return Ok(json!({"id":blocks[0]["id"],"text":blocks[0]["text"]}));
    }
    let choices = blocks
        .iter()
        .take(8)
        .map(|b| {
            let text = b["text"]
                .as_str()
                .unwrap()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            format!(
                "{}: {}",
                b["id"].as_str().unwrap(),
                text.chars().take(80).collect::<String>()
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    if choices.is_empty() {
        bail!("block_id or unique block_text is required (page has no commentable blocks)");
    }
    bail!("block_id or unique block_text is required:\n{choices}")
}
pub async fn add_comment(input: &Value, target: &Target) -> Result<Value> {
    let agent = validate(input)?;
    let page_id = if let Some(id) = nonempty(input, "page_id") {
        id.into()
    } else {
        resolve_by_title(target, nonempty(input, "page_title").unwrap(), "page").await?
    };
    let page = target.get(&format!("/api/pages/{page_id}")).await?;
    let block = resolve_block(&page["content"], input)?;
    if let Some(reply) = nonempty(input, "in_reply_to") {
        target
            .post(
                &format!("/api/comments/{reply}/agent-status"),
                &json!({"status":"answering","agent":agent}),
            )
            .await?;
    }
    let res = target
        .post(
            "/api/comments",
            &json!({
                "page_id":page["id"], "block_id":block["id"], "anchor":block["text"],
                "body":input["body"].as_str().unwrap().trim(), "agent":agent, "meta":input["meta"]
            }),
        )
        .await?;
    if let Some(reply) = nonempty(input, "in_reply_to") {
        if let Err(error) = target
            .post(
                &format!("/api/comments/{reply}/agent-status"),
                &json!({"status":"answered","agent":agent}),
            )
            .await
        {
            eprintln!("warning: reply posted but marking answered failed: {error}");
        }
    }
    Ok(json!({"id":res["id"],"agent":agent,"page":{"id":page["id"],"title":page["title"]}}))
}
pub async fn main(input: &Value, target: &Target) -> Result<()> {
    let res = add_comment(input, target).await?;
    let id = res["id"].as_str().unwrap_or("");
    let agent = res["agent"].as_str().unwrap_or("");
    let page = &res["page"];
    println!(
        "ok: {agent} comment {id} added to Trame ({}){}",
        page["title"].as_str().unwrap_or(""),
        target.app_link(&format!("page={}", page["id"].as_str().unwrap_or("")))
    );
    Ok(())
}
