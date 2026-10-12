use crate::settings;
use anyhow::Result;
use chrono::{DateTime, SecondsFormat, Utc};
use glob::{MatchOptions, Pattern};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

type Cache = HashMap<PathBuf, (Instant, Value)>;
static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
fn cache() -> &'static Mutex<Cache> {
    CACHE.get_or_init(Mutex::default)
}
pub fn invalidate(settings: &Path) {
    cache().lock().unwrap().remove(settings);
}

pub fn allowed_path(settings: &Path, path: &str) -> Result<Option<PathBuf>> {
    let isolated = crate::isolated_mode() || crate::scratch_path(settings).is_ok();
    if isolated && crate::scratch_path(&settings::expand(path)).is_err() {
        return Ok(None);
    }
    let Ok(real) = settings::expand(path).canonicalize() else {
        return Ok(None);
    };
    let config = settings::explore(settings)?;
    Ok(config["paths"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .filter(|p| !isolated || crate::scratch_path(Path::new(p)).is_ok())
        .filter_map(|p| Path::new(p).canonicalize().ok())
        .any(|p| real.starts_with(p))
        .then_some(real))
}

pub fn read_report(settings: &Path, path: &str) -> Result<Option<String>> {
    allowed_path(settings, path)?
        .map(fs::read_to_string)
        .transpose()
        .map_err(Into::into)
}

pub fn write_report(settings: &Path, path: &str, content: &str) -> Result<bool> {
    let Some(real) = allowed_path(settings, path)? else {
        return Ok(false);
    };
    if real.extension().and_then(|p| p.to_str()) != Some("excalidraw") {
        return Ok(false);
    }
    fs::write(real, content)?;
    Ok(true)
}

pub fn delete_report(settings: &Path, path: &str) -> Result<Value> {
    let Some(real) = allowed_path(settings, path)? else {
        return Ok(json!({"ok":false,"trashed":false}));
    };
    let trashed = Command::new("gio")
        .arg("trash")
        .arg(&real)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    if !trashed {
        if real.is_dir() {
            fs::remove_dir(real)?;
        } else {
            fs::remove_file(real)?;
        }
    }
    invalidate(settings);
    Ok(json!({"ok":true,"trashed":trashed}))
}

pub fn list_folder(settings: &Path, path: &str) -> Result<Option<Value>> {
    let Some(real) = allowed_path(settings, path)?.filter(|p| p.is_dir()) else {
        return Ok(None);
    };
    let mut out = Vec::new();
    for entry in fs::read_dir(real)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let ty = entry.file_type()?;
        let ext = if ty.is_file() {
            name.rsplit_once('.')
                .map(|(_, s)| s.to_lowercase())
                .unwrap_or_default()
        } else {
            String::new()
        };
        out.push(json!({"name":name,"path":entry.path(),"kind":if ty.is_dir(){"dir"}else{"file"},"ext":ext,"isHtml":ext=="html"||ext=="htm"}));
    }
    out.sort_by(|a, b| {
        a["kind"]
            .as_str()
            .cmp(&b["kind"].as_str())
            .then_with(|| locale_cmp(a["name"].as_str().unwrap(), b["name"].as_str().unwrap()))
    });
    Ok(Some(json!(out)))
}

fn locale_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    static COLLATOR: std::sync::OnceLock<icu_collator::CollatorBorrowed<'static>> =
        std::sync::OnceLock::new();
    COLLATOR
        .get_or_init(|| {
            icu_collator::Collator::try_new(Default::default(), Default::default())
                .expect("compiled collation data")
        })
        .compare(a, b)
}

#[derive(Default)]
struct Ignore {
    names: Vec<String>,
    prefixes: Vec<PathBuf>,
    patterns: Vec<Pattern>,
}
impl Ignore {
    fn new(values: &Value) -> Self {
        let mut rules = Self::default();
        for value in values
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let bare = value.strip_prefix("**/").unwrap_or(value);
            if !bare.contains(['/', '*', '?', '[', ']', '{', '}']) {
                rules.names.push(bare.to_owned());
            } else if value.contains(['*', '?', '[', ']', '{', '}']) {
                let expanded = settings::expand(value).to_string_lossy().into_owned();
                let pattern = if expanded.starts_with('/') {
                    expanded
                } else {
                    format!("**/{expanded}")
                };
                for variant in braces(&pattern) {
                    if let Ok(pattern) = Pattern::new(&variant) {
                        rules.patterns.push(pattern);
                    }
                }
            } else {
                rules
                    .prefixes
                    .push(settings::expand(value.trim_end_matches('/')));
            }
        }
        rules
    }
    fn matches(&self, path: &Path, name: &str, is_dir: bool) -> bool {
        self.names.iter().any(|s| s == name)
            || self
                .prefixes
                .iter()
                .any(|p| path.starts_with(p) && (is_dir || path != p))
            || self.patterns.iter().any(|p| {
                p.matches_path_with(
                    path,
                    MatchOptions {
                        case_sensitive: true,
                        require_literal_separator: true,
                        require_literal_leading_dot: false,
                    },
                )
            })
    }
}

