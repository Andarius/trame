use anyhow::{Context, Result, anyhow};
use serde_json::{Value, json};
use std::process::{Command, Stdio};

#[derive(Clone)]
pub struct Auth {
    pub token: String,
    pub source: &'static str,
}
fn command(bin: &str, args: &[&str]) -> Option<String> {
    let output = crate::cli::output_within(
        Command::new(bin)
            .args(args)
            .stdin(Stdio::null())
            .stderr(Stdio::null()),
        crate::cli::NETWORK_TIMEOUT,
    )
    .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}
pub fn cli_installed(bin: &str) -> bool {
    Command::new(bin)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}
pub fn github(slice: &Value) -> Auth {
    if let Some(s) = slice["githubToken"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Auth {
            token: s.into(),
            source: "settings",
        };
    }
    for key in ["GITHUB_TOKEN", "GH_TOKEN"] {
        if let Ok(s) = std::env::var(key) {
            if !s.is_empty() {
                return Auth {
                    token: s,
                    source: "env",
                };
            }
        }
    }
    if let Some(s) = command("gh", &["auth", "token"]).filter(|s| !s.is_empty()) {
        return Auth {
            token: s,
            source: "cli",
        };
    }
    Auth {
        token: String::new(),
        source: "none",
    }
}
pub fn gitlab(slice: &Value, base: &str, ambient: bool) -> Auth {
    if let Some(s) = slice["gitlabToken"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Auth {
            token: s.into(),
            source: "settings",
        };
    }
    if !ambient {
        return Auth {
            token: String::new(),
            source: "none",
        };
    }
    if let Ok(s) = std::env::var("GITLAB_TOKEN") {
        if !s.is_empty() {
            return Auth {
                token: s,
                source: "env",
            };
        }
    }
    if let Ok(host) = hostname(base) {
        if glab_api(&host, "user", None, None).is_ok() {
            return Auth {
                token: String::new(),
                source: "cli",
            };
        }
    }
    Auth {
        token: String::new(),
        source: "none",
    }
}
pub fn hostname(base: &str) -> Result<String> {
    Ok(reqwest::Url::parse(base)?
        .host_str()
        .context("missing host")?
        .to_owned())
}
pub fn glab_api(
    host: &str,
    path: &str,
    method: Option<&str>,
    fields: Option<&Value>,
) -> Result<Value> {
    let mut command = Command::new("glab");
    command.args(["api", path, "--hostname", host]);
    if let Some(method) = method {
        command.args(["-X", method]);
    }
    if let Some(fields) = fields.and_then(Value::as_object) {
        for (key, value) in fields {
            command
                .arg("-f")
                .arg(format!("{key}={}", value.as_str().unwrap_or("")));
        }
    }
    let output = crate::cli::output_within(
        command.stdin(Stdio::null()).stderr(Stdio::piped()),
        crate::cli::NETWORK_TIMEOUT,
    )?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!(
            "{}",
            stderr.lines().last().unwrap_or("glab api failed")
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    Ok(serde_json::from_str(&text)?)
}
pub fn source(auth: &Auth) -> Value {
    json!(auth.source)
}
