use std::ffi::OsString;
use std::io::{self, Read};
use std::process::{Child, Command, Output, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// Bound for network-bound CLIs (gh, glab), so a hung call cannot stall requests or shutdown.
pub const NETWORK_TIMEOUT: Duration = Duration::from_secs(30);

/// Like [`Command::output`], but kills the child once `timeout` has elapsed.
pub fn output_within(command: &mut Command, timeout: Duration) -> io::Result<Output> {
    let mut child = command.stdout(Stdio::piped()).spawn()?;
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let status = wait_within(&mut child, timeout)?;
    Ok(Output {
        status,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
}

const PATH_MARK: &str = "@@trame-path@@";

/// `$PATH` plus the login shell's, which a desktop launch lacks (Homebrew's `gh`, `glab`, …).
pub fn user_path() -> OsString {
    static PATH: OnceLock<OsString> = OnceLock::new();
    PATH.get_or_init(|| {
        let own = std::env::var_os("PATH").unwrap_or_default();
        let login = login_path().unwrap_or_default();
        let all = std::env::split_paths(&own).chain(std::env::split_paths(&login));
        std::env::join_paths(all).unwrap_or(own)
    })
    .clone()
}

fn login_path() -> Option<String> {
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty())?;
    let script = format!("printf '{PATH_MARK}%s{PATH_MARK}' \"$PATH\"");
    let mut probe = Command::new(shell);
    for (key, value) in crate::host_env::host_env() {
        match value {
            Some(value) => probe.env(key, value),
            None => probe.env_remove(key),
        };
    }
    probe
        .args(["-l", "-i", "-c", &script])
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    let out = output_within(&mut probe, Duration::from_secs(8)).ok()?;
    marked_path(&String::from_utf8_lossy(&out.stdout)).map(str::to_owned)
}

/// The PATH between the markers, ignoring whatever the shell profile prints around it.
fn marked_path(out: &str) -> Option<&str> {
    let (_, rest) = out.split_once(PATH_MARK)?;
    let (path, _) = rest.split_once(PATH_MARK)?;
    Some(path).filter(|p| !p.is_empty())
}

fn drain(pipe: Option<impl Read + Send + 'static>) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut buffer);
        }
        buffer
    })
}

fn wait_within(child: &mut Child, timeout: Duration) -> io::Result<std::process::ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            child.wait()?;
            return Err(io::Error::new(io::ErrorKind::TimedOut, "command timed out"));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_within_returns_output_or_kills_on_timeout() {
        let out = output_within(
            Command::new("sh").args(["-c", "echo hi"]),
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(out.stdout, b"hi\n");
        let started = Instant::now();
        let error =
            output_within(Command::new("sleep").arg("30"), Duration::from_millis(200)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn marked_path_skips_the_profile_noise() {
        for (out, want) in [
            (
                "@@trame-path@@/a/bin:/b/bin@@trame-path@@",
                Some("/a/bin:/b/bin"),
            ),
            (
                "welcome!\n\x1b]7;file://x\x07@@trame-path@@/a/bin@@trame-path@@bye\n",
                Some("/a/bin"),
            ),
            ("@@trame-path@@@@trame-path@@", None),
            ("@@trame-path@@/a/bin", None),
        ] {
            assert_eq!(marked_path(out), want, "{out:?}");
        }
    }
}
