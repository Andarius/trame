use serde_json::{Value, json};
use std::{
    collections::HashMap,
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

static CACHE: OnceLock<Mutex<HashMap<String, (Instant, Value)>>> = OnceLock::new();
static DEFAULTS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
fn run(program: &str, args: &[&str], host: Option<&str>) -> Option<String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    if let Some(host) = host {
        command.env("GITLAB_HOST", host);
    }
    let out = crate::cli::output_within(&mut command, crate::cli::NETWORK_TIMEOUT).ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}
fn glab(host: &str, path: &str) -> Option<Value> {
    let value: Value = serde_json::from_str(&run("glab", &["api", path], Some(host))?).ok()?;
    if value["message"].is_string() {
        None
    } else {
        Some(value)
    }
}
fn encoded(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(b) {
                (*b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
fn stacked(refs: &[String]) -> String {
    let more = if refs.len() > 3 {
        format!(" +{} more", refs.len() - 3)
    } else {
        String::new()
    };
    format!(
        "{}{more} stacked on top",
        refs.iter().take(3).cloned().collect::<Vec<_>>().join(", ")
    )
}
fn default_branch(key: &str, fetch: impl FnOnce() -> Option<String>) -> Option<String> {
    let cache = DEFAULTS.get_or_init(Default::default);
    if let Some(value) = cache.lock().unwrap().get(key) {
        return Some(value.clone());
    }
    let value = fetch().filter(|v| !v.is_empty())?;
    cache.lock().unwrap().insert(key.to_owned(), value.clone());
    Some(value)
}
fn lookup(url: &str) -> Option<Value> {
    let (row, repo, host, github) = if url.starts_with("https://github.com/") {
        let row = serde_json::from_str::<Value>(&run(
            "gh",
            &[
                "pr",
                "view",
                url,
                "--json",
                "state,isDraft,title,baseRefName,headRefName",
            ],
            None,
        )?)
        .ok()?;
        let repo = url
            .trim_start_matches("https://github.com/")
            .split('/')
            .take(2)
            .collect::<Vec<_>>()
            .join("/");
        (row, repo, String::new(), true)
    } else {
        let captures = regex::Regex::new(r"^https://([^/]+)/(.+?)/-/merge_requests/(\d+)")
            .ok()?
            .captures(url)?;
        let host = captures[1].to_owned();
        let repo = encoded(&captures[2]);
        let row = glab(
            &host,
            &format!("projects/{repo}/merge_requests/{}", &captures[3]),
        )?;
        if !row["state"].is_string() || !row["target_branch"].is_string() {
            return None;
        }
        (row, repo, host, false)
    };
    let raw = row["state"].as_str()?;
    let state = match raw {
        "merged" | "MERGED" => "merged",
        "closed" | "CLOSED" => "closed",
        _ => {
            if row[if github { "isDraft" } else { "draft" }] == true {
                "draft"
            } else {
                "open"
            }
        }
    };
    let base = row[if github {
        "baseRefName"
    } else {
        "target_branch"
    }]
    .as_str()?;
    let head = row[if github {
        "headRefName"
    } else {
        "source_branch"
    }]
    .as_str()
    .unwrap_or("");
    let key = if github {
        repo.clone()
    } else {
        format!("{host}/{repo}")
    };
    let def = default_branch(&key, || {
        if github {
            run(
                "gh",
                &[
                    "repo",
                    "view",
                    &repo,
                    "--json",
                    "defaultBranchRef",
                    "-q",
                    ".defaultBranchRef.name",
                ],
                None,
            )
        } else {
            glab(&host, &format!("projects/{repo}"))?["default_branch"]
                .as_str()
                .map(str::to_owned)
        }
    });
    let mut info = json!({"state":state,"title":row["title"],"base":base});
    if let Some(def) = def {
        if base != def {
            info["stack"] = json!(format!("stacked on {base}"));
        } else if matches!(state, "open" | "draft") {
            let deps = if github {
                run(
                    "gh",
                    &[
                        "pr", "list", "-R", &repo, "--base", head, "--json", "number",
                    ],
                    None,
                )
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            } else {
                glab(
                    &host,
                    &format!(
                        "projects/{repo}/merge_requests?state=opened&target_branch={}",
                        encoded(head)
                    ),
                )
            };
            if let Some(deps) = deps
                .and_then(|v| v.as_array().cloned())
                .filter(|v| !v.is_empty())
            {
                info["stack"] = json!(stacked(
                    &deps
                        .iter()
                        .map(|v| format!(
                            "{}{}",
                            if github { "#" } else { "!" },
                            v[if github { "number" } else { "iid" }]
                        ))
                        .collect::<Vec<String>>()
                ));
            }
        }
    }
    Some(info)
}
pub fn pr_info(url: &str, offline: bool) -> Value {
    if offline {
        return json!({"state":"unknown"});
    }
    let cache = CACHE.get_or_init(Default::default);
    if let Some((at, value)) = cache.lock().unwrap().get(url) {
        if at.elapsed() < Duration::from_mins(1) {
            return value.clone();
        }
    }
    let value = lookup(url).unwrap_or_else(|| json!({"state":"unknown"}));
    cache
        .lock()
        .unwrap()
        .insert(url.into(), (Instant::now(), value.clone()));
    value
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unavailable_and_stack_labels() {
        assert_eq!(
            pr_info("https://github.com/fixture/fixture/pull/1", true),
            json!({"state":"unknown"})
        );
        assert_eq!(
            stacked(&["#1".into(), "#2".into(), "#3".into(), "#4".into()]),
            "#1, #2, #3 +1 more stacked on top"
        );
        assert_eq!(
            encoded("group/project feature"),
            "group%2Fproject%20feature"
        );
    }
}
