use std::path::Path;
use std::process::Command;

/// Moves the AppImage's FUSE runtime to its own scope, so a scope stop cannot unmount the image under the app.
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
