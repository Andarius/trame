use super::ships;
use anyhow::{Result, anyhow};
use serde_json::{Value, json};

async fn gh(client: &reqwest::Client, path: &str, token: &str) -> Result<Value> {
    let response = client
        .get(format!("https://api.github.com{path}"))
        .bearer_auth(token)
        .header("accept", "application/vnd.github+json")
        .header("x-github-api-version", "2022-11-28")
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
pub async fn pending(client: &reqwest::Client, repo: &str, token: &str) -> Result<Vec<Value>> {
    let runs = gh(
        client,
        &format!("/repos/{repo}/actions/runs?status=waiting&per_page=50"),
        token,
    )
    .await?;
    let mut out = Vec::new();
    for run in runs["workflow_runs"].as_array().into_iter().flatten() {
        let pending = gh(
            client,
            &format!(
                "/repos/{repo}/actions/runs/{}/pending_deployments",
                run["id"]
            ),
            token,
        )
        .await?;
        for p in pending.as_array().into_iter().flatten() {
            let can = p["current_user_can_approve"] != false;
            out.push(json!({"source":"github","repo":repo,"environment":p["environment"]["name"],"ref":run["head_branch"],"sha":run["head_sha"],"title":run["display_title"],"requester":run["actor"]["login"],"waitingSince":run["updated_at"],"url":run["html_url"],"action":if can{json!({"kind":"github-approve","repo":repo,"runId":run["id"],"environmentId":p["environment"]["id"]})}else{Value::Null},"cancel":if can{json!({"kind":"github-reject","repo":repo,"runId":run["id"],"environmentId":p["environment"]["id"]})}else{Value::Null},"status":"waiting"}));
        }
    }
    Ok(out)
}
async fn compare(
    client: &reqwest::Client,
    repo: &str,
    environment: &str,
    sha: &str,
    token: &str,
) -> Result<Option<(String, Value)>> {
    let deps = gh(
        client,
        &format!(
            "/repos/{repo}/deployments?environment={}&per_page=20",
            super::encode(environment)
        ),
        token,
    )
    .await?;
    let base = deps
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|d| d["sha"].as_str())
        .find(|s| *s != sha)
        .map(str::to_owned);
    let Some(base) = base else { return Ok(None) };
    let cmp = gh(
        client,
        &format!("/repos/{repo}/compare/{base}...{sha}?per_page=100"),
        token,
    )
    .await?;
    Ok(Some((base, cmp)))
}
pub async fn changelog(
    client: &reqwest::Client,
    repo: &str,
    environment: &str,
    sha: &str,
    token: &str,
) -> Result<Value> {
    let Some((base, cmp)) = compare(client, repo, environment, sha, token).await? else {
        return Ok(json!({"ok":false,"error":"no previous deployment to compare against"}));
    };
    let mut commits=cmp["commits"].as_array().cloned().unwrap_or_default().iter().map(|c|json!({"sha":c["sha"].as_str().unwrap_or("").chars().take(7).collect::<String>(),"title":c["commit"]["message"].as_str().unwrap_or("").lines().next().unwrap_or(""),"author":c["author"]["login"].as_str().or(c["commit"]["author"]["name"].as_str()),"date":c["commit"]["author"]["date"],"url":c["html_url"]})).collect::<Vec<_>>();
    commits.reverse();
    Ok(
        json!({"ok":true,"baseline":base.chars().take(7).collect::<String>(),"compareUrl":cmp["html_url"],"commits":commits}),
    )
}
pub async fn shipped_prs(
    client: &reqwest::Client,
    repo: &str,
    environment: &str,
    sha: &str,
    token: &str,
    pattern: &str,
) -> Result<Vec<Vec<i64>>> {
    let Some((_, cmp)) = compare(client, repo, environment, sha, token).await? else {
        return Ok(vec![]);
    };
    let mut out = Vec::new();
    for c in cmp["commits"].as_array().into_iter().flatten() {
        let refs = ships::ref_numbers(c["commit"]["message"].as_str().unwrap_or(""), pattern);
        if !refs.is_empty() {
            out.push(refs);
        } else {
            let pulls = gh(
                client,
                &format!(
                    "/repos/{repo}/commits/{}/pulls",
                    c["sha"].as_str().unwrap_or("")
                ),
                token,
            )
            .await?;
            out.push(
                pulls
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|p| p["number"].as_i64())
                    .collect(),
            );
        }
    }
    Ok(out)
}
