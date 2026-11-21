/// SIGKILLs our web content processes so their exit handlers never run: Mesa aborts in them and KDE shows a crash dialog.
#[allow(unsafe_code, reason = "libc::kill on our own children")]
pub(crate) fn kill_web_processes() {
    let Ok(tasks) = std::fs::read_dir("/proc/self/task") else {
        return;
    };
    for task in tasks.flatten() {
        let Ok(children) = std::fs::read_to_string(task.path().join("children")) else {
            continue;
        };
        for pid in children
            .split_whitespace()
            .filter_map(|pid| pid.parse::<libc::pid_t>().ok())
        {
            // comm is truncated to 15 bytes
            if std::fs::read_to_string(format!("/proc/{pid}/comm"))
                .is_ok_and(|comm| comm.trim_end() == "WebKitWebProces")
            {
                unsafe { libc::kill(pid, libc::SIGKILL) };
            }
        }
    }
}

/// On Wayland, `WebKit`'s DMA-BUF renderer flickers when the window moves between screens of different scales.
#[allow(unsafe_code, reason = "set_var before any thread starts")]
pub(crate) fn avoid_scale_flicker() {
    if std::env::var_os("WAYLAND_DISPLAY").is_some()
        && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
    {
        // SAFETY: first call in main, the process is still single-threaded
        unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
    }
}
