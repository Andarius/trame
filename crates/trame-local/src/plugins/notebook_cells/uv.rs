// What the kernel wizard shows before it writes a spec: the folder's pyproject, uv's Pythons, PyPI versions.
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// The folder's pyproject: name, version, requires-python, dependencies and dev group, lockfile.
pub(super) fn project_info(raw: &str) -> Result<Value> {
    if !Path::new(raw).is_absolute() {
        bail!("give the project's absolute path");
    }
    let dir = Path::new(raw).canonicalize().context("no such folder")?;
    let text = std::fs::read_to_string(dir.join("pyproject.toml"))
        .with_context(|| format!("no pyproject.toml in {}", dir.display()))?;
    let doc: toml::Table = text.parse().context("pyproject.toml does not parse")?;
    let project = doc.get("project").and_then(toml::Value::as_table);
    let field = |k: &str| project.and_then(|p| p.get(k)).and_then(toml::Value::as_str);
    let strings = |v: Option<&toml::Value>| -> Vec<String> {
        v.and_then(toml::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(toml::Value::as_str)
            .take(200)
            .map(str::to_owned)
            .collect()
    };
    let dev = doc.get("dependency-groups").and_then(|g| g.get("dev"));
    Ok(json!({
        "dir": dir,
        "name": field("name"),
        "version": field("version"),
        "requiresPython": field("requires-python"),
        "dependencies": strings(project.and_then(|p| p.get("dependencies"))),
        "dev": strings(dev),
        "lock": dir.join("uv.lock").is_file(),
    }))
}

/// `uv python list` as `CPython` minors, newest first, with whether one is installed.
pub(super) fn pythons(uv: &PathBuf) -> Result<Value> {
    let out = std::process::Command::new(uv)
        .args(["python", "list", "--output-format", "json"])
        .output()
        .context("uv python list failed")?;
    if !out.status.success() {
        bail!("uv python list failed");
    }
    Ok(json!(minors(&serde_json::from_slice(&out.stdout)?)))
}

pub(super) fn minors(list: &Value) -> Vec<Value> {
    let mut seen: Vec<(u64, u64, bool)> = Vec::new();
    for p in list.as_array().into_iter().flatten() {
        if p["implementation"] != "cpython" || p["variant"] != "default" {
            continue;
        }
        let v = &p["version_parts"];
        let (Some(major), Some(minor)) = (v["major"].as_u64(), v["minor"].as_u64()) else {
            continue;
        };
        let installed = !p["path"].is_null();
        match seen.iter_mut().find(|s| (s.0, s.1) == (major, minor)) {
            Some(s) => s.2 |= installed,
            None => seen.push((major, minor, installed)),
        }
    }
    seen.sort_by_key(|s| std::cmp::Reverse((s.0, s.1)));
    seen.into_iter()
        .map(|(ma, mi, installed)| json!({"version": format!("{ma}.{mi}"), "installed": installed}))
        .collect()
}

pub(super) fn package_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// A `PyPI` project's summary, latest release and recent non-yanked versions, newest first.
pub(super) async fn pypi(name: &str) -> Result<Value> {
    if !package_name(name) {
        bail!("not a package name");
    }
    let res = reqwest::Client::builder()
        .user_agent("trame-local")
        .timeout(std::time::Duration::from_secs(15))
        .build()?
        .get(format!("https://pypi.org/pypi/{name}/json"))
        .send()
        .await
        .context("PyPI unreachable")?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        bail!("{name} is not on PyPI");
    }
    if !res.status().is_success() {
        bail!("PyPI {}", res.status().as_u16());
    }
    Ok(releases(&res.json().await?))
}

pub(super) fn releases(doc: &Value) -> Value {
    let mut versions: Vec<(String, String)> = doc["releases"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(v, files)| {
            let files = files.as_array()?;
            // a release with no files, or only yanked ones, cannot be installed
            let live = files.iter().find(|f| f["yanked"] != true)?;
            Some((
                v.clone(),
                live["upload_time_iso_8601"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned(),
            ))
        })
        .collect();
    versions.sort_by(|a, b| b.1.cmp(&a.1));
    let info = &doc["info"];
    json!({
        "name": info["name"],
        "summary": info["summary"],
        "latest": info["version"],
        "versions": versions.iter().take(40).map(|(v, at)| json!({"version": v, "at": at.get(..10)})).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minors_keep_one_cpython_per_minor_newest_first() {
        let list = json!([
            {"implementation": "cpython", "variant": "default", "version_parts": {"major": 3, "minor": 12}, "path": null},
            {"implementation": "cpython", "variant": "default", "version_parts": {"major": 3, "minor": 12}, "path": "/usr/bin/python3.12"},
            {"implementation": "cpython", "variant": "freethreaded", "version_parts": {"major": 3, "minor": 14}, "path": null},
            {"implementation": "pypy", "variant": "default", "version_parts": {"major": 3, "minor": 11}, "path": null},
            {"implementation": "cpython", "variant": "default", "version_parts": {"major": 3, "minor": 13}, "path": null},
        ]);
        assert_eq!(
            json!(minors(&list)),
            json!([{"version": "3.13", "installed": false}, {"version": "3.12", "installed": true}])
        );
    }

    #[test]
    fn releases_drop_yanked_and_empty_ones() {
        let doc = json!({"info": {"name": "six", "summary": "s", "version": "1.2"}, "releases": {
            "1.0": [{"yanked": false, "upload_time_iso_8601": "2020-01-01T00:00:00Z"}],
            "1.1": [{"yanked": true, "upload_time_iso_8601": "2021-01-01T00:00:00Z"}],
            "1.2": [{"yanked": false, "upload_time_iso_8601": "2022-01-01T00:00:00Z"}],
            "2.0a": [],
        }});
        assert_eq!(
            releases(&doc)["versions"],
            json!([{"version": "1.2", "at": "2022-01-01"}, {"version": "1.0", "at": "2020-01-01"}])
        );
    }

    #[test]
    fn only_plain_names_reach_the_pypi_url() {
        for ok in ["polars", "zope.interface", "typing_extensions", "Py-Yaml2"] {
            assert!(package_name(ok), "{ok}");
        }
        for bad in ["", "../x", "a/b", "-x", "a?b=1", "pkg==1"] {
            assert!(!package_name(bad), "{bad}");
        }
    }
}
