use super::{
    STATE, auth, base_url, drop_item, encode, github, gitlab, hostname, key, login_command,
    settings, ships, strings,
};
use crate::{db::Db, routes::Native};
use anyhow::Result;
use serde_json::{Value, json};

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent("trame-local")
        .timeout(std::time::Duration::from_secs(20))
        .build()?)
}
async fn auths(slice: &Value, base: &str) -> Result<(auth::Auth, auth::Auth)> {
    let slice = slice.clone();
    let base = base.to_owned();
    Ok(
        crate::blocking::spawn(move || (auth::github(&slice), auth::gitlab(&slice, &base, true)))
            .await?,
    )
}
fn rank(item: &Value) -> u8 {
    match item["status"].as_str() {
        Some("failed") => 0,
        Some("waiting") => 1,
        _ => 2,
    }
}
pub async fn poll(state: &Native) -> Result<Value> {
    let slice = settings::plugin(&state.settings, "deployments");
    let repos = strings(&slice["githubRepos"]);
    let projects = strings(&slice["gitlabProjects"]);
    let base = base_url(&slice);
    let (gh, gl) = crate::blocking::spawn({
        let slice = slice.clone();
        let base = base.clone();
        let use_gh = !repos.is_empty();
        let use_gl = !projects.is_empty();
        move || {
            (
                if use_gh {
                    auth::github(&slice)
                } else {
                    auth::Auth {
                        token: String::new(),
                        source: "none",
                    }
                },
                if use_gl {
                    auth::gitlab(&slice, &base, true)
                } else {
                    auth::Auth {
                        token: String::new(),
                        source: "none",
                    }
                },
            )
        }
    })
    .await?;
    let client = client()?;
    let mut errors = Vec::new();
    let mut items = Vec::new();
    let mut active = false;
    if !repos.is_empty() && gh.token.is_empty() {
        errors.push(json!({"source":"github","error":"no token — set a PAT or log in with gh"}));
    } else {
        for repo in &repos {
            match github::pending(&client, repo, &gh.token).await {
                Ok(v) => items.extend(v),
                Err(e) => errors.push(json!({"source":repo,"error":e.to_string()})),
            }
        }
    }
    if !projects.is_empty() && gl.source == "none" {
        errors.push(json!({"source":"gitlab","error":"no token — set a PAT or log in with glab"}));
    } else {
        for project in &projects {
            match gitlab::pending(&client, project, &base, &gl).await {
                Ok(v) => items.extend(v),
                Err(e) => errors.push(json!({"source":project,"error":e.to_string()})),
            }
            active |= gitlab::active_pipeline(&client, project, &base, &gl)
                .await
                .unwrap_or(false);
        }
    }
    let mut refs = serde_json::Map::new();
    for item in &items {
        if item["status"] != "waiting" {
            continue;
        }
        let repo = item["repo"].as_str().unwrap_or("");
        let source = item["source"].as_str().unwrap_or("");
        let rule = ships::rule_for(&slice["ships"], repo, source);
        if rule["environments"]
            .as_array()
            .is_some_and(|a| !a.is_empty() && !a.contains(&item["environment"]))
        {
            continue;
        }
        let sha = item["sha"].as_str().or(item["ref"].as_str()).unwrap_or("");
        let env = item["environment"].as_str().unwrap_or("");
        let pattern = rule["pattern"].as_str().unwrap_or("");
        let got = if source == "github" {
            if gh.token.is_empty() {
                None
            } else {
                github::shipped_prs(&client, repo, env, sha, &gh.token, pattern)
                    .await
                    .ok()
            }
        } else if gl.source == "none" {
            None
        } else {
            gitlab::shipped_mrs(&client, repo, &base, &gl, env, sha, pattern)
                .await
                .ok()
        };
        if let Some(got) = got {
            refs.insert(item["url"].as_str().unwrap_or("").to_owned(), json!(got));
        }
    }
    let mut items = crate::blocking::spawn({
        let state = state.clone();
        let slice = slice.clone();
        move || -> Result<Vec<Value>> {
            let mut db = Db::connect(
                &state.root.join("socket"),
                &state.origin,
                Some(state.settings),
            )?;
            db.exclusive(|db| {
                ships::with_live_ships(db, &mut items, &slice, &Value::Object(refs))
            })?;
            Ok(items)
        }
    })
    .await??;
    items.sort_by(|a, b| {
        rank(a)
            .cmp(&rank(b))
            .then_with(|| a["waitingSince"].as_str().cmp(&b["waitingSince"].as_str()))
    });
    let stored = strings(&slice["ignored"]);
    for item in &mut items {
        item["ignored"] = json!(stored.contains(&key(item)));
    }
    if errors.is_empty() {
        let present = items
            .iter()
            .map(key)
            .collect::<std::collections::HashSet<_>>();
        let kept = stored
            .iter()
            .filter(|k| present.contains(*k))
            .cloned()
            .collect::<Vec<_>>();
        if kept.len() != stored.len() {
            settings::save_plugin(&state.settings, "deployments", &json!({"ignored":kept}))?;
        }
    }
    active |= items.iter().any(|i| i["status"] == "running");
    let value = json!({"configured":!repos.is_empty()||!projects.is_empty(),"items":items,"polledAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"errors":errors,"auth":{"github":gh.source,"gitlab":gl.source},"activePipeline":active});
    *STATE.lock().unwrap() = value.clone();
    Ok(value)
}
pub fn action_precondition(slice: &Value, action: &Value) -> Option<Value> {
    let kind = action["kind"].as_str().unwrap_or("");
    if matches!(kind, "github-approve" | "github-reject") {
        let repo = action["repo"].as_str().unwrap_or("");
        if !strings(&slice["githubRepos"]).contains(&repo.to_owned()) {
            return Some(json!({"ok":false,"error":"repo not in watch list"}));
        }
        if action["runId"].as_i64().is_none() || action["environmentId"].as_i64().is_none() {
            return Some(json!({"ok":false,"error":"bad action"}));
        }
        return None;
    }
    if matches!(
        kind,
        "gitlab-play" | "gitlab-approve" | "gitlab-reject" | "gitlab-cancel"
    ) {
        let project = action["project"].as_str().unwrap_or("");
        if !strings(&slice["gitlabProjects"]).contains(&project.to_owned()) {
            return Some(json!({"ok":false,"error":"project not in watch list"}));
        }
        let key = if matches!(kind, "gitlab-play" | "gitlab-cancel") {
            "jobId"
        } else {
            "deploymentId"
        };
        if action[key].as_i64().is_none() {
            return Some(json!({"ok":false,"error":"bad action"}));
        }
        return None;
    }
    Some(json!({"ok":false,"error":"unknown action"}))
}
async fn post_action(client: &reqwest::Client, slice: &Value, action: &Value) -> Result<Value> {
    if let Some(error) = action_precondition(slice, action) {
        return Ok(error);
    }
    let kind = action["kind"].as_str().unwrap_or("");
    if matches!(kind, "github-approve" | "github-reject") {
        let repo = action["repo"].as_str().unwrap_or("");
        if !strings(&slice["githubRepos"]).contains(&repo.to_owned()) {
            return Ok(json!({"ok":false,"error":"repo not in watch list"}));
        }
        let (Some(run), Some(env)) = (action["runId"].as_i64(), action["environmentId"].as_i64())
        else {
            return Ok(json!({"ok":false,"error":"bad action"}));
        };
        let gh = crate::blocking::spawn({
            let slice = slice.clone();
            move || auth::github(&slice)
        })
        .await?;
        if gh.token.is_empty() {
            return Ok(json!({"ok":false,"error":"no GitHub token"}));
        }
        let state = if kind == "github-approve" {
            "approved"
        } else {
            "rejected"
        };
        let response=client.post(format!("https://api.github.com/repos/{repo}/actions/runs/{run}/pending_deployments")).bearer_auth(gh.token).header("accept","application/vnd.github+json").json(&json!({"environment_ids":[env],"state":state,"comment":format!("{state} from Trame")})).send().await?;
        return Ok(if response.status().is_success() {
            json!({"ok":true})
        } else {
            json!({"ok":false,"error":http_error(response).await})
        });
    }
    if matches!(
        kind,
        "gitlab-play" | "gitlab-approve" | "gitlab-reject" | "gitlab-cancel"
    ) {
        let project = action["project"].as_str().unwrap_or("");
        if !strings(&slice["gitlabProjects"]).contains(&project.to_owned()) {
            return Ok(json!({"ok":false,"error":"project not in watch list"}));
        }
        let job = matches!(kind, "gitlab-play" | "gitlab-cancel");
        let Some(id) = action[if job { "jobId" } else { "deploymentId" }].as_i64() else {
            return Ok(json!({"ok":false,"error":"bad action"}));
        };
        let base = base_url(slice);
        let gl = crate::blocking::spawn({
            let slice = slice.clone();
            let base = base.clone();
            move || auth::gitlab(&slice, &base, true)
        })
        .await?;
        if gl.source == "none" {
            return Ok(json!({"ok":false,"error":"no GitLab token"}));
        }
        let path = if job {
            format!(
                "projects/{}/jobs/{id}/{}",
                encode(project),
                if kind == "gitlab-play" {
                    "play"
                } else {
                    "cancel"
                }
            )
        } else {
            format!("projects/{}/deployments/{id}/approval", encode(project))
        };
        let fields = if job {
            json!({})
        } else {
            json!({"status":if kind=="gitlab-approve"{"approved"}else{"rejected"}})
        };
        if gl.source == "cli" {
            let host = hostname(&base)?;
            let result = crate::blocking::spawn(move || {
                auth::glab_api(&host, &path, Some("POST"), Some(&fields))
            })
            .await?;
            return Ok(match result {
                Ok(_) => json!({"ok":true}),
                Err(e) => json!({"ok":false,"error":e.to_string()}),
            });
        }
        let response = client
            .post(format!("{base}/api/v4/{path}"))
            .header("private-token", gl.token)
            .json(&fields)
            .send()
            .await?;
        return Ok(if response.status().is_success() {
            json!({"ok":true})
        } else {
            json!({"ok":false,"error":http_error(response).await})
        });
    }
    Ok(json!({"ok":false,"error":"unknown action"}))
}
async fn http_error(response: reqwest::Response) -> String {
    let status = response.status().as_u16();
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    let msg = body["message"].as_str().unwrap_or("");
    if msg.is_empty() {
        format!("HTTP {status}")
    } else {
        format!("HTTP {status} — {msg}")
    }
}
async fn test_forge(slice: &Value, body: &Value) -> Value {
    let mut probe = slice.clone();
    if !probe.is_object() {
        probe = json!({});
    }
    if let Some(t) = body["githubToken"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        probe["githubToken"] = json!(t);
    }
    let supplied = body["gitlabToken"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(t) = supplied {
        probe["gitlabToken"] = json!(t);
    }
    let stored = slice["gitlabBaseUrl"].as_str().unwrap_or("").trim();
    let override_url = body["gitlabBaseUrl"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let changed = override_url.is_some_and(|s| s != stored);
    if let Some(url) = override_url {
        probe["gitlabBaseUrl"] = json!(url);
    }
    if changed && supplied.is_none() {
        probe["gitlabToken"] = json!("");
    }
    let base = base_url(&probe);
    let client = match client() {
        Ok(c) => c,
        Err(e) => return json!({"ok":false,"error":e.to_string()}),
    };
    if body["forge"] == "github" {
        let gh = match crate::blocking::spawn(move || auth::github(&probe)).await {
            Ok(a) => a,
            Err(e) => return json!({"ok":false,"error":e.to_string()}),
        };
        if gh.token.is_empty() {
            return json!({"ok":false,"source":"none","error":"no token found (PAT, GITHUB_TOKEN or gh cli)"});
        }
        let response = client
            .get("https://api.github.com/user")
            .bearer_auth(gh.token)
            .header("accept", "application/vnd.github+json")
            .send()
            .await;
        return match response {
            Ok(r) if r.status().is_success() => {
                let body = r.json::<Value>().await.unwrap_or(Value::Null);
                json!({"ok":true,"user":body["login"],"source":gh.source})
            }
            Ok(r) => {
                json!({"ok":false,"source":gh.source,"error":format!("HTTP {}",r.status().as_u16())})
            }
            Err(e) => json!({"ok":false,"error":e.to_string()}),
        };
    }
    let gl = match crate::blocking::spawn({
        let probe = probe.clone();
        let base = base.clone();
        move || auth::gitlab(&probe, &base, !changed)
    })
    .await
    {
        Ok(a) => a,
        Err(e) => return json!({"ok":false,"error":e.to_string()}),
    };
    if gl.source == "none" {
        return json!({"ok":false,"source":"none","error":"no token found (PAT, GITLAB_TOKEN or glab cli)"});
    }
    if gl.source == "cli" {
        let host = match hostname(&base) {
            Ok(h) => h,
            Err(e) => return json!({"ok":false,"error":e.to_string()}),
        };
        let user = crate::blocking::spawn(move || auth::glab_api(&host, "user", None, None))
            .await
            .ok()
            .and_then(Result::ok)
            .and_then(|v| v["username"].as_str().map(str::to_owned));
        return if let Some(user) = user {
            json!({"ok":true,"user":user,"source":"cli"})
        } else {
            json!({"ok":false,"source":"cli","error":"glab api failed"})
        };
    }
    let response = client
        .get(format!("{base}/api/v4/user"))
        .header("private-token", gl.token)
        .send()
        .await;
    match response {
        Ok(r) if r.status().is_success() => {
            let body = r.json::<Value>().await.unwrap_or(Value::Null);
            json!({"ok":true,"user":body["username"],"source":gl.source})
        }
        Ok(r) => {
            json!({"ok":false,"source":gl.source,"error":format!("HTTP {}",r.status().as_u16())})
        }
        Err(e) => json!({"ok":false,"error":e.to_string()}),
    }
}
pub async fn handle(
    state: &Native,
    method: &str,
    path: &str,
    query: &str,
    body: &Value,
) -> Result<Option<(u16, Value)>> {
    if !path.starts_with("/api/plugins/deployments/") {
        return Ok(None);
    }
    let sub = path.trim_start_matches("/api/plugins/deployments");
    let slice = settings::plugin(&state.settings, "deployments");
    if !matches!(sub, "/test" | "/auth-status" | "/login") && slice["enabled"] != true {
        return Ok(None);
    }
    match (sub, method) {
        ("/refresh", "POST") => Ok(Some((200, poll(state).await?))),
        ("/approve" | "/cancel", "POST") => {
            let result = match post_action(&client()?, &slice, &body["action"]).await {
                Ok(v) => v,
                Err(e) => json!({"ok":false,"error":e.to_string()}),
            };
            if result["ok"] != true {
                return Ok(Some((502, result)));
            }
            let out = json!({"ok":true,"state":drop_item(body)});
            state.sync.plugin_poll.notify_one();
            Ok(Some((200, out)))
        }
        ("/changelog", "POST") => {
            let item = STATE.lock().unwrap()["items"].as_array().and_then(|a| {
                a.iter()
                    .find(|i| i["url"] == body["url"] && i["environment"] == body["environment"])
                    .cloned()
            });
            let Some(item) = item else {
                return Ok(Some((
                    404,
                    json!({"ok":false,"error":"unknown deployment"}),
                )));
            };
            let base = base_url(&slice);
            let source = item["source"].as_str().unwrap_or("");
            let repo = item["repo"].as_str().unwrap_or("");
            let env = item["environment"].as_str().unwrap_or("");
            let sha = item["sha"].as_str().or(item["ref"].as_str()).unwrap_or("");
            let client = client()?;
            let value = if source == "github" {
                let gh = crate::blocking::spawn({
                    let slice = slice.clone();
                    move || auth::github(&slice)
                })
                .await?;
                if gh.token.is_empty() {
                    return Ok(Some((502, json!({"ok":false,"error":"no GitHub token"}))));
                }
                github::changelog(&client, repo, env, sha, &gh.token).await
            } else {
                let gl = crate::blocking::spawn({
                    let slice = slice.clone();
                    let base = base.clone();
                    move || auth::gitlab(&slice, &base, true)
                })
                .await?;
                if gl.source == "none" {
                    return Ok(Some((502, json!({"ok":false,"error":"no GitLab token"}))));
                }
                gitlab::changelog(&client, repo, &base, &gl, env, sha).await
            };
            Ok(Some(match value {
                Ok(v) => (200, v),
                Err(e) => (502, json!({"ok":false,"error":e.to_string()})),
            }))
        }
        ("/test", "POST") => Ok(Some((200, test_forge(&slice, body).await))),
        ("/auth-status", _) => {
            let url = reqwest::Url::parse(&format!("http://localhost/?{query}"))?;
            let base = url
                .query_pairs()
                .find(|(k, _)| k == "gitlabBaseUrl")
                .map(|(_, v)| v.to_string())
                .unwrap_or_else(|| base_url(&slice));
            let host = hostname(&base)?;
            let (gh, gl) = auths(&slice, &base).await?;
            Ok(Some((
                200,
                json!({"github":{"cli":auth::cli_installed("gh"),"source":gh.source,"loginCommand":login_command("github","github.com")},"gitlab":{"cli":auth::cli_installed("glab"),"source":gl.source,"loginCommand":login_command("gitlab",&host)}}),
            )))
        }
        _ => Ok(None),
    }
}
