use crate::target::Target;
use anyhow::{Result, bail};
use serde_json::{Value, json};

pub fn apply_flags(ships: &Value, repo: &str, args: &[String]) -> Result<Value> {
    let mut out = ships.as_object().cloned().unwrap_or_default();
    if args.iter().any(|a| a == "--reset") {
        out.remove(repo);
        return Ok(Value::Object(out));
    }
    let mut rule = out.get(repo).cloned().unwrap_or_else(|| json!({}));
    for (flag, key) in [("--pattern", "pattern"), ("--env", "environments")] {
        if let Some(index) = args.iter().position(|a| a == flag) {
            let Some(value) = args.get(index + 1) else {
                bail!("{flag} needs a value");
            };
            rule[key] = if flag == "--env" {
                json!(
                    value
                        .split(',')
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .collect::<Vec<_>>()
                )
            } else {
                json!(value)
            };
        }
    }
    if args.iter().any(|a| a == "--backport") {
        rule["backport"] = json!(true);
    }
    if args.iter().any(|a| a == "--no-backport") {
        rule["backport"] = json!(false);
    }
    out.insert(repo.into(), rule);
    Ok(Value::Object(out))
}
pub async fn main(args: &[String], json_out: bool, target: &Target) -> Result<()> {
    if args.first().map(String::as_str) != Some("ships") {
        bail!("usage: tramecli deployments ships [<repo> [flags]] — see --help");
    }
    let repo = args.get(1);
    let flags = args.get(2..).unwrap_or(&[]);
    let mut view = target.get("/api/plugins/deployments/settings").await?;
    if let Some(repo) = repo.filter(|_| !flags.is_empty()) {
        let watched = view["githubRepos"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(view["gitlabProjects"].as_array().into_iter().flatten())
            .any(|name| name == repo);
        if !watched {
            bail!("{repo} is not a watched repo — add it in the Deployments settings first");
        }
        let ships = apply_flags(&view["ships"], repo, flags)?;
        view = target
            .post("/api/plugins/deployments/settings", &json!({"ships":ships}))
            .await?;
        if let Some(index) = flags.iter().position(|a| a == "--pattern") {
            if view["ships"][repo]["pattern"].as_str() != flags.get(index + 1).map(|s| s.trim()) {
                eprintln!(
                    "pattern dropped: it must compile and have exactly one capture group, e.g. 'PR-(\\d+)'"
                );
            }
        }
    }
    if json_out {
        println!(
            "{}",
            json!({"ships":view["ships"],"shipDefaults":view["shipDefaults"]})
        );
        return Ok(());
    }
    for (key, forge) in [("githubRepos", "github"), ("gitlabProjects", "gitlab")] {
        for name in view[key]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|name| repo.is_none_or(|r| r == name))
        {
            let override_rule = &view["ships"][name];
            let defaults = &view["shipDefaults"][forge];
            let pattern = override_rule["pattern"]
                .as_str()
                .or_else(|| defaults["pattern"].as_str())
                .unwrap_or("");
            let env = override_rule["environments"]
                .as_array()
                .filter(|a| !a.is_empty())
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(",")
                })
                .unwrap_or_else(|| "all".into());
            let backport = override_rule["backport"]
                .as_bool()
                .or_else(|| defaults["backport"].as_bool())
                .unwrap_or(false);
            let mark = if override_rule.as_object().is_some_and(|o| !o.is_empty()) {
                "  (custom)"
            } else {
                ""
            };
            println!(
                "{name} [{forge}]  pattern {pattern} · env {env} · backport {}{mark}",
                if backport { "on" } else { "off" }
            );
        }
    }
    Ok(())
}
