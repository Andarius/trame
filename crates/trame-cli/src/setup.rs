use anyhow::{Result, bail};
use serde_json::{Value, json};
#[cfg(unix)]
use std::os::unix::fs::{PermissionsExt, symlink};
use std::{
    env, fs,
    io::{self, IsTerminal, Write},
    path::{Path, PathBuf},
    process::Command,
};

pub const TRACK_SKILL: &str = include_str!("../../../skills/trame-track/SKILL.md");
pub const TRACK_SKILL_OPENAI: &str = include_str!("../../../skills/trame-track/agents/openai.yaml");
pub const PAGE_SKILL: &str = include_str!("../../../skills/trame-page/SKILL.md");
pub const WATCH_SKILL: &str = include_str!("../../../skills/trame-watch/SKILL.md");
pub const TRAME_SKILL: &str = include_str!("../../../skills/trame/SKILL.md");
pub const PLUGIN_SKILL: &str = include_str!("../../../skills/trame-plugin/SKILL.md");
pub const PLUGIN_SKILL_TEMPLATES: &str =
    include_str!("../../../skills/trame-plugin/references/templates.md");
pub const PRE_PUSH: &str = include_str!("pre-push.sh");
const MOD_MANIFEST: &str = include_str!("../../../claude-mod/.claude-plugin/plugin.json");
const MOD_HOOKS: &str = include_str!("../../../claude-mod/hooks/hooks.json");
const MOD_REGISTER: &str = include_str!("../../../claude-mod/hooks/register.tsx");
const MOD_TYPES: &str = include_str!("../../../claude-mod/types/index.d.ts");

