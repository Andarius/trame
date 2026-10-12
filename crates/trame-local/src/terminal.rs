use serde_json::{Value, json};
use std::process::{Command, Stdio};

pub fn shq(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
pub fn ghostty_running() -> bool {
    Command::new("pgrep")
        .args(["-x", "ghostty"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}
fn spawn(bin: &str, args: &[String]) -> bool {
    let Ok(mut child) = Command::new(bin)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    true
}
pub fn spawn_terminal(cwd: &str, command: &str, mode: &str) -> bool {
    let inner = format!("cd {} && {command}", shq(cwd));
    if cfg!(target_os = "macos") {
        let quoted = format!("\"{}\"", inner.replace('\\', "\\\\").replace('"', "\\\""));
        let lines = if mode == "tab" {
            vec![
                "tell application \"Terminal\" to activate".into(),
                "tell application \"System Events\" to keystroke \"t\" using command down".into(),
                format!("tell application \"Terminal\" to do script {quoted} in front window"),
            ]
        } else {
            vec![
                format!("tell application \"Terminal\" to do script {quoted}"),
                "tell application \"Terminal\" to activate".into(),
            ]
        };
        return spawn(
            "osascript",
            &lines
                .into_iter()
                .flat_map(|line| ["-e".into(), line])
                .collect::<Vec<_>>(),
        );
    }
    let keep = format!(
        "{inner}; exec {}",
        std::env::var("SHELL").unwrap_or_else(|_| "bash".into())
    );
    let mut terms = if mode == "tab" {
        vec![
            ("konsole", vec!["--new-tab", "-e"]),
            ("gnome-terminal", vec!["--tab", "--"]),
        ]
    } else {
        vec![("gnome-terminal", vec!["--"]), ("konsole", vec!["-e"])]
    };
    terms.extend([("x-terminal-emulator", vec!["-e"]), ("xterm", vec!["-e"])]);
    if ghostty_running() {
        terms.insert(0, ("ghostty", vec!["+new-window", "-e"]));
    }
    terms.into_iter().any(|(bin, args)| {
        let mut args = args.into_iter().map(str::to_owned).collect::<Vec<_>>();
        args.extend(["bash".into(), "-lc".into(), keep.clone()]);
        spawn(bin, &args)
    })
}

fn qdbus_raw(args: &[&str]) -> (bool, String, String) {
    for bin in ["qdbus6", "qdbus"] {
        if let Ok(out) = Command::new(bin).args(args).stdin(Stdio::null()).output() {
            return (
                out.status.success(),
                String::from_utf8_lossy(&out.stdout).trim().to_owned(),
                String::from_utf8_lossy(&out.stderr).trim().to_owned(),
            );
        }
    }
    (false, String::new(), "qdbus not found".into())
}
fn qdbus(args: &[&str]) -> Option<String> {
    let (ok, out, _) = qdbus_raw(args);
    ok.then_some(out)
}
fn active_konsole() -> Option<String> {
    let list = qdbus(&[])?;
    let mut services = list
        .lines()
        .map(str::trim)
        .filter(|s| s.starts_with("org.kde.konsole-"))
        .collect::<Vec<_>>();
    if services.len() > 1 {
        for service in &services {
            if qdbus(&[
                service,
                "/konsole/MainWindow_1",
                "org.qtproject.Qt.QWidget.isActiveWindow",
            ])
            .as_deref()
                == Some("true")
            {
                return Some((*service).to_owned());
            }
        }
        services.sort_by_key(|s| {
            std::cmp::Reverse(
                s.strip_prefix("org.kde.konsole-")
                    .and_then(|s| s.parse::<u32>().ok())
                    .unwrap_or(0),
            )
        });
    }
    services.first().map(|s| (*s).to_owned())
}
pub fn konsole_can_type() -> bool {
    let Some(service) = active_konsole() else {
        return false;
    };
    let Some(session) = qdbus(&[
        &service,
        "/Windows/1",
        "org.kde.konsole.Window.currentSession",
    ])
    .filter(|s| !s.is_empty()) else {
        return false;
    };
    qdbus_raw(&[
        &service,
        &format!("/Sessions/{session}"),
        "org.kde.konsole.Session.sendText",
        "",
    ])
    .0
}
pub fn in_existing(cwd: &str, command: &str, tab: bool) -> Value {
    let Some(service) = active_konsole() else {
        return json!({"ok":false,"reason":"no-konsole"});
    };
    let Some(session) = qdbus(&[
        &service,
        "/Windows/1",
        if tab {
            "org.kde.konsole.Window.newSession"
        } else {
            "org.kde.konsole.Window.currentSession"
        },
    ])
    .filter(|s| !s.is_empty()) else {
        return json!({"ok":false,"reason":"no-konsole"});
    };
    let (ok, out, err) = qdbus_raw(&[
        &service,
        &format!("/Sessions/{session}"),
        "org.kde.konsole.Session.sendText",
        &format!("cd {} && {command}\n", shq(cwd)),
    ]);
    if ok {
        return json!({"ok":true});
    }
    let message = if tab { format!("{err}\n{out}") } else { err }.to_lowercase();
    json!({"ok":false,"reason":if message.contains("disabled in the settings")||message.contains("accessdenied"){"api-disabled"}else{"no-konsole"}})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shell_quote_keeps_commands_literal() {
        let value = "a'b; $(printf injected) `printf injected`\nother";
        let result = Command::new("sh")
            .args(["-c", &format!("printf %s {}", shq(value))])
            .output()
            .unwrap();
        assert!(result.status.success());
        assert_eq!(String::from_utf8(result.stdout).unwrap(), value);
    }
}
