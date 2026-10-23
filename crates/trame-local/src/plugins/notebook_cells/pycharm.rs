// Reads the active PyCharm keymap: the user's keymap files, then the bundled parents inside
// the installed IDE's jar, resolved child-over-parent like the IDE does.
use anyhow::{Context, Result, bail};
use regex::Regex;
use serde_json::{Map, Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::LazyLock,
};

/// action id → single-stroke shortcuts in `PyCharm` notation ("shift ctrl k")
pub(super) type Bindings = BTreeMap<String, Vec<String>>;

static KEYMAP_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<keymap\b([^>]*)>").unwrap());
static ATTR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(\w[\w-]*)="([^"]*)""#).unwrap());
static ACTION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?s)<action\s+id="([^"]+)"\s*(?:/>|>(.*?)</action>)"#).unwrap());
static SHORTCUT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<keyboard-shortcut\b([^>]*)/?>").unwrap());

fn attrs(tag: &str) -> Map<String, Value> {
    ATTR.captures_iter(tag)
        .map(|c| (c[1].to_owned(), json!(unescape(&c[2]))))
        .collect()
}

fn unescape(s: &str) -> String {
    s.replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

pub(super) struct Keymap {
    pub(super) name: String,
    pub(super) parent: Option<String>,
    /// an empty list removes the parent's shortcuts for that action
    pub(super) actions: Bindings,
}

/// Parses one keymap XML; two-stroke shortcuts are dropped (the editor has no chords).
pub(super) fn parse(xml: &str) -> Result<Keymap> {
    let head = KEYMAP_TAG.captures(xml).context("not a keymap file")?;
    let a = attrs(&head[1]);
    let name = a
        .get("name")
        .and_then(Value::as_str)
        .context("keymap without a name")?
        .to_owned();
    let parent = a.get("parent").and_then(Value::as_str).map(str::to_owned);
    let mut actions = Bindings::new();
    for c in ACTION.captures_iter(xml) {
        let keys = c.get(2).map_or_else(Vec::new, |body| {
            SHORTCUT
                .captures_iter(body.as_str())
                .map(|s| attrs(&s[1]))
                .filter(|s| !s.contains_key("second-keystroke"))
                .filter_map(|s| {
                    s.get("first-keystroke")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .collect()
        });
        actions.insert(c[1].to_owned(), keys);
    }
    Ok(Keymap {
        name,
        parent,
        actions,
    })
}

/// Child-over-parent resolution: a child's action replaces the parent's list wholesale.
pub(super) fn resolve(chain_root_first: &[Keymap]) -> Bindings {
    let mut out = Bindings::new();
    for km in chain_root_first {
        for (id, keys) in &km.actions {
            out.insert(id.clone(), keys.clone());
        }
    }
    out.retain(|_, keys| !keys.is_empty());
    out
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from)
}

/// Newest `~/.config/JetBrains/PyCharm*` (CE too), by version in the folder name.
pub(super) fn config_dir(base: &Path) -> Option<PathBuf> {
    let mut dirs: Vec<(Vec<u32>, PathBuf)> = std::fs::read_dir(base)
        .ok()?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let rest = name
                .strip_prefix("PyCharmCE")
                .or_else(|| name.strip_prefix("PyCharm"))?;
            let version: Vec<u32> = rest
                .split('.')
                .map(str::parse)
                .collect::<Result<_, _>>()
                .ok()?;
            Some((version, e.path()))
        })
        .collect();
    dirs.sort();
    dirs.pop().map(|(_, p)| p)
}

fn active_name(config: &Path) -> Option<String> {
    let re = Regex::new(r#"<active_keymap\s+name="([^"]+)""#).ok()?;
    [
        "options/linux/keymap.xml",
        "options/macos/keymap.xml",
        "options/windows/keymap.xml",
        "options/keymap.xml",
    ]
    .iter()
    .filter_map(|f| std::fs::read_to_string(config.join(f)).ok())
    .find_map(|s| re.captures(&s).map(|c| unescape(&c[1])))
}

/// Jars that may carry the bundled keymaps (Toolbox, snap, /opt installs).
fn ide_jars() -> Vec<PathBuf> {
    let h = home();
    let roots = [
        h.join(".local/share/JetBrains/Toolbox/apps"),
        PathBuf::from("/snap"),
        PathBuf::from("/opt"),
        h.join("Applications"),
        PathBuf::from("/Applications"),
    ];
    let mut jars = Vec::new();
    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for e in entries.flatten() {
            let n = e.file_name().to_string_lossy().to_lowercase();
            if !n.contains("pycharm") {
                continue;
            }
            for lib in [
                e.path().join("lib"),
                e.path().join("current/lib"),
                e.path().join("Contents/lib"),
            ] {
                let jar = lib.join("intellij.platform.ide.impl.jar");
                if jar.is_file() {
                    jars.push(jar);
                }
            }
        }
    }
    jars
}