fn event_rules(harness: &str) -> Vec<(&'static str, Option<&'static str>)> {
    if harness == "claude" {
        vec![
            ("UserPromptSubmit", None),
            ("PreToolUse", None),
            (
                "Notification",
                Some("permission_prompt|elicitation_dialog|agent_needs_input"),
            ),
            ("Stop", None),
            ("SessionEnd", None),
        ]
    } else {
        vec![
            ("UserPromptSubmit", None),
            ("PreToolUse", None),
            ("Stop", None),
        ]
    }
}
pub fn with_presence_hooks(file: &Value, harness: &str) -> Value {
    let mut file = if file.is_object() {
        file.clone()
    } else {
        json!({})
    };
    let command = format!("tramecli presence --hook {harness}");
    if !file["hooks"].is_object() {
        file["hooks"] = json!({});
    }
    for (event, matcher) in event_rules(harness) {
        let hooks = file["hooks"][event].as_array().cloned().unwrap_or_default();
        let mut hooks = hooks;
        if !hooks.iter().any(|h| h.to_string().contains(&command)) {
            let mut entry = json!({"hooks":[{"type":"command","command":command,"timeout":5}]});
            if let Some(matcher) = matcher {
                entry["matcher"] = json!(matcher);
            }
            if harness == "claude" {
                entry["hooks"][0]["async"] = json!(true);
            }
            hooks.push(entry);
        }
        file["hooks"][event] = json!(hooks);
    }
    if harness == "claude" {
        let hooks = file["hooks"]["UserPromptSubmit"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if !hooks
            .iter()
            .any(|h| h.to_string().contains("tramecli hook"))
        {
            let mut hooks = hooks;
            hooks.push(json!({"matcher":"","hooks":[{"type":"command","command":"tramecli hook","timeout":5}]}));
            file["hooks"]["UserPromptSubmit"] = json!(hooks);
        }
    }
    file
}
pub fn install_presence_hooks(home: &str, report: bool) -> Result<Vec<String>> {
    let claude = env::var("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(home).join(".claude"));
    let targets = [
        (claude.join("settings.json"), "claude"),
        (PathBuf::from(home).join(".codex/hooks.json"), "codex"),
    ];
    let mut done = Vec::new();
    for (path, harness) in targets {
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        let old: Value = serde_json::from_str(&text)
            .map_err(|_| anyhow::anyhow!("{} is not valid JSON — fix it first", path.display()))?;
        let next = with_presence_hooks(&old, harness);
        if next != old {
            fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&next)?))?;
            done.push(path.to_string_lossy().into_owned());
        } else if report {
            done.push(path.to_string_lossy().into_owned());
        }
    }
    Ok(done)
}
fn write(path: &Path, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, content)?;
    println!("installed → {}", path.display());
    Ok(())
}
fn find_on_path(name: &str) -> Option<PathBuf> {
    let paths = env::var_os("PATH")?;
    for path in env::split_paths(&paths) {
        let candidate = path.join(name);
        #[cfg(unix)]
        let executable = candidate
            .metadata()
            .ok()
            .is_some_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0);
        #[cfg(not(unix))]
        let executable = candidate.is_file();
        if executable {
            return candidate.canonicalize().ok().or(Some(candidate));
        }
    }
    None
}
pub fn ensure_on_path(home: &str, self_path: &Path) -> Result<Option<String>> {
    let self_path = self_path
        .canonicalize()
        .unwrap_or_else(|_| self_path.to_path_buf());
    let dest = PathBuf::from(home).join(".local/bin/tramecli");
    let current = dest.canonicalize().ok();
    if current.as_deref() != Some(self_path.as_path()) {
        if let Err(error) = (|| -> Result<()> {
            fs::create_dir_all(dest.parent().unwrap())?;
            if dest.symlink_metadata().is_ok() {
                fs::remove_file(&dest)?;
            }
            #[cfg(unix)]
            symlink(&self_path, &dest)?;
            Ok(())
        })() {
            return Ok(Some(format!(
                "could not link {} ({error}) — put {} on PATH as `tramecli`",
                dest.display(),
                self_path.display()
            )));
        }
        println!("linked {} → {}", dest.display(), self_path.display());
    }
    let found = find_on_path("tramecli");
    if found.is_none() {
        return Ok(Some(format!(
            "{} is not on PATH — add ~/.local/bin to it, or the installed docs cannot call `tramecli`",
            dest.display()
        )));
    }
    if found.as_deref() != Some(self_path.as_path()) {
        return Ok(Some(format!(
            "`tramecli` still resolves to {}, ahead of {} on PATH — remove it, or agents keep running that build instead of this one",
            found.unwrap().display(),
            dest.display()
        )));
    }
    Ok(None)
}
pub fn install_hook(cwd: &Path) -> Result<PathBuf> {
    let out = Command::new("git")
        .args(["rev-parse", "--git-path", "hooks"])
        .current_dir(cwd)
        .output()?;
    if !out.status.success() {
        bail!("not a git repository: {}", cwd.display());
    }
    let relative = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    let dir = PathBuf::from(&relative);
    let dir = if dir.is_absolute() {
        dir
    } else {
        cwd.join(dir)
    };
    let path = dir.join("pre-push");
    if let Ok(existing) = fs::read_to_string(&path) {
        if !existing.contains("trame pre-push guard") {
            bail!(
                "{} exists and is not ours — move it aside first",
                path.display()
            );
        }
    }
    fs::create_dir_all(&dir)?;
    fs::write(&path, PRE_PUSH)?;
    #[cfg(unix)]
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755))?;
    Ok(path)
}
pub fn install_mod(home: &str) -> Result<PathBuf> {
    let dir = PathBuf::from(home).join(".local/share/trame/claude-mod");
    let files = [
        (
            ".claude-plugin/marketplace.json",
            r#"{"name":"trame","owner":{"name":"Trame"},"plugins":[{"name":"trame","source":"./trame"}]}"#,
        ),
        ("trame/.claude-plugin/plugin.json", MOD_MANIFEST),
        ("trame/hooks/hooks.json", MOD_HOOKS),
        ("trame/hooks/register.tsx", MOD_REGISTER),
        ("trame/types/index.d.ts", MOD_TYPES),
    ];
    for (path, content) in files {
        write(&dir.join(path), content)?;
    }
    for args in [
        vec!["plugin", "marketplace", "add", dir.to_str().unwrap()],
        vec!["plugin", "install", "trame@trame"],
    ] {
        let out = Command::new("claude").args(&args).output()?;
        let text = String::from_utf8_lossy(if out.status.success() {
            &out.stdout
        } else {
            &out.stderr
        });
        if !out.status.success() && !text.to_lowercase().contains("already") {
            bail!("claude {}: {}", args.join(" "), text.trim());
        }
    }
    Ok(dir)
}
pub fn install_skills(home: &str, claude: bool, dirs: &[String]) -> Result<()> {
    let mut dirs = dirs.to_vec();
    if claude {
        dirs.push(format!("{home}/.claude/skills"));
        let legacy = PathBuf::from(home).join(".claude/commands/trame");
        for name in ["track.md", "watch.md"] {
            let path = legacy.join(name);
            if fs::remove_file(&path).is_ok() {
                println!("removed {} (now a skill)", path.display());
            }
        }
        let _ = fs::remove_dir(legacy);
    }
    dirs.sort();
    dirs.dedup();
    let assets = [
        ("trame-track/SKILL.md", TRACK_SKILL),
        ("trame-track/agents/openai.yaml", TRACK_SKILL_OPENAI),
        ("trame-page/SKILL.md", PAGE_SKILL),
        ("trame-watch/SKILL.md", WATCH_SKILL),
        ("trame/SKILL.md", TRAME_SKILL),
        ("trame-plugin/SKILL.md", PLUGIN_SKILL),
        (
            "trame-plugin/references/templates.md",
            PLUGIN_SKILL_TEMPLATES,
        ),
    ];
    for dir in dirs {
        for (path, content) in assets {
            write(&PathBuf::from(&dir).join(path), content)?;
        }
    }
    Ok(())
}
fn choose_interactive(home: &str) -> Result<Option<(bool, Vec<String>)>> {
    if !io::stdout().is_terminal() {
        eprintln!("{}", crate::help::topic("SETUP_HELP"));
        return Ok(None);
    }
    println!(" tramecli setup ");
    println!("Which coding agents should Trame configure?");
    println!("  1. Claude Code (default)\n  2. Codex\n  3. Other agent");
    print!("Select numbers, comma-separated [1]: ");
    io::stdout().flush()?;
    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    let answer = answer.trim();
    if answer.eq_ignore_ascii_case("q") || answer.eq_ignore_ascii_case("cancel") {
        println!("Setup cancelled.");
        return Ok(None);
    }
    let answer = if answer.is_empty() { "1" } else { answer };
    let choices: Vec<_> = answer.split(',').map(str::trim).collect();
    if choices
        .iter()
        .any(|choice| !matches!(*choice, "1" | "2" | "3"))
    {
        bail!("choose 1, 2 or 3");
    }
    let claude = choices.contains(&"1");
    let mut dirs = Vec::new();
    if choices.contains(&"2") {
        dirs.push(format!("{home}/.agents/skills"));
    }
    if choices.contains(&"3") {
        print!("Skills directory of that agent (comma-separated for several): ");
        io::stdout().flush()?;
        answer_line(&mut dirs, home)?;
    }
    Ok(Some((claude, dirs)))
}
fn answer_line(dirs: &mut Vec<String>, home: &str) -> Result<()> {
    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    for dir in answer.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        dirs.push(if let Some(suffix) = dir.strip_prefix("~/") {
            format!("{home}/{suffix}")
        } else {
            dir.to_owned()
        });
    }
    if dirs.is_empty() {
        bail!("at least one directory");
    }
    Ok(())
}
pub fn run(args: &[String]) -> Result<i32> {
    let Ok(home) = env::var("HOME") else {
        eprintln!("HOME is not set");
        return Ok(1);
    };
    let mut claude = false;
    let mut hook = false;
    let mut presence = false;
    let mut plugin = false;
    let mut dirs = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--claude" => claude = true,
            "--codex" => dirs.push(format!("{home}/.agents/skills")),
            "--hook" => hook = true,
            "--presence" => presence = true,
            "--mod" => plugin = true,
            "--skills-dir" => {
                i += 1;
                let Some(dir) = args.get(i) else {
                    eprintln!("--skills-dir needs a directory");
                    return Ok(2);
                };
                dirs.push(if let Some(rest) = dir.strip_prefix("~/") {
                    format!("{home}/{rest}")
                } else {
                    dir.clone()
                });
            }
            unknown => {
                eprintln!(
                    "unknown flag: {unknown}\n\n{}",
                    crate::help::topic("SETUP_HELP")
                );
                return Ok(2);
            }
        }
        i += 1;
    }
    let interactive = !claude && dirs.is_empty() && !hook && !presence && !plugin;
    if interactive {
        if !io::stdout().is_terminal() {
            eprintln!("{}", crate::help::topic("SETUP_HELP"));
            return Ok(2);
        }
        let Some((picked_claude, picked_dirs)) = choose_interactive(&home)? else {
            return Ok(1);
        };
        claude = picked_claude;
        dirs.extend(picked_dirs);
    }
    let self_path = env::current_exe()?;
    let warning = ensure_on_path(&home, &self_path)?;
    install_skills(&home, claude, &dirs)?;
    if hook {
        match install_hook(&env::current_dir()?) {
            Ok(path) => println!("installed → {}", path.display()),
            Err(error) => {
                eprintln!("{error}");
                return Ok(1);
            }
        }
    }
    if presence {
        match install_presence_hooks(&home, true) {
            Ok(paths) => println!(
                "{}",
                if paths.is_empty() {
                    "no Claude Code or Codex config found".into()
                } else {
                    format!("presence hooks → {}", paths.join(", "))
                }
            ),
            Err(error) => {
                eprintln!("{error}");
                return Ok(1);
            }
        }
    }
    if plugin {
        match install_mod(&home) {
            Ok(dir) => println!(
                "claude mod → {} (run /reload-plugins in open sessions)",
                dir.display()
            ),
            Err(error) => {
                eprintln!("{error}");
                return Ok(1);
            }
        }
    }
    if let Some(warning) = warning {
        eprintln!("warning: {warning}");
    }
    println!("\n{}", crate::help::topic("QUERY_SYNTAX"));
    if interactive {
        println!("Trame agent integrations installed.");
    }
    Ok(0)
}