fn braces(pattern: &str) -> Vec<String> {
    let Some(start) = pattern.find('{') else {
        return vec![pattern.to_owned()];
    };
    let mut depth = 0;
    let mut end = None;
    let mut cuts = vec![start + 1];
    for (offset, c) in pattern[start..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    end = Some(start + offset);
                    break;
                }
            }
            ',' if depth == 1 => cuts.push(start + offset + 1),
            _ => {}
        }
    }
    let Some(end) = end else {
        return vec![pattern.to_owned()];
    };
    cuts.push(end + 1);
    cuts.windows(2)
        .flat_map(|p| {
            braces(&format!(
                "{}{}{}",
                &pattern[..start],
                &pattern[p[0]..p[1] - 1],
                &pattern[end + 1..]
            ))
        })
        .collect()
}

fn walk(dir: &Path, depth: i32, out: &mut Vec<Value>, ignore: &Ignore) {
    if depth < 0 || out.len() >= 500 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= 500 {
            return;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        let Ok(ty) = entry.file_type() else { continue };
        if ty.is_dir() {
            if [
                "node_modules",
                ".git",
                "dist",
                "build",
                ".cache",
                ".venv",
                "venv",
                "coverage",
                "target",
            ]
            .contains(&name.as_str())
                || (name.starts_with('.') && name != ".scratch")
                || ignore.matches(&path, &name, true)
            {
                continue;
            }
            walk(&path, depth - 1, out, ignore);
        } else if ty.is_file()
            && (name.ends_with(".html") || name.ends_with(".excalidraw"))
            && !ignore.matches(&path, &name, false)
        {
            if let Ok(meta) = entry.metadata() {
                let mtime = meta
                    .modified()
                    .map(|t| DateTime::<Utc>::from(t).to_rfc3339_opts(SecondsFormat::Millis, true))
                    .unwrap_or_default();
                out.push(json!({"path":path,"name":name,"mtime":mtime}));
            }
        }
    }
}

