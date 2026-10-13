use std::io::{self, Read};
use std::process::{Child, Command, Output, Stdio};
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
}
