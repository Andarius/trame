use crate::{help, target::data_file};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{env, fs, path::Path, path::PathBuf, process::Command};

const TRAME: &str = "https://github.com/Andarius/trame.git";

/// `owner/repo` or `owner/repo@tag`, the shape compose-plugins.ts accepts.
pub fn valid_spec(spec: &str) -> bool {
    let (repo, tag) = spec
        .split_once('@')
        .map_or((spec, None), |(r, t)| (r, Some(t)));
    let name = |s: &str| {
        !s.is_empty()
            && !s.starts_with('.')
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    };
    let tag_ok = tag.is_none_or(|t| {
        !t.is_empty()
            && !t.starts_with(['-', '.'])
            && !t.contains("..")
            && t.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'/'))
    });
    let mut parts = repo.split('/');
    parts.next().is_some_and(name)
        && parts.next().is_some_and(name)
        && parts.next().is_none()
        && tag_ok
}

fn repo_of(spec: &str) -> String {
    spec.split('@').next().unwrap_or(spec).to_ascii_lowercase()
}

/// `specs` with `added` in place of any entry for the same repo.
pub fn with_added(specs: &[String], added: &[String]) -> Vec<String> {
    let mut out: Vec<String> = specs
        .iter()
        .filter(|s| !added.iter().any(|a| repo_of(a) == repo_of(s)))
        .cloned()
        .collect();
    out.extend(added.iter().cloned());
    out
}

fn list_file() -> PathBuf {
    data_file("TRAME_PLUGINS_FILE", "plugins.json")
}

fn load(path: &Path) -> Result<Vec<String>> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Ok(Vec::new());
    };
    let value: Value = serde_json::from_str(&raw).with_context(|| path.display().to_string())?;
    Ok(value["plugins"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect())
}

fn save(path: &Path, specs: &[String]) -> Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(
        path,
        serde_json::to_string_pretty(&json!({ "plugins": specs }))? + "\n",
    )?;
    Ok(())
}

fn run(cmd: &mut Command) -> Result<()> {
    let shown = format!("{cmd:?}");
    let status = cmd.status().with_context(|| shown.clone())?;
    if !status.success() {
        bail!("{shown} failed ({status})");
    }
    Ok(())
}

// PATH plus the usual per-user toolchain dirs, which a desktop launch may not carry
fn build_path() -> std::ffi::OsString {
    let home = PathBuf::from(env::var_os("HOME").unwrap_or_default());
    let paths = env::var_os("PATH").unwrap_or_default();
    let extra = [".cargo/bin", ".bun/bin"].map(|d| home.join(d));
    env::join_paths(env::split_paths(&paths).chain(extra)).unwrap_or(paths)
}

fn on_path(tool: &str) -> bool {
    env::split_paths(&build_path()).any(|d| d.join(tool).is_file())
}

/// The highest plain `vX.Y.Z` among `git ls-remote --tags` lines.
pub fn highest_tag(ls_remote: &str) -> Option<String> {
    ls_remote
        .lines()
        .filter_map(|l| l.split_once("refs/tags/")?.1.strip_prefix('v'))
        .filter_map(|v| {
            let parts: Vec<u64> = v
                .split('.')
                .map(str::parse)
                .collect::<Result<_, _>>()
                .ok()?;
            (parts.len() == 3).then(|| (parts, v.to_owned()))
        })
        .max()
        .map(|(_, v)| format!("v{v}"))
}

fn latest_trame() -> Result<String> {
    let out = Command::new("git")
        .args(["ls-remote", "--tags", "--refs", TRAME, "v*"])
        .output()?;
    if !out.status.success() {
        bail!("git ls-remote {TRAME} failed");
    }
    highest_tag(&String::from_utf8_lossy(&out.stdout)).context("Trame has no release tag")
}

// a Trame checkout at `tag`, kept between builds so cargo stays incremental
fn checkout(tag: &str) -> Result<PathBuf> {
    let base = env::var_os("XDG_CACHE_HOME").map_or_else(
        || PathBuf::from(env::var_os("HOME").unwrap_or_default()).join(".cache"),
        PathBuf::from,
    );
    let dir = base.join("trame/build");
    if !dir.join(".git").is_dir() {
        fs::create_dir_all(base.join("trame"))?;
        run(Command::new("git")
            .args(["clone", "--depth", "1", "--branch", tag, TRAME])
            .arg(&dir))?;
        return Ok(dir);
    }
    let at = Command::new("git")
        .args(["describe", "--tags", "--exact-match"])
        .current_dir(&dir)
        .output()?;
    if String::from_utf8_lossy(&at.stdout).trim() != tag {
        run(Command::new("git")
            .args(["fetch", "--depth", "1", "origin", "tag", tag])
            .current_dir(&dir))?;
        run(Command::new("git")
            .args(["checkout", "--force", "--quiet", tag])
            .current_dir(&dir))?;
    }
    Ok(dir)
}