fn is_report(hit: &Value) -> bool {
    let name = hit["name"].as_str().unwrap_or("");
    if !name.ends_with(".html") || name.ends_with(".ai.html") {
        return true;
    }
    let Ok(file) = fs::File::open(hit["path"].as_str().unwrap_or("")) else {
        return false;
    };
    let mut bytes = Vec::new();
    if file.take(6144).read_to_end(&mut bytes).is_err() {
        return false;
    }
    static ASSET: OnceLock<regex::Regex> = OnceLock::new();
    !ASSET.get_or_init(||regex::Regex::new(r#"(?i)(?:src|href)\s*=\s*["'](?:\.\.?/|/[^/"'])[^"']*?\.(?:m?js|css|tsx?)(?:[?#][^"']*)?["']"#).unwrap()).is_match(&String::from_utf8_lossy(&bytes))
}

pub fn scan(settings: &Path, force: bool) -> Result<Value> {
    if !force {
        if let Some((at, hits)) = cache().lock().unwrap().get(settings) {
            if at.elapsed() < Duration::from_secs(60) {
                return Ok(hits.clone());
            }
        }
    }
    let config = settings::explore(settings)?;
    let ignore = Ignore::new(&config["ignore"]);
    let mut hits = Vec::new();
    for root in config["paths"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
    {
        if (crate::isolated_mode() || crate::scratch_path(settings).is_ok())
            && crate::scratch_path(Path::new(root)).is_err()
        {
            continue;
        }
        walk(Path::new(root), 4, &mut hits, &ignore);
    }
    if config["htmlFilter"] == "smart" {
        hits.retain(is_report);
    }
    hits.sort_by(|a, b| b["mtime"].as_str().cmp(&a["mtime"].as_str()));
    let result = json!(hits);
    cache()
        .lock()
        .unwrap()
        .insert(settings.to_owned(), (Instant::now(), result.clone()));
    Ok(result)
}

pub fn complete(raw: &str) -> Value {
    let home = std::env::var("HOME").unwrap_or_default();
    let abs = raw
        .strip_prefix('~')
        .map(|s| format!("{home}{s}"))
        .unwrap_or_else(|| raw.to_owned());
    let (dir, prefix) = match abs.rfind('/') {
        None => (".", &*abs),
        Some(0) => ("/", &abs[1..]),
        Some(i) => (&abs[..i], &abs[i + 1..]),
    };
    let mut dirs = Vec::new();
    if crate::isolated_mode() && crate::scratch_path(Path::new(dir)).is_err() {
        return json!({"dirs":dirs});
    }
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let Ok(ty) = entry.file_type() else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            if !(ty.is_dir() || ty.is_symlink())
                || (name.starts_with('.') && !prefix.starts_with('.'))
                || !name.to_lowercase().starts_with(&prefix.to_lowercase())
            {
                continue;
            }
            let full = if dir == "/" {
                format!("/{name}")
            } else {
                format!("{dir}/{name}")
            };
            dirs.push(if !home.is_empty() && full.starts_with(&home) {
                format!("~{}", &full[home.len()..])
            } else {
                full
            });
        }
    }
    dirs.sort();
    dirs.truncate(24);
    json!({"dirs":dirs})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn isolated_report_settings_cannot_grant_access_outside_scratch() {
        let root = crate::scratch_root(
            &crate::workspace().join(format!(".scratch/file-guard-{}", uuid::Uuid::new_v4())),
        )
        .unwrap();
        let outside =
            crate::workspace().join(format!(".review-file-guard-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&outside).unwrap();
        let file = outside.join("scene.excalidraw");
        fs::write(&file, "unchanged").unwrap();
        let settings = root.join("settings.json");
        settings::save_explore(&settings, &json!({"reportPaths":[outside]})).unwrap();
        let result = (|| -> Result<()> {
            assert!(read_report(&settings, file.to_str().unwrap())?.is_none());
            assert!(!write_report(&settings, file.to_str().unwrap(), "changed")?);
            assert_eq!(
                delete_report(&settings, file.to_str().unwrap())?["ok"],
                false
            );
            assert_eq!(scan(&settings, true)?, json!([]));
            assert_eq!(fs::read_to_string(&file)?, "unchanged");
            Ok(())
        })();
        fs::remove_dir_all(outside).unwrap();
        fs::remove_dir_all(root).unwrap();
        result.unwrap();
    }
    #[test]
    fn configured_roots_reject_symlink_and_traversal_escapes_and_restrict_writes() {
        let root = crate::scratch_root(
            &crate::workspace().join(format!(".scratch/files-{}", uuid::Uuid::new_v4())),
        )
        .unwrap();
        let allowed = root.join("reports");
        fs::create_dir(&allowed).unwrap();
        let settings = root.join("settings.json");
        settings::save_explore(&settings, &json!({"reportPaths":[allowed]})).unwrap();
        fs::write(root.join("outside.html"), "outside").unwrap();
        std::os::unix::fs::symlink(root.join("outside.html"), allowed.join("escape.html")).unwrap();
        for path in [
            allowed.join("escape.html"),
            allowed.join("../outside.html"),
            root.join("missing"),
        ] {
            assert!(
                allowed_path(&settings, path.to_str().unwrap())
                    .unwrap()
                    .is_none()
            );
            assert!(!write_report(&settings, path.to_str().unwrap(), "overwrite").unwrap());
        }
        let scene = allowed.join("scene.excalidraw");
        fs::write(&scene, "{}").unwrap();
        assert!(write_report(&settings, scene.to_str().unwrap(), "{\"edited\":true}").unwrap());
        let report = allowed.join("report.html");
        fs::write(&report, "<html>report</html>").unwrap();
        assert!(!write_report(&settings, report.to_str().unwrap(), "overwrite").unwrap());
        assert_eq!(
            read_report(&settings, report.to_str().unwrap())
                .unwrap()
                .as_deref(),
            Some("<html>report</html>")
        );
        assert_eq!(
            fs::read_to_string(root.join("outside.html")).unwrap(),
            "outside"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn scanner_preserves_scratch_reports_ignores_builds_and_sniffs_local_assets() {
        let root = crate::scratch_root(
            &crate::workspace().join(format!(".scratch/scan-{}", uuid::Uuid::new_v4())),
        )
        .unwrap();
        for dir in [
            "reports/.scratch",
            "reports/build",
            "reports/vendor",
            "reports/.hidden",
        ] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        for (path, content) in [
            ("reports/.scratch/one.html", "<html>inline</html>"),
            (
                "reports/app.html",
                "<script src='/assets/index.js'></script>",
            ),
            ("reports/keep.ai.html", "<link href='./style.css'>"),
            (
                "reports/cdn.html",
                "<script src='//cdn.test/lib.js'></script>",
            ),
            ("reports/build/out.html", "x"),
            ("reports/vendor/lib.html", "x"),
            ("reports/.hidden/secret.html", "x"),
            ("reports/min.min.html", "x"),
            ("reports/scene.excalidraw", "{}"),
        ] {
            fs::write(root.join(path), content).unwrap();
        }
        let settings = root.join("settings.json");
        settings::save_explore(&settings,&json!({"reportPaths":[root.join("reports")],"ignorePaths":["vendor","**/*.{min,cache}.html"]})).unwrap();
        let result = scan(&settings, true).unwrap();
        let mut names = result
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["name"].as_str().unwrap())
            .collect::<Vec<_>>();
        names.sort();
        assert_eq!(
            names,
            vec!["cdn.html", "keep.ai.html", "one.html", "scene.excalidraw"]
        );
        let folder = list_folder(&settings, root.join("reports").to_str().unwrap())
            .unwrap()
            .unwrap();
        assert!(
            folder
                .as_array()
                .unwrap()
                .iter()
                .all(|v| !v["name"].as_str().unwrap().starts_with('.'))
        );
        assert_eq!(folder[0]["kind"], "dir");
        invalidate(&settings);
        fs::remove_dir_all(root).unwrap();
    }
}
