use super::{auth, encode, ships};
use anyhow::{Result, anyhow};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use std::collections::HashSet;

async fn get(client: &reqwest::Client, base: &str, auth: &auth::Auth, path: &str) -> Result<Value> {
    if auth.source == "cli" {
        let host = auth::hostname(base)?;
        let path = path.to_owned();
        return Ok(
            crate::blocking::spawn(move || auth::glab_api(&host, &path, None, None)).await??,
        );
    }
    let response = client
        .get(format!("{base}/api/v4/{path}"))
        .header("private-token", &auth.token)
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        return Err(anyhow!(
            "HTTP {status}{}",
            if status == 401 || status == 403 {
                " — check token/permissions"
            } else {
                ""
            }
        ));
    }
    Ok(response.json().await?)
}
pub async fn active_pipeline(
    client: &reqwest::Client,
    project: &str,
    base: &str,
    auth: &auth::Auth,
) -> Result<bool> {
    let proj = encode(project);
    let info = get(client, base, auth, &format!("projects/{proj}")).await?;
    let Some(branch) = info["default_branch"].as_str() else {
        return Ok(false);
    };
    let pipelines = get(
        client,
        base,
        auth,
        &format!(
            "projects/{proj}/pipelines?ref={}&per_page=1&order_by=updated_at&sort=desc",
            encode(branch)
        ),
    )
    .await?;
    Ok(pipelines
        .as_array()
        .and_then(|a| a.first())
        .and_then(|v| v["status"].as_str())
        .is_some_and(|s| {
            matches!(
                s,
                "created" | "waiting_for_resource" | "preparing" | "pending" | "running"
            )
        }))
}
pub async fn pending(
    client: &reqwest::Client,
    project: &str,
    base: &str,
    auth: &auth::Auth,
) -> Result<Vec<Value>> {
    let deployments = get(
        client,
        base,
        auth,
        &format!(
            "projects/{}/deployments?per_page=50&order_by=created_at&sort=desc",
            encode(project)
        ),
    )
    .await?;
    let (mut seen, mut out) = (HashSet::new(), Vec::new());
    for d in deployments.as_array().into_iter().flatten() {
        let env = d["environment"]["name"].as_str().unwrap_or("");
        if !seen.insert(env.to_owned()) {
            continue;
        }
        let raw = d["status"].as_str().unwrap_or("");
        let manual = d["deployable"]["status"] == "manual"
            && d["deployable"]["id"].as_i64().is_some_and(|n| n != 0);
        let (mut action, mut cancel) = (Value::Null, Value::Null);
        let status = if manual && matches!(raw, "blocked" | "created") {
            action = json!({"kind":"gitlab-play","project":project,"jobId":d["deployable"]["id"]});
            "waiting"
        } else if raw == "blocked" {
            action = json!({"kind":"gitlab-approve","project":project,"deploymentId":d["id"]});
            cancel = json!({"kind":"gitlab-reject","project":project,"deploymentId":d["id"]});
            "waiting"
        } else if matches!(raw, "running" | "created") {
            if d["deployable"]["id"].as_i64().is_some_and(|n| n != 0) {
                cancel =
                    json!({"kind":"gitlab-cancel","project":project,"jobId":d["deployable"]["id"]});
            }
            "running"
        } else if raw == "failed" {
            "failed"
        } else {
            continue;
        };
        let since = if status == "failed" {
            d["updated_at"].as_str().or(d["created_at"].as_str())
        } else {
            d["created_at"].as_str()
        }
        .unwrap_or("");
        if status == "failed"
            && DateTime::parse_from_rfc3339(since).ok().is_some_and(|t| {
                Utc::now().signed_duration_since(t).num_milliseconds() > 10_800_000
            })
        {
            continue;
        }
        let url = d["deployable"]["web_url"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| {
                if d["environment"]["id"].as_i64().is_some_and(|n| n != 0) {
                    format!("{base}/{project}/-/environments/{}", d["environment"]["id"])
                } else {
                    format!("{base}/{project}")
                }
            });
        out.push(json!({"source":"gitlab","repo":project,"environment":env,"ref":d["ref"],"sha":d["sha"],"title":d["deployable"]["name"].as_str().filter(|s|!s.is_empty()).map(str::to_owned).unwrap_or_else(||format!("deploy #{}",d["id"])),"requester":d["user"]["username"],"waitingSince":since,"url":url,"action":action,"cancel":cancel,"status":status}));
    }
    Ok(out)
}
async fn last_sha(
    client: &reqwest::Client,
    project: &str,
    base: &str,
    auth: &auth::Auth,
    environment: &str,
) -> Result<Option<String>> {
    let prev=get(client,base,auth,&format!("projects/{}/deployments?environment={}&status=success&order_by=created_at&sort=desc&per_page=1",encode(project),encode(environment))).await?;
    Ok(prev
        .as_array()
        .and_then(|a| a.first())
        .and_then(|v| v["sha"].as_str())
        .map(str::to_owned))
}
pub async fn shipped_mrs(
    client: &reqwest::Client,
    project: &str,
    base: &str,
    auth: &auth::Auth,
    environment: &str,
    sha: &str,
    pattern: &str,
) -> Result<Vec<Vec<i64>>> {
    let Some(old) = last_sha(client, project, base, auth, environment).await? else {
        return Ok(vec![]);
    };
    let proj = encode(project);
    let cmp = get(
        client,
        base,
        auth,
        &format!(
            "projects/{proj}/repository/compare?from={old}&to={}",
            encode(sha)
        ),
    )
    .await?;
    let mut out = Vec::new();
    for c in cmp["commits"].as_array().into_iter().flatten() {
        let nums = ships::ref_numbers(c["message"].as_str().unwrap_or(""), pattern);
        if !nums.is_empty() {
            out.push(nums);
        } else {
            let mrs = get(
                client,
                base,
                auth,
                &format!(
                    "projects/{proj}/repository/commits/{}/merge_requests",
                    c["id"].as_str().unwrap_or("")
                ),
            )
            .await?;
            out.push(
                mrs.as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|m| m["iid"].as_i64())
                    .collect(),
            );
        }
    }
    Ok(out)
}
pub async fn changelog(
    client: &reqwest::Client,
    project: &str,
    base: &str,
    auth: &auth::Auth,
    environment: &str,
    sha: &str,
) -> Result<Value> {
    let Some(old) = last_sha(client, project, base, auth, environment).await? else {
        return Ok(
            json!({"ok":false,"error":"no previous successful deployment to compare against"}),
        );
    };
    let cmp = get(
        client,
        base,
        auth,
        &format!(
            "projects/{}/repository/compare?from={old}&to={}",
            encode(project),
            encode(sha)
        ),
    )
    .await?;
    let mut commits=cmp["commits"].as_array().cloned().unwrap_or_default().iter().map(|c|json!({"sha":c["short_id"],"title":c["title"],"author":c["author_name"],"date":c["created_at"],"url":format!("{base}/{project}/-/commit/{}",c["id"].as_str().unwrap_or(""))})).collect::<Vec<_>>();
    commits.reverse();
    Ok(
        json!({"ok":true,"baseline":old.chars().take(8).collect::<String>(),"compareUrl":format!("{base}/{project}/-/compare/{old}...{sha}"),"commits":commits}),
    )
}
