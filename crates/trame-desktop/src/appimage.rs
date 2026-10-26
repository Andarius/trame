use std::path::{Path, PathBuf};
use std::process::Command;

/// Moves the `AppImage` FUSE runtime to its own scope, so a scope stop cannot unmount the image under the app.
pub(crate) fn detach_mount_runtime() {
    let Some(image) = std::env::var_os("APPIMAGE") else {
        return;
    };
    if let Err(error) = detach(Path::new(&image)) {
        eprintln!("AppImage runtime stays in the app scope: {error}");
    }
}

fn detach(image: &Path) -> Result<(), String> {
    let cgroup = std::fs::read_to_string("/proc/self/cgroup").map_err(|e| e.to_string())?;
    let path = cgroup
        .lines()
        .find_map(|l| l.strip_prefix("0::"))
        .ok_or("no cgroup v2")?;
    let procs = std::fs::read_to_string(format!("/sys/fs/cgroup{path}/cgroup.procs"))
        .map_err(|e| e.to_string())?;
    let runtime = procs
        .lines()
        .filter_map(|pid| pid.parse::<u32>().ok())
        .find(|pid| std::fs::read_link(format!("/proc/{pid}/exe")).is_ok_and(|exe| exe == image))
        .ok_or("runtime not found in this cgroup")?;
    let status = Command::new("busctl")
        .args([
            "--user",
            "--quiet",
            "call",
            "org.freedesktop.systemd1",
            "/org/freedesktop/systemd1",
        ])
        .args([
            "org.freedesktop.systemd1.Manager",
            "StartTransientUnit",
            "ssa(sv)a(sa(sv))",
        ])
        .arg(format!("trame-appimage-{runtime}.scope"))
        .args(["fail", "1", "PIDs", "au", "1", &runtime.to_string(), "0"])
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("busctl {status}"))
    }
}

/// Replaces a `tramecli` installed as a plain file in `~/.local/bin` with the one bundled in this `AppImage`,
/// and a symlink into an `AppImage` mount (it dangles once that app quits). Other symlinks (dev checkout,
/// snap alias) are left alone.
pub(crate) fn refresh_cli() {
    if std::env::var_os("APPIMAGE").is_none() {
        return;
    }
    let (Ok(exe), Some(home)) = (std::env::current_exe(), std::env::var_os("HOME")) else {
        return;
    };
    let bundled = exe.with_file_name("tramecli");
    let installed = Path::new(&home).join(".local/bin/tramecli");
    std::thread::spawn(move || {
        if let Err(error) = replace_cli(&bundled, &installed) {
            eprintln!("tramecli stays as installed: {error}");
        }
    });
}

fn replace_cli(bundled: &Path, installed: &Path) -> std::io::Result<()> {
    let Ok(meta) = std::fs::symlink_metadata(installed) else {
        return Ok(());
    };
    let into_mount = meta.file_type().is_symlink()
        && std::fs::read_link(installed)?
            .components()
            .any(|c| c.as_os_str().to_string_lossy().starts_with(".mount_"));
    if !into_mount
        && (!meta.file_type().is_file() || std::fs::read(installed)? == std::fs::read(bundled)?)
    {
        return Ok(());
    }
    let tmp = installed.with_extension("new");
    std::fs::copy(bundled, &tmp)?;
    std::fs::set_permissions(&tmp, std::os::unix::fs::PermissionsExt::from_mode(0o755))?;
    std::fs::rename(&tmp, installed)?;
    eprintln!("tramecli → {}", installed.display());
    Ok(())
}

const ICON: &str = "icons/hicolor/512x512/apps/trame.png";

/// Points the menu entry and the `trame://` handler at this `AppImage` when they are missing or outdated.
pub(crate) fn register_scheme() {
    let Some(image) = std::env::var_os("APPIMAGE") else {
        return;
    };
    let Some(data) = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| Path::new(&h).join(".local/share")))
    else {
        return;
    };
    if let Err(error) = register(Path::new(&image), &data) {
        eprintln!("trame:// links stay unregistered: {error}");
    }
}

