use crate::target::resolve_target;
use anyhow::Result;
use reqwest::Method;
use serde_json::{Value, json};
use std::{fmt::Write as _, time::Duration};

/// `tramecli <id>` alone: the commands a plugin manifest declares.
pub fn usage(manifest: &Value) -> String {
    let id = manifest["id"].as_str().unwrap_or("");
    let mut out = format!(
        "tramecli {id} — commands from the {} plugin\n",
        manifest["label"].as_str().unwrap_or(id)
    );
    for c in manifest["commands"].as_array().into_iter().flatten() {
        let call = format!(
            "tramecli {id} {} {}",
            c["name"].as_str().unwrap_or(""),
            c["usage"].as_str().unwrap_or("")
        );
        let _ = write!(
            out,
            "\n  {:<40} {}",
            call.trim_end(),
            c["summary"].as_str().unwrap_or("")
        );
    }
    out
}

/// Runs `tramecli <id> …` when a plugin of the running app declares commands; `None` if none does.
pub async fn run(id: &str, args: &[String], json_out: bool) -> Result<Option<i32>> {
    let Ok(target) = resolve_target().await else {
        return Ok(None);
    };
    // plugins run only in the local app
    if target.hub {
        return Ok(None);
    }
    let Ok(Value::Array(manifests)) = target.get("/api/plugins").await else {
        return Ok(None);
    };
    let Some(manifest) = manifests
        .iter()
        .find(|m| m["id"] == id && m["commands"].is_array())
    else {
        return Ok(None);
    };
    let name = args.first().map_or("", String::as_str);
    let declared = manifest["commands"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|c| c["name"] == name);
    if name.is_empty() || matches!(name, "--help" | "-h") {
        println!("{}", usage(manifest));
        return Ok(Some(0));
    }
    if !declared {
        eprintln!("unknown {id} command: {name}\n\n{}", usage(manifest));
        return Ok(Some(2));
    }
    if manifest["enabled"] != true {
        eprintln!("{id} is disabled: enable it in Trame's Settings → Plugins");
        return Ok(Some(1));
    }
    let reply = target
        .request(
            Method::POST,
            &format!("/api/plugins/{id}/cli"),
            Some(&json!({"name": name, "args": &args[1..]})),
            // a plugin command may shell out (kubectl, a forge API)
            Some(Duration::from_mins(5)),
        )
        .await?;
    let code = reply["code"]
        .as_i64()
        .and_then(|c| i32::try_from(c).ok())
        .unwrap_or(1);
    if json_out && !reply["json"].is_null() {
        println!("{}", serde_json::to_string_pretty(&reply["json"])?);
    } else {
        let text = reply["text"].as_str().unwrap_or("");
        let text = text.strip_suffix('\n').unwrap_or(text);
        if code == 0 {
            println!("{text}");
        } else {
            eprintln!("{text}");
        }
    }
    Ok(Some(code))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_lists_each_command_with_its_arguments() {
        let manifest = json!({"id":"k8s","label":"Kubernetes","commands":[
            {"name":"pods","usage":"<context>","summary":"list pods"},
            {"name":"contexts","usage":"","summary":"list contexts"}]});
        let text = usage(&manifest);
        assert!(text.starts_with("tramecli k8s — commands from the Kubernetes plugin"));
        assert!(text.contains("tramecli k8s pods <context>"), "{text}");
        assert!(text.contains("tramecli k8s contexts "), "{text}");
    }
}