fn bundled(name: &str, jars: &[PathBuf]) -> Option<String> {
    jars.iter().find_map(|jar| {
        let out = std::process::Command::new("unzip")
            .arg("-p")
            .arg(jar)
            .arg(format!("keymaps/{name}.xml"))
            .output()
            .ok()?;
        (out.status.success() && !out.stdout.is_empty())
            .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    })
}

fn user_keymap(config: &Path, name: &str) -> Option<String> {
    std::fs::read_dir(config.join("keymaps"))
        .ok()?
        .flatten()
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .find(|xml| parse(xml).is_ok_and(|k| k.name == name))
}

/// The active keymap of the newest `PyCharm` on this machine, resolved through its parents.
pub(super) fn import() -> Result<Value> {
    let config = config_dir(&home().join(".config/JetBrains"))
        .or_else(|| config_dir(&home().join("Library/Application Support/JetBrains")))
        .context("no PyCharm configuration found")?;
    let active = active_name(&config).unwrap_or_else(|| "$default".to_owned());
    let jars = ide_jars();
    let mut chain = Vec::new();
    let mut missing = Vec::new();
    let mut next = Some(active.clone());
    while let Some(name) = next.take() {
        if chain.len() > 8 {
            bail!("keymap parent chain too deep");
        }
        let Some(xml) = user_keymap(&config, &name).or_else(|| bundled(&name, &jars)) else {
            missing.push(name);
            break;
        };
        let km = parse(&xml)?;
        next.clone_from(&km.parent);
        chain.push(km);
    }
    if chain.is_empty() {
        bail!("keymap {active} not found");
    }
    let names: Vec<String> = chain.iter().map(|k| k.name.clone()).collect();
    chain.reverse();
    Ok(json!({
        "ide": config.file_name().map(|n| n.to_string_lossy().into_owned()),
        "keymap": active,
        "chain": names,
        "missing": missing,
        "actions": resolve(&chain),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn child_actions_replace_or_remove_the_parents() {
        let root = parse(r#"<keymap version="1" name="$default">
  <action id="EditorDuplicate"><keyboard-shortcut first-keystroke="ctrl d" /></action>
  <action id="EditorJoinLines"><keyboard-shortcut first-keystroke="shift ctrl j" /></action>
  <action id="Chord"><keyboard-shortcut first-keystroke="ctrl k" second-keystroke="ctrl c" /></action>
</keymap>"#).unwrap();
        let child = parse(
            r#"<keymap version="1" name="Custom &amp; Co" parent="$default">
  <action id="EditorDuplicate">
    <keyboard-shortcut first-keystroke="shift ctrl d" />
  </action>
  <action id="EditorJoinLines" />
</keymap>"#,
        )
        .unwrap();
        assert_eq!(
            (child.name.as_str(), child.parent.as_deref()),
            ("Custom & Co", Some("$default"))
        );
        let out = resolve(&[root, child]);
        assert_eq!(
            out.get("EditorDuplicate"),
            Some(&vec!["shift ctrl d".to_owned()])
        );
        assert!(!out.contains_key("EditorJoinLines"));
        assert!(!out.contains_key("Chord"));
    }

    #[test]
    fn config_dir_picks_the_newest_version() {
        let base = crate::scratch_root(
            &crate::workspace().join(format!(".scratch/jb-{}", uuid::Uuid::new_v4())),
        )
        .unwrap();
        for d in [
            "PyCharm2026.2",
            "PyCharm2026.10",
            "PyCharmCE2025.3",
            "GoLand2027.1",
            "PyCharm-old",
        ] {
            std::fs::create_dir_all(base.join(d)).unwrap();
        }
        assert_eq!(
            config_dir(&base).unwrap().file_name().unwrap(),
            "PyCharm2026.10"
        );
        std::fs::remove_dir_all(base).unwrap();
    }
}
