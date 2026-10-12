use regex::Regex;
use serde_json::{Value, json};
use std::collections::HashSet;

pub fn defaults(forge: &str) -> Value {
    match forge {
        "gitlab" => json!({"pattern":"!(\\d+)\\b","environments":[],"backport":true}),
        _ => json!({"pattern":"#(\\d+)\\b","environments":[],"backport":true}),
    }
}
fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}
fn valid_pattern(value: &Value) -> Option<String> {
    let pattern = value.as_str()?.trim();
    if pattern.is_empty() {
        return None;
    }
    let regex = Regex::new(pattern).ok()?;
    if regex.captures_len() != 2 {
        return None;
    }
    Some(pattern.to_owned())
}
pub fn rule_for(stored: &Value, repo: &str, forge: &str) -> Value {
    let raw = &stored[repo];
    let mut rule = defaults(forge);
    if let Some(p) = valid_pattern(&raw["pattern"]) {
        rule["pattern"] = json!(p);
    }
    if raw["environments"].is_array() {
        rule["environments"] = json!(strings(&raw["environments"]));
    }
    if raw["backport"].is_boolean() {
        rule["backport"] = raw["backport"].clone();
    }
    rule
}
pub fn sanitize_rules(raw: &Value, repos: &[String]) -> Value {
    let mut result = serde_json::Map::new();
    if let Some(entries) = raw.as_object() {
        for (repo, value) in entries {
            if !repos.contains(repo) || !value.is_object() {
                continue;
            }
            let mut rule = serde_json::Map::new();
            if let Some(p) = valid_pattern(&value["pattern"]) {
                rule.insert("pattern".into(), json!(p));
            }
            let envs = strings(&value["environments"]);
            if !envs.is_empty() {
                rule.insert("environments".into(), json!(envs));
            }
            if value["backport"].is_boolean() {
                rule.insert("backport".into(), value["backport"].clone());
            }
            if !rule.is_empty() {
                result.insert(repo.clone(), Value::Object(rule));
            }
        }
    }
    Value::Object(result)
}
pub fn ref_numbers(message: &str, pattern: &str) -> Vec<i64> {
    let Ok(regex) = Regex::new(pattern) else {
        return vec![];
    };
    let mut seen = HashSet::new();
    regex
        .captures_iter(message)
        .filter_map(|c| c.get(1)?.as_str().parse::<i64>().ok())
        .filter(|n| seen.insert(*n))
        .collect()
}
pub fn ref_url(forge: &str, host: &str, repo: &str, n: i64) -> String {
    if forge == "github" {
        format!("https://github.com/{repo}/pull/{n}")
    } else {
        format!("{host}/{repo}/-/merge_requests/{n}")
    }
}
pub fn match_cards(
    forge: &str,
    host: &str,
    repo: &str,
    commits: &[Vec<i64>],
    cards: &[Value],
    backport: bool,
) -> Vec<Value> {
    let pattern = if forge == "github" {
        format!(r"(?i)github\.com/{}/pull/(\d+)\b", regex::escape(repo))
    } else {
        format!(
            r"(?i){}/{}/-/merge_requests/(\d+)\b",
            regex::escape(
                host.trim_start_matches("https://")
                    .trim_start_matches("http://")
            ),
            regex::escape(repo)
        )
    };
    let Ok(regex) = Regex::new(&pattern) else {
        return vec![];
    };
    let mut output = Vec::new();
    for card in cards {
        let own: HashSet<i64> = regex
            .captures_iter(card["pr_url"].as_str().unwrap_or(""))
            .filter_map(|c| c.get(1)?.as_str().parse().ok())
            .collect();
        let Some(group) = commits.iter().find(|g| g.iter().any(|n| own.contains(n))) else {
            continue;
        };
        let Some(pr) = group.iter().find(|n| own.contains(n)) else {
            continue;
        };
        let via = if backport {
            group.iter().find(|n| *n != pr).copied()
        } else {
            None
        };
        output.push(json!({"card_id":card["id"],"title":card["title"],"status":card["status"],"pr":pr,"prUrl":ref_url(forge,host,repo,*pr),"via":via,"viaUrl":via.map(|n|ref_url(forge,host,repo,n))}));
    }
    output
}

pub fn with_fixture_ships(
    db: &mut crate::db::Db,
    items: &mut [Value],
    slice: &Value,
    changelogs: &Value,
) -> anyhow::Result<()> {
    let mut refs = serde_json::Map::new();
    for item in items.iter() {
        let url = item["url"].as_str().unwrap_or("");
        let pattern = rule_for(
            &slice["ships"],
            item["repo"].as_str().unwrap_or(""),
            item["source"].as_str().unwrap_or(""),
        )["pattern"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        let commits: Vec<Vec<i64>> = changelogs[url]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|c| ref_numbers(c["title"].as_str().unwrap_or(""), &pattern))
                    .collect()
            })
            .unwrap_or_default();
        refs.insert(url.into(), json!(commits));
    }
    with_live_ships(db, items, slice, &Value::Object(refs))
}
pub fn with_live_ships(
    db: &mut crate::db::Db,
    items: &mut [Value],
    slice: &Value,
    refs: &Value,
) -> anyhow::Result<()> {
    if !items.iter().any(|i| i["status"] == "waiting") {
        return Ok(());
    }
    let cards=db.query("select id, title, status, pr_url from sessions where not deleted and pr_url is not null and status not in (select key from statuses where terminal and not deleted)",&[])?;
    let host = slice["gitlabBaseUrl"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("https://gitlab.com")
        .trim_end_matches('/');
    for item in items {
        let source = item["source"].as_str().unwrap_or("");
        let repo = item["repo"].as_str().unwrap_or("");
        let rule = rule_for(&slice["ships"], repo, source);
        if item["status"] != "waiting" {
            continue;
        }
        if rule["environments"]
            .as_array()
            .is_some_and(|a| !a.is_empty() && !a.iter().any(|v| v == &item["environment"]))
        {
            continue;
        }
        let commits: Vec<Vec<i64>> = refs[item["url"].as_str().unwrap_or("")]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|c| {
                        c.as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_i64)
                            .collect()
                    })
                    .collect()
            })
            .unwrap_or_default();
        let ships = match_cards(
            source,
            host,
            repo,
            &commits,
            &cards,
            rule["backport"] != false,
        );
        for card in &ships {
            let id = card["card_id"].as_str().unwrap_or("");
            let summary = format!(
                "release \"{}\" waiting on {} — {}",
                item["title"].as_str().unwrap_or(""),
                item["environment"].as_str().unwrap_or(""),
                item["url"].as_str().unwrap_or("")
            );
            let seen=db.query("select 1 from session_events where session_id=$1 and summary=$2 and not deleted limit 1",&[json!(id),json!(summary)])?;
            if seen.is_empty() {
                crate::sessions::add_event(db, id, &summary, "log", &json!("deployments"))?;
            }
        }
        if !ships.is_empty() {
            item["ships"] = json!(ships);
        }
    }
    Ok(())
}