fn register(image: &Path, data: &Path) -> std::io::Result<()> {
    let entry = data.join("applications/trame.desktop");
    let existing = std::fs::read_to_string(&entry).ok();
    if !stale(existing.as_deref(), image) {
        return Ok(());
    }
    let icon = data.join(ICON);
    if !icon.exists()
        && let Some(dir) = std::env::var_os("APPDIR")
    {
        std::fs::create_dir_all(icon.parent().unwrap_or(data))?;
        if let Err(error) = std::fs::copy(Path::new(&dir).join("usr/share").join(ICON), &icon) {
            eprintln!("no app icon for the menu entry: {error}");
        }
    }
    std::fs::create_dir_all(entry.parent().unwrap_or(data))?;
    std::fs::write(&entry, desktop_entry(image, &icon))?;
    let dir = entry.parent().unwrap_or(data);
    // best effort: without these tools the entry still works once the menu rescans
    let _ = Command::new("update-desktop-database")
        .arg("-q")
        .arg(dir)
        .status();
    let _ = Command::new("xdg-mime")
        .args(["default", "trame.desktop", "x-scheme-handler/trame"])
        .status();
    eprintln!("trame:// links → {}", entry.display());
    Ok(())
}

/// Whether the entry needs (re)writing: missing, without the scheme, or launching an `AppImage` that is gone.
/// An entry for another existing install is left alone.
fn stale(existing: Option<&str>, image: &Path) -> bool {
    let Some(existing) = existing else {
        return true;
    };
    let exec = existing
        .lines()
        .find_map(|l| l.strip_prefix("Exec="))
        .map(|e| e.trim().trim_end_matches("%u").trim_end());
    let ours = exec.is_some_and(|e| Path::new(e) == image);
    if !ours && exec.is_some_and(|e| Path::new(e).exists()) {
        return false;
    }
    !(ours
        && existing.contains("%u")
        && existing
            .lines()
            .any(|l| l.starts_with("MimeType=") && l.contains("x-scheme-handler/trame;")))
}

// same entry as bin/quickstart.sh
fn desktop_entry(image: &Path, icon: &Path) -> String {
    format!(
        "[Desktop Entry]\nType=Application\nName=Trame\nComment=Local-first session tracker for coding work\n\
         Exec={} %u\nIcon={}\nStartupWMClass=trame\nTerminal=false\nCategories=Development;\n\
         MimeType=x-scheme-handler/trame;\n",
        image.display(),
        icon.display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_only_a_plain_outdated_cli() {
        let dir = std::env::temp_dir().join(format!("trame-cli-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bundled = dir.join("bundled");
        std::fs::write(&bundled, "new").unwrap();
        let plain = dir.join("plain");
        std::fs::write(&plain, "old").unwrap();
        let linked = dir.join("linked");
        std::os::unix::fs::symlink(&plain, &linked).unwrap();
        replace_cli(&bundled, &linked).unwrap();
        assert_eq!(
            std::fs::read_to_string(&plain).unwrap(),
            "old",
            "symlink target untouched"
        );
        let into_mount = dir.join("into-mount");
        std::os::unix::fs::symlink(dir.join(".mount_Trame.gone/usr/bin/tramecli"), &into_mount)
            .unwrap();
        replace_cli(&bundled, &into_mount).unwrap();
        assert_eq!(
            std::fs::read_to_string(&into_mount).unwrap(),
            "new",
            "a link into an AppImage mount becomes a copy"
        );
        replace_cli(&bundled, &plain).unwrap();
        assert_eq!(std::fs::read_to_string(&plain).unwrap(), "new");
        replace_cli(&bundled, &dir.join("missing")).unwrap();
        assert!(
            !dir.join("missing").exists(),
            "nothing installed where there was none"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rewrites_only_missing_or_outdated_entries() {
        let image = Path::new("/nonexistent/Trame.AppImage");
        let current = desktop_entry(image, Path::new("/icon.png"));
        for (existing, expected, case) in [
            (None, true, "missing"),
            (Some(current.clone()), false, "current"),
            (
                Some(
                    current
                        .replace(" %u", "")
                        .replace("MimeType=x-scheme-handler/trame;\n", ""),
                ),
                true,
                "pre-scheme entry",
            ),
            (
                Some(current.replace("/nonexistent/Trame.AppImage", "/nonexistent/Old.AppImage")),
                true,
                "launches a deleted image",
            ),
            (
                Some(current.replace("/nonexistent/Trame.AppImage", "/bin/sh")),
                false,
                "another existing install",
            ),
        ] {
            assert_eq!(stale(existing.as_deref(), image), expected, "{case}");
        }
    }
}
