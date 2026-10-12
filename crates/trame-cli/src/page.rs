use crate::target::Target;
use anyhow::{Result, bail};
use chrono::Local;
use serde_json::{Value, json};
use std::{collections::HashSet, env, fs};
use trame_core::{
    page_markdown::markdown_to_page_blocks, page_merge::merge_page_blocks,
    todo_marks::stamp_todo_marks,
};

fn field<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}
fn present(input: &Value, key: &str) -> bool {
    input.get(key).is_some()
}
pub(crate) fn validate(input: &Value) -> Result<()> {
    if present(input, "markdown") && field(input, "markdown_file").is_some() {
        bail!("use markdown or markdown_file, not both");
    }
    if field(input, "page_id").is_some() && field(input, "page_title").is_some() {
        bail!("use page_id or page_title, not both");
    }
    if field(input, "session_id").is_some() {
        if field(input, "page_id").is_some()
            || field(input, "page_title").is_some()
            || present(input, "parent_id")
            || field(input, "parent_title").is_some()
        {
            bail!("session_id is exclusive with page/parent targets");
        }
        if !present(input, "markdown") && field(input, "markdown_file").is_none() {
            bail!("session_id requires markdown or markdown_file");
        }
    } else if field(input, "page_id").is_some() || field(input, "page_title").is_some() {
        if present(input, "parent_id") || field(input, "parent_title").is_some() {
            bail!("cannot reparent on update; use trame_move_page");
        }
        if !present(input, "markdown") && field(input, "markdown_file").is_none() {
            bail!("update requires markdown or markdown_file");
        }
    } else {
        if field(input, "title").is_none_or(|s| s.trim().is_empty()) {
            bail!("title is required");
        }
        if present(input, "parent_id") && field(input, "parent_title").is_some() {
            bail!("use parent_id or parent_title, not both");
        }
    }
    Ok(())
}
pub async fn resolve_by_title(target: &Target, title: &str, role: &str) -> Result<String> {
    let pages = target.get("/api/pages").await?;
    let matches: Vec<_> = pages
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p["title"] == title)
        .collect();
    if matches.len() != 1 {
        if matches.is_empty() {
            bail!(
                "{} \"{}\" was not found",
                if role == "parent" {
                    "parent page"
                } else {
                    "page"
                },
                title
            );
        }
        bail!("{role}_title \"{title}\" is ambiguous; use {role}_id");
    }
    Ok(matches[0]["id"].as_str().unwrap_or_default().into())
}
fn markdown(input: &Value) -> Result<String> {
    if let Some(path) = field(input, "markdown_file") {
        return Ok(fs::read_to_string(path)?);
    }
    Ok(field(input, "markdown").unwrap_or("").into())
}
fn block_id(v: &Value) -> Option<&str> {
    if matches!(v["type"].as_str(), Some("text" | "heading" | "todo")) {
        v["id"].as_str()
    } else {
        None
    }
}
pub async fn write_page(input: &Value, target: &Target) -> Result<Value> {
    validate(input)?;
    let mut page_id = field(input, "page_id").map(str::to_owned);
    if let Some(session) = field(input, "session_id") {
        let res = target
            .post(&format!("/api/sessions/{session}/specs-page"), &json!({}))
            .await?;
        page_id = Some(
            res["page_id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| anyhow::anyhow!("specs-page response is missing page_id"))?
                .to_owned(),
        );
    } else if let Some(title) = field(input, "page_title") {
        page_id = Some(resolve_by_title(target, title, "page").await?);
    }
    if let Some(id) = page_id {
        let page = target.get(&format!("/api/pages/{id}")).await?;
        let title = field(input, "title")
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or_else(|| page["title"].as_str())
            .unwrap_or("")
            .to_owned();
        let old = page["content"].as_array().cloned().unwrap_or_default();
        let parsed =
            markdown_to_page_blocks(&markdown(input)?, &title, None).map_err(anyhow::Error::msg)?;
        let merged = merge_page_blocks(&old, &parsed);
        let day = Local::now().format("%Y-%m-%d").to_string();
        let content = stamp_todo_marks(&merged, &day);
        let old_ids: HashSet<_> = old.iter().filter_map(block_id).collect();
        let kept = content
            .iter()
            .filter_map(block_id)
            .filter(|id| old_ids.contains(id))
            .count();
        let mut body = json!({"content":content});
        if field(input, "title").is_some() {
            body["title"] = json!(title);
        }
        if present(input, "icon") {
            body["icon"] = input["icon"].clone();
        }
        target.post(&format!("/api/pages/{id}"), &body).await?;
        return Ok(
            json!({"action":"updated","id":id,"title":title,"kept":kept,"total":old_ids.len()}),
        );
    }
    let title = field(input, "title")
        .ok_or_else(|| anyhow::anyhow!("title is required"))?
        .trim();
    let parsed =
        markdown_to_page_blocks(&markdown(input)?, title, None).map_err(anyhow::Error::msg)?;
    let day = Local::now().format("%Y-%m-%d").to_string();
    let content = stamp_todo_marks(&parsed, &day);
    let mut body = json!({"title":title,"kind":"page","icon":input.get("icon").unwrap_or(&Value::Null),"content":content});
    if present(input, "parent_id") {
        body["parent_id"] = input["parent_id"].clone();
    } else if let Some(parent) = field(input, "parent_title") {
        body["parent_id"] = json!(resolve_by_title(target, parent, "parent").await?);
    } else {
        body["repo_path"] = json!(field(input, "repo_path").map(str::to_owned).unwrap_or_else(
            || {
                env::current_dir()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            }
        ));
    }
    let response = target.post("/api/pages", &body).await?;
    let id = response["id"].as_str().unwrap_or_default();
    let pages = target.get("/api/pages").await?;
    let rows = pages.as_array().cloned().unwrap_or_default();
    let parent_id = rows
        .iter()
        .find(|p| p["id"] == id)
        .map(|p| &p["parent_id"])
        .unwrap_or(&Value::Null);
    let parent = rows
        .iter()
        .find(|p| p["id"] == *parent_id)
        .and_then(|p| p["title"].as_str())
        .unwrap_or("Unfiled");
    Ok(json!({"action":"created","id":id,"title":title,"parent":parent}))
}

pub async fn main(input: &Value, target: &Target) -> Result<()> {
    let result = write_page(input, target).await?;
    let id = result["id"].as_str().unwrap_or("");
    let title = result["title"].as_str().unwrap_or("");
    if result["action"] == "created" {
        println!(
            "ok: page {id} created in Trame ({title}) — filed under {}{}",
            result["parent"].as_str().unwrap_or("Unfiled"),
            target.app_link(&format!("page={id}"))
        );
    } else {
        println!(
            "ok: page {id} updated in Trame ({title}) — kept {} of {} block ids{}",
            result["kept"],
            result["total"],
            target.app_link(&format!("page={id}"))
        );
    }
    Ok(())
}
