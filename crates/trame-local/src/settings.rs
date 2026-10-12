use anyhow::{Result, anyhow};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::Mutex,
};
use trame_core::trim;

static WRITER: Mutex<()> = Mutex::new(());

pub fn read(path: &Path) -> Value {
    fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

pub fn update(path: &Path, mutate: impl FnOnce(&mut Value) -> Result<()>) -> Result<Value> {
    let _guard = WRITER
        .lock()
        .map_err(|_| anyhow!("settings writer unavailable"))?;
    let mut next = read(path);
    mutate(&mut next)?;
    fs::create_dir_all(
        path.parent()
            .ok_or_else(|| anyhow!("settings parent missing"))?,
    )?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(serde_json::to_string_pretty(&next)?.as_bytes())?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    Ok(next)
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "bounded() clamps to 1..=240 and is integral"
)]
pub fn normalize_agent_presence(raw: &Value) -> Value {
    fn bounded(v: &Value, default: f64, low: f64, high: f64) -> f64 {
        let n = v.as_f64().or_else(|| {
            v.as_str()
                .filter(|s| !trim(s).is_empty())
                .and_then(crate::routes::number)
        });
        n.filter(|n| n.is_finite())
            .map(|n| (n + 0.5).floor().clamp(low, high))
            .unwrap_or(default)
    }
    let live = bounded(&raw["liveMinutes"], 2.0, 1.0, 30.0);
    json!({"marker":if raw["marker"]=="rail"{"rail"}else{"ring"},"activity":match raw["activity"].as_str(){Some("hover")=>"hover",Some("off")=>"off",_=>"always"},
        "fields":{"harness":raw["fields"]["harness"]!=false,"provider":raw["fields"]["provider"]!=false,"model":raw["fields"]["model"]!=false,"tokens":raw["fields"]["tokens"]!=false,"step":raw["fields"]["step"]!=false},
        "chip":raw["chip"]!=false,"tint":raw["tint"]!=false,"timer":raw["timer"]!=false,"motion":raw["motion"]!=false,"liveMinutes":live as u32,"staleMinutes":bounded(&raw["staleMinutes"],30.0,live.max(5.0),240.0) as u32})
}

pub fn expand(value: &str) -> PathBuf {
    let value = trim(value);
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    if value == "~" {
        PathBuf::from(home)
    } else if let Some(rest) = value.strip_prefix("~/") {
        PathBuf::from(home).join(rest)
    } else {
        PathBuf::from(value)
    }
}

fn strings(value: &Value) -> Result<Vec<String>> {
    value
        .as_array()
        .map(|values| {
            values
                .iter()
                .map(|v| {
                    v.as_str()
                        .map(|s| trim(s).to_owned())
                        .ok_or_else(|| anyhow!("p.trim is not a function"))
                })
                .filter(|s| s.as_ref().map_or(true, |s| !s.is_empty()))
                .collect()
        })
        .unwrap_or_else(|| Ok(Vec::new()))
}

pub fn explore(path: &Path) -> Result<Value> {
    let s = read(path);
    let local_hub = trim(s["hubApi"].as_str().unwrap_or(""));
    let env_hub = std::env::var("TRACKER_HUB_API").unwrap_or_default();
    let hub = if local_hub.is_empty() {
        env_hub.as_str()
    } else {
        local_hub
    };
    let source = if !local_hub.is_empty() {
        json!("settings")
    } else if !env_hub.is_empty() {
        json!("env")
    } else {
        Value::Null
    };
    let token = if !local_hub.is_empty() {
        !trim(s["hubApiToken"].as_str().unwrap_or("")).is_empty()
    } else {
        !std::env::var("TRACKER_HUB_API_TOKEN")
            .unwrap_or_default()
            .is_empty()
    };
    let has_paths = s["reportPaths"].is_array();
    let paths = if has_paths {
        strings(&s["reportPaths"])?
    } else {
        std::env::var("TRACKER_REPORT_PATHS")
            .unwrap_or_default()
            .split(':')
            .map(trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect()
    };
    Ok(
        json!({"paths":paths.iter().map(|s|expand(s).to_string_lossy().into_owned()).collect::<Vec<_>>(),"ignore":strings(&s["ignorePaths"])?,"starred":strings(&s["starredPaths"])?,"htmlFilter":if s["htmlFilter"]=="all"{"all"}else{"smart"},"source":if has_paths{"settings"}else{"env"},"hubApi":hub,"hubSource":source,"hubHasToken":token,"authorName":trim(s["authorName"].as_str().unwrap_or("")),"authorAvatar":trim(s["authorAvatar"].as_str().unwrap_or("")),"agentPresence":normalize_agent_presence(&s["agentPresence"])}),
    )
}

pub fn save_explore(path: &Path, patch: &Value) -> Result<()> {
    update(path, |s| {
        for key in ["reportPaths", "ignorePaths", "starredPaths"] {
            if patch[key].is_array() {
                s[key] = json!(strings(&patch[key])?);
            }
        }
        if matches!(patch["htmlFilter"].as_str(), Some("smart" | "all")) {
            s["htmlFilter"] = patch["htmlFilter"].clone();
        }
        for key in ["authorName", "authorAvatar"] {
            if let Some(v) = patch[key].as_str() {
                let v = trim(v);
                if v.is_empty() {
                    s.as_object_mut().unwrap().remove(key);
                } else {
                    s[key] = json!(v);
                }
            }
        }
        if let Some(v) = patch.get("agentPresence") {
            s["agentPresence"] = normalize_agent_presence(v);
        }
        if let Some(url) = patch["hubApi"].as_str() {
            let url = trim(url).strip_suffix('/').unwrap_or(trim(url));
            if url.is_empty() {
                s.as_object_mut().unwrap().remove("hubApi");
                s.as_object_mut().unwrap().remove("hubApiToken");
            } else {
                s["hubApi"] = json!(url);
                let token = trim(patch["hubApiToken"].as_str().unwrap_or(""));
                if !token.is_empty() {
                    s["hubApiToken"] = json!(token);
                }
            }
        }
        Ok(())
    })?;
    Ok(())
}

pub fn plugin(path: &Path, id: &str) -> Value {
    read(path)["plugins"]
        .get(id)
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}))
}