fn build(list: &Path, format: &str, tag: &str) -> Result<PathBuf> {
    let missing: Vec<_> = ["git", "bun", "npm", "cargo"]
        .into_iter()
        .filter(|t| !on_path(t))
        .collect();
    if !missing.is_empty() {
        bail!(
            "building needs {} on PATH (see `tramecli plugins --help`)",
            missing.join(", ")
        );
    }
    let dir = checkout(tag)?;
    let path = build_path();
    run(Command::new("bun")
        .args(["install", "--frozen-lockfile"])
        .env("PATH", &path)
        .current_dir(&dir))?;
    run(Command::new("bun")
        .arg("scripts/compose-plugins.ts")
        .arg(list)
        .env("PATH", &path)
        .current_dir(&dir))?;
    // updates rebuild with the plugins instead of downloading a release without them
    run(Command::new("bash")
        .args(["scripts/rust-package.sh", format])
        .env("PATH", &path)
        .env("TRAME_UPDATE_VIA", "rebuild")
        .current_dir(&dir))?;
    Ok(dir.join(match format {
        "deb" => "dist/linux/trame.deb",
        "dmg" => "dist/macos/Trame.dmg",
        _ => "dist/linux/Trame.AppImage",
    }))
}

pub fn main(args: &[String]) -> Result<i32> {
    let path = list_file();
    let mut specs = load(&path)?;
    let (sub, rest) = args
        .split_first()
        .map_or(("list", &[][..]), |(s, r)| (s.as_str(), r));
    let format = if rest.iter().any(|a| a == "--deb") {
        "deb"
    } else if cfg!(target_os = "macos") {
        "dmg"
    } else {
        "appimage"
    };
    let names: Vec<String> = rest
        .iter()
        .filter(|a| !a.starts_with("--"))
        .cloned()
        .collect();
    match sub {
        "list" => {
            for spec in &specs {
                println!("{spec}");
            }
            if specs.is_empty() {
                println!("no plugins; add one with `tramecli plugins add owner/repo`");
            }
            return Ok(0);
        }
        "add" | "remove" => {
            if names.is_empty() {
                eprintln!("{}", help::topic("PLUGINS_HELP"));
                return Ok(2);
            }
            if let Some(bad) = names.iter().find(|n| !valid_spec(n)) {
                eprintln!("not owner/repo[@tag]: {bad}");
                return Ok(2);
            }
            specs = if sub == "add" {
                with_added(&specs, &names)
            } else {
                specs
                    .into_iter()
                    .filter(|s| !names.iter().any(|n| repo_of(n) == repo_of(s)))
                    .collect()
            };
            save(&path, &specs)?;
            if rest.iter().any(|a| a == "--no-build") {
                return Ok(0);
            }
        }
        "build" => {}
        other => {
            eprintln!(
                "unknown subcommand: {other}\n\n{}",
                help::topic("PLUGINS_HELP")
            );
            return Ok(2);
        }
    }
    let install = rest.iter().find_map(|a| a.strip_prefix("--install="));
    if install.is_some() && format != "appimage" {
        bail!("--install only replaces an AppImage");
    }
    let tag = if rest.iter().any(|a| a == "--latest") {
        latest_trame()?
    } else {
        format!("v{}", env!("CARGO_PKG_VERSION"))
    };
    let built = build(&path, format, &tag)?;
    println!("built {}", built.display());
    let Some(target) = install else {
        println!("install it in place of your current Trame, then restart it");
        return Ok(0);
    };
    // atomic: a running image keeps its inode
    let staged = PathBuf::from(format!("{target}.new"));
    fs::copy(&built, &staged).with_context(|| staged.display().to_string())?;
    fs::rename(&staged, target).with_context(|| target.to_owned())?;
    println!("installed {target}; restart Trame to run it");
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specs_are_owner_repo_with_an_optional_tag() {
        for (spec, want) in [
            ("Andarius/trame-notebook-cells", true),
            ("Andarius/trame-notebook-cells@v0.1.0", true),
            ("owner/repo@release/1.0", true),
            ("owner", false),
            ("owner/repo/extra", false),
            ("../repo", false),
            ("owner/repo@", false),
            ("owner/repo@-x", false),
            ("owner/repo@a..b", false),
            ("owner/repo@a@b", false),
        ] {
            assert_eq!(valid_spec(spec), want, "{spec}");
        }
    }

    #[test]
    fn highest_tag_takes_the_newest_plain_release() {
        let ls = "a\trefs/tags/v0.9.0\nb\trefs/tags/v0.25.0\nc\trefs/tags/v0.24.1\nd\trefs/tags/v1.0.0-rc1\ne\trefs/tags/other";
        assert_eq!(highest_tag(ls).as_deref(), Some("v0.25.0"));
        assert_eq!(highest_tag(""), None);
    }

    #[test]
    fn adding_a_listed_repo_replaces_its_tag() {
        let specs = ["a/x@v1".to_owned(), "b/y".to_owned()];
        assert_eq!(
            with_added(&specs, &["A/X@v2".to_owned(), "c/z".to_owned()]),
            ["b/y", "A/X@v2", "c/z"]
        );
    }
}