pub fn hub_api(path: &Path) -> Option<(String, String)> {
    let s = read(path);
    let field = |key: &str, env: &str| {
        s[key]
            .as_str()
            .map(trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| std::env::var(env).unwrap_or_default())
    };
    let url = field("hubApi", "TRACKER_HUB_API");
    let token = field("hubApiToken", "TRACKER_HUB_API_TOKEN");
    if url.is_empty() || token.is_empty() {
        None
    } else {
        Some((url.strip_suffix('/').unwrap_or(&url).to_owned(), token))
    }
}

pub fn link_base(path: &Path) -> Option<String> {
    let s = read(path);
    let explicit = s["linkBase"]
        .as_str()
        .map(trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| std::env::var("TRACKER_LINK_BASE").unwrap_or_default());
    if !explicit.is_empty() {
        return Some(explicit.strip_suffix('/').unwrap_or(&explicit).to_owned());
    }
    let (hub, _) = hub_api(path)?;
    let mut url = reqwest::Url::parse(&hub).ok()?;
    url.set_port(Some(8444)).ok()?;
    Some(url.origin().ascii_serialization())
}
pub fn save_plugin(path: &Path, id: &str, patch: &Value) -> Result<()> {
    update(path, |s| {
        if !s["plugins"].is_object() {
            s["plugins"] = json!({});
        }
        if !s["plugins"][id].is_object() {
            s["plugins"][id] = json!({});
        }
        if let Some(patch) = patch.as_object() {
            s["plugins"][id]
                .as_object_mut()
                .unwrap()
                .extend(patch.clone());
        }
        Ok(())
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn settings_preserve_unknown_fields_hide_secrets_and_write_private_atomic_files() {
        let root = crate::scratch_root(
            &crate::workspace().join(format!(".scratch/settings-{}", uuid::Uuid::new_v4())),
        )
        .unwrap();
        let file = root.join("settings.json");
        update(&file, |s| {
            *s = json!({"other":{"kept":true},"hubApiToken":"fixture-secret"});
            Ok(())
        })
        .unwrap();
        save_explore(
            &file,
            &json!({"hubApi":"https://fixture.invalid/","hubApiToken":"","authorName":" Writer "}),
        )
        .unwrap();
        let s = read(&file);
        assert_eq!(s["other"], json!({"kept":true}));
        assert_eq!(s["hubApiToken"], "fixture-secret");
        let public = explore(&file).unwrap();
        assert_eq!(public["hubApi"], "https://fixture.invalid");
        assert_eq!(public["authorName"], "Writer");
        assert_eq!(public["hubHasToken"], true);
        assert!(public.get("hubApiToken").is_none());
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(
            update(&file, |s| {
                s["other"] = Value::Null;
                Err(anyhow!("rejected"))
            })
            .is_err()
        );
        assert_eq!(read(&file)["other"], json!({"kept":true}));
        save_plugin(&file, "test", &json!({"enabled":true})).unwrap();
        assert_eq!(plugin(&file, "test")["enabled"], true);
        save_explore(&file, &json!({"hubApi":"","authorName":""})).unwrap();
        assert!(read(&file).get("hubApiToken").is_none());
        assert!(read(&file).get("authorName").is_none());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn agent_presence_settings_drop_unknown_keys_and_clamp() {
        let v = normalize_agent_presence(
            &json!({"marker":"rail","activity":"off","fields":{"tokens":false},"liveMinutes":"9.5","staleMinutes":2,"chip":false,"unknown":1}),
        );
        assert_eq!(v["liveMinutes"], 10);
        assert_eq!(v["staleMinutes"], 10);
        assert_eq!(v["fields"]["tokens"], false);
        assert_eq!(v["fields"]["model"], true);
        assert_eq!(v["chip"], false);
        assert_eq!(v["marker"], "rail");
        assert_eq!(v["activity"], "off");
        assert!(v.get("unknown").is_none());
        assert_eq!(normalize_agent_presence(&Value::Null)["liveMinutes"], 2);
    }
}
