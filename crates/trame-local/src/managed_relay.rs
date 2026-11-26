use axum::{
    body::{Body, to_bytes},
    http::{Method, Request},
    response::Response,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    fs,
    io::ErrorKind,
    net::{Ipv4Addr, Ipv6Addr, SocketAddr},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt as _, BufReader},
    process::{Child, Command},
    sync::{Mutex, watch},
    time::timeout,
};

const SETTING: &str = "managedAgentRelay";
const DEFAULT_LISTEN: &str = "127.0.0.1:8770";
const START_TIMEOUT: Duration = Duration::from_secs(30);
const STOP_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Deserialize)]
struct ConfigFile {
    name: Option<String>,
    hostname: Option<String>,
    mcp_listen: Option<String>,
}

pub(crate) struct ConfiguredRelay {
    config: PathBuf,
    home: Option<PathBuf>,
    state: PathBuf,
    pub(crate) listen: String,
    isolated: bool,
}

impl ConfiguredRelay {
    pub(crate) fn read(isolated: bool) -> Result<Option<Self>, &'static str> {
        let mut home = env_path("AGENT_RELAY_HOME");
        if isolated {
            let Some(path) = home else {
                return Ok(None);
            };
            home = Some(
                crate::scratch_path(&path)
                    .map_err(|_| "Relay home is outside the isolated workspace.")?,
            );
        }
        let user_home = env_path("HOME");
        let config = env_path("AGENT_RELAY_CONFIG")
            .or_else(|| home.as_ref().map(|p| p.join("config.json")))
            .or_else(|| default_config(user_home.as_deref()))
            .ok_or("Relay configuration path is unavailable.")?;
        let config = confine(config, isolated)?;
        let bytes = match fs::read(&config) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("Unable to read the relay configuration."),
        };
        let file: ConfigFile =
            serde_json::from_slice(&bytes).map_err(|_| "Relay configuration is invalid.")?;
        let hostname = file
            .hostname
            .filter(|s| !s.is_empty())
            .or_else(|| {
                file.name
                    .filter(|s| !s.is_empty())
                    .map(|name| format!("relay-{name}"))
            })
            .ok_or("Relay configuration is missing its hostname.")?;
        if !hostname
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err("Relay hostname is invalid.");
        }
        let state = home
            .as_ref()
            .map(|p| p.join("state"))
            .or_else(|| user_home.map(|p| p.join(".local/share/agent-relay")))
            .ok_or("Relay state directory is unavailable.")?
            .join(hostname);
        let state = confine(state, isolated)?;
        let listen = file
            .mcp_listen
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_LISTEN.into());
        Ok(Some(Self {
            config,
            home,
            state,
            listen,
            isolated,
        }))
    }

    pub(crate) fn state_file(&self, name: &str) -> Result<PathBuf, &'static str> {
        confine(self.state.join(name), self.isolated)
    }
}

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn default_config(home: Option<&Path>) -> Option<PathBuf> {
    let base = if cfg!(target_os = "macos") {
        home?.join("Library/Application Support")
    } else if let Some(xdg) = env_path("XDG_CONFIG_HOME") {
        if !xdg.is_absolute() {
            return None;
        }
        xdg
    } else {
        home?.join(".config")
    };
    Some(base.join("agent-relay/config.json"))
}

fn confine(path: PathBuf, isolated: bool) -> Result<PathBuf, &'static str> {
    if isolated {
        if fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_symlink()) && !path.exists() {
            return Err("Relay file is outside the isolated workspace.");
        }
        crate::scratch_path(&path).map_err(|_| "Relay file is outside the isolated workspace.")
    } else {
        Ok(path)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Phase {
    Off,
    Unavailable,
    SetupRequired,
    External,
    Starting,
    Running,
    Error,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Progress {
    Starting,
    NeedsLogin,
    Running,
}

struct Managed {
    child: Child,
    progress: watch::Receiver<Progress>,
    since: Instant,
}

impl Managed {
    fn spawn(binary: &Path, config: &ConfiguredRelay) -> std::io::Result<Self> {
        let mut command = Command::new(binary);
        command
            .arg("serve")
            .env("AGENT_RELAY_CONFIG", &config.config)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(home) = &config.home {
            command.env("AGENT_RELAY_HOME", home);
        }
        // Enrollment belongs to explicit relay setup.
        for key in [
            "TS_AUTHKEY",
            "TS_AUTH_KEY",
            "TS_CLIENT_SECRET",
            "TS_CLIENT_ID",
            "TS_ID_TOKEN",
            "TS_AUDIENCE",
        ] {
            command.env_remove(key);
        }
        let mut child = command.spawn()?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| std::io::Error::other("relay stderr unavailable"))?;
        let (status, progress) = watch::channel(Progress::Starting);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Some((_, message)) = line.split_once(" INFO ") else {
                    continue;
                };
                if message.starts_with("peer api up ") {
                    status.send_replace(Progress::Running);
                } else if message.starts_with("tailnet login needed ") {
                    status.send_replace(Progress::NeedsLogin);
                }
            }
        });
        Ok(Self {
            child,
            progress,
            since: Instant::now(),
        })
    }

    #[allow(unsafe_code, reason = "SIGTERM to the supervised child")]
    async fn stop(mut self) {
        if self.child.try_wait().is_ok_and(|result| result.is_some()) {
            return;
        }
        if let Some(pid) = self.child.id().and_then(|id| i32::try_from(id).ok()) {
            // The unreaped child still owns this PID.
            unsafe { libc::kill(pid, libc::SIGTERM) };
        }
        if !matches!(timeout(STOP_TIMEOUT, self.child.wait()).await, Ok(Ok(_))) {
            let _ = self.child.kill().await;
        }
    }
}

struct Runtime {
    enabled: bool,
    closed: bool,
    phase: Phase,
    detail: String,
    managed: Option<Managed>,
}

impl Runtime {
    fn set(&mut self, phase: Phase, detail: impl Into<String>) {
        self.phase = phase;
        self.detail = detail.into();
    }

    async fn stop_owned(&mut self) {
        if let Some(managed) = self.managed.take() {
            managed.stop().await;
        }
    }

    async fn refresh(&mut self) {
        let Some(managed) = &mut self.managed else {
            return;
        };
        match managed.child.try_wait() {
            Ok(None) => {}
            Ok(Some(status)) => {
                self.managed = None;
                self.set(Phase::Error, format!("Agent relay exited with {status}."));
                return;
            }
            Err(_) => {
                self.stop_owned().await;
                self.set(Phase::Error, "Unable to check the agent relay process.");
                return;
            }
        }
        let progress = *managed.progress.borrow();
        match progress {
            Progress::Running => self.set(Phase::Running, "Running in Trame."),
            Progress::NeedsLogin => {
                self.stop_owned().await;
                self.set(
                    Phase::SetupRequired,
                    "The relay needs to sign in to its tailnet again.",
                );
            }
            Progress::Starting if managed.since.elapsed() >= START_TIMEOUT => {
                self.stop_owned().await;
                self.set(
                    Phase::Error,
                    "The relay timed out connecting to its tailnet.",
                );
            }
            Progress::Starting => {}
        }
    }
}

pub(crate) struct Service {
    settings: PathBuf,
    binary: Option<PathBuf>,
    unsupported_os: bool,
    demo: bool,
    isolated: bool,
    runtime: Mutex<Runtime>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Action {
    Enable,
    Disable,
    Restart,
}

impl Service {
    pub(crate) fn new(settings: PathBuf, root: &Path, demo: bool) -> Self {
        let binary = std::env::current_exe()
            .ok()
            .map(|p| p.with_file_name("agent-relay"))
            .filter(|p| p.is_file());
        let enabled = crate::settings::read(&settings)[SETTING] == true;
        let isolated = crate::isolated_mode() || crate::scratch_path(root).is_ok();
        Self {
            settings,
            binary,
            unsupported_os: unsupported_os(),
            demo,
            isolated,
            runtime: Mutex::new(Runtime {
                enabled,
                closed: false,
                phase: Phase::Off,
                detail: String::new(),
                managed: None,
            }),
        }
    }

    pub(crate) async fn start(self: &Arc<Self>) {
        self.launch(&mut *self.runtime.lock().await).await;
        let relay = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(2)).await;
                let Some(relay) = relay.upgrade() else {
                    break;
                };
                let mut runtime = relay.runtime.lock().await;
                if runtime.closed {
                    break;
                }
                if runtime.phase == Phase::External {
                    relay.launch(&mut runtime).await;
                } else {
                    runtime.refresh().await;
                }
            }
        });
    }

    pub(crate) async fn shutdown(&self) {
        let mut runtime = self.runtime.lock().await;
        runtime.closed = true;
        runtime.stop_owned().await;
    }

    fn available_binary(&self) -> Result<&Path, &'static str> {
        if self.demo {
            return Err("The agent relay is disabled in the demo.");
        }
        let binary = self
            .binary
            .as_deref()
            .ok_or("This build does not include the agent relay.")?;
        if self.unsupported_os {
            return Err("The bundled relay requires macOS 13 or newer.");
        }
        if self.isolated && env_path("AGENT_RELAY_HOME").is_none() {
            return Err(
                "Set AGENT_RELAY_HOME under this workspace’s .scratch directory to use the relay here.",
            );
        }
        Ok(binary)
    }

    async fn launch(&self, runtime: &mut Runtime) {
        let binary = match self.available_binary() {
            Ok(binary) => binary,
            Err(detail) => {
                runtime.set(Phase::Unavailable, detail);
                return;
            }
        };
        if !runtime.enabled {
            runtime.set(Phase::Off, "Trame manages the relay when enabled.");
            return;
        }
        let isolated = self.isolated;
        let config = crate::blocking::spawn(move || ConfiguredRelay::read(isolated))
            .await
            .unwrap_or(Err("Unable to read the relay configuration."));
        match config {
            Ok(Some(config)) => Self::launch_configured(runtime, binary, &config).await,
            Ok(None) => {
                runtime.set(
                    Phase::SetupRequired,
                    "Set up the relay on this machine first.",
                );
            }
            Err(detail) => {
                runtime.set(Phase::Error, detail);
            }
        }
    }

    async fn launch_configured(runtime: &mut Runtime, binary: &Path, config: &ConfiguredRelay) {
        let Some(addresses) = listen_addresses(&config.listen) else {
            runtime.set(
                Phase::Error,
                "Set the relay’s mcp_listen to a loopback address with a fixed port.",
            );
            return;
        };
        for address in addresses {
            if timeout(
                Duration::from_millis(300),
                tokio::net::TcpStream::connect(address),
            )
            .await
            .is_ok_and(|r| r.is_ok())
            {
                runtime.set(
                    Phase::External,
                    "The configured relay port is in use outside Trame.",
                );
                return;
            }
        }
        let identity = config.state_file("tsnet/tailscaled.state");
        match identity {
            Ok(path) if path.is_file() => {}
            Ok(_) => {
                runtime.set(
                    Phase::SetupRequired,
                    "Set up the relay’s tailnet identity first.",
                );
                return;
            }
            Err(detail) => {
                runtime.set(Phase::Error, detail);
                return;
            }
        }
        if config.isolated {
            for file in ["mcp-token", "relay.db", "relay.db-wal", "relay.db-shm"] {
                if let Err(detail) = config.state_file(file) {
                    runtime.set(Phase::Error, detail);
                    return;
                }
            }
        }
        match Managed::spawn(binary, config) {
            Ok(managed) => {
                runtime.managed = Some(managed);
                runtime.set(Phase::Starting, "Connecting the relay to its tailnet.");
            }
            Err(err) => runtime.set(
                Phase::Error,
                format!("Unable to start the agent relay: {err}."),
            ),
        }
    }

    async fn change(
        &self,
        runtime: &mut Runtime,
        action: Action,
    ) -> Result<(), (u16, &'static str)> {
        if runtime.closed || self.demo {
            return Err((409, "Relay management is unavailable."));
        }
        let enabled = match action {
            Action::Enable => {
                self.available_binary().map_err(|detail| (409, detail))?;
                true
            }
            Action::Disable => false,
            Action::Restart if runtime.enabled => {
                runtime.stop_owned().await;
                self.launch(runtime).await;
                return Ok(());
            }
            Action::Restart => return Err((409, "Enable Trame relay management first.")),
        };
        if enabled == runtime.enabled {
            return Ok(());
        }
        let path = self.settings.clone();
        crate::blocking::spawn(move || {
            crate::settings::update(&path, |settings| {
                settings[SETTING] = enabled.into();
                Ok(())
            })
        })
        .await
        .ok()
        .and_then(Result::ok)
        .ok_or((500, "Unable to save the relay setting."))?;
        runtime.enabled = enabled;
        if !enabled {
            runtime.stop_owned().await;
        }
        self.launch(runtime).await;
        Ok(())
    }

    pub(crate) async fn serve(self: &Arc<Self>, req: Request<Body>) -> Response {
        use crate::routes::json_response;
        if req
            .headers()
            .get(crate::pty::TOKEN_HEADER)
            .and_then(|value| value.to_str().ok())
            != Some(crate::pty::token())
        {
            return json_response(401, json!({"error":"App token required."}));
        }
        let action = match *req.method() {
            Method::GET => None,
            Method::POST => {
                let Ok(bytes) = to_bytes(req.into_body(), 256).await else {
                    return json_response(400, json!({"error":"Invalid relay action."}));
                };
                let Ok(action) = serde_json::from_slice::<Action>(&bytes) else {
                    return json_response(400, json!({"error":"Invalid relay action."}));
                };
                Some(action)
            }
            _ => return json_response(405, json!({"error":"Method not allowed."})),
        };
        if let Some(action) = action {
            let relay = Arc::clone(self);
            // An interrupted HTTP request must leave the process and its saved setting consistent.
            return tokio::spawn(async move {
                let mut runtime = relay.runtime.lock().await;
                match relay.change(&mut runtime, action).await {
                    Ok(()) => relay.response(&runtime),
                    Err((status, detail)) => json_response(status, json!({"error":detail})),
                }
            })
            .await
            .unwrap_or_else(|_| {
                json_response(500, json!({"error":"Unable to change relay management."}))
            });
        }
        self.response(&*self.runtime.lock().await)
    }

    fn response(&self, runtime: &Runtime) -> Response {
        let setup_command = self
            .binary
            .as_ref()
            .filter(|_| runtime.phase == Phase::SetupRequired)
            .map(|binary| {
                let mut parts: Vec<_> = ["AGENT_RELAY_HOME", "AGENT_RELAY_CONFIG"]
                    .into_iter()
                    .filter_map(|key| {
                        let path = env_path(key)?;
                        Some(format!(
                            "{key}={}",
                            crate::terminal::shq(&path.to_string_lossy())
                        ))
                    })
                    .collect();
                parts.push(format!(
                    "{} init",
                    crate::terminal::shq(&binary.to_string_lossy())
                ));
                parts.join(" ")
            });
        crate::routes::json_response(
            200,
            json!({
                "enabled": runtime.enabled,
            "available": self.available_binary().is_ok(),
                "phase": runtime.phase,
                "detail": runtime.detail,
                "setupCommand": setup_command,
            }),
        )
    }
}

#[cfg(target_os = "macos")]
fn unsupported_os() -> bool {
    std::process::Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|v| v.trim().split('.').next()?.parse::<u32>().ok())
        .is_some_and(|major| major < 13)
}

#[cfg(not(target_os = "macos"))]
const fn unsupported_os() -> bool {
    false
}

fn listen_addresses(listen: &str) -> Option<Vec<SocketAddr>> {
    if let Some(port) = listen.strip_prefix("localhost:") {
        let port = port.parse::<u16>().ok().filter(|port| *port != 0)?;
        return Some(vec![
            (Ipv4Addr::LOCALHOST, port).into(),
            (Ipv6Addr::LOCALHOST, port).into(),
        ]);
    }
    let addr: SocketAddr = listen.parse().ok()?;
    (addr.ip().is_loopback() && addr.port() != 0).then_some(vec![addr])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt as _;

    #[test]
    fn relay_management_accepts_only_fixed_loopback_ports() {
        for (address, expected) in [
            ("127.0.0.1:8770", true),
            ("[::1]:8770", true),
            ("localhost:8770", true),
            ("127.0.0.1:0", false),
            ("0.0.0.0:8770", false),
            ("example.test:8770", false),
        ] {
            assert_eq!(listen_addresses(address).is_some(), expected, "{address}");
        }
    }

    #[tokio::test]
    async fn relay_management_requires_the_app_token() {
        let relay = Arc::new(Service::new(PathBuf::new(), Path::new(""), true));
        for (method, body) in [(Method::GET, ""), (Method::POST, "\"enable\"")] {
            let request = Request::builder()
                .method(method)
                .body(Body::from(body))
                .unwrap();
            assert_eq!(relay.serve(request).await.status(), 401);
        }
    }

    #[tokio::test]
    async fn relay_management_only_runs_an_enrolled_child_and_leaves_an_external_listener_alone() {
        struct TestDir(PathBuf);
        impl Drop for TestDir {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }

        let root =
            TestDir(std::env::temp_dir().join(format!("trame-relay-{}", uuid::Uuid::new_v4())));
        let state = root.0.join("state");
        fs::create_dir_all(state.join("tsnet")).unwrap();
        let config = ConfiguredRelay {
            config: root.0.join("config.json"),
            home: Some(root.0.clone()),
            state,
            listen: String::new(),
            isolated: false,
        };
        let script = root.0.join("agent-relay");
        fs::write(
            &script,
            concat!(
                "#!/bin/sh\n",
                "set -eu\n",
                "test \"$1\" = serve\n",
                "trap 'touch \"$AGENT_RELAY_HOME/stopped\"; exit 0' TERM\n",
                "printf 'synthetic INFO peer api up addr=fixture\\n' >&2\n",
                "while :; do sleep 0.05; done\n",
            ),
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let external = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let config = ConfiguredRelay {
            listen: external.local_addr().unwrap().to_string(),
            ..config
        };
        let mut runtime = Runtime {
            enabled: true,
            closed: false,
            phase: Phase::Off,
            detail: String::new(),
            managed: None,
        };
        Service::launch_configured(&mut runtime, &script, &config).await;
        assert!(runtime.phase == Phase::External && runtime.managed.is_none());
        runtime.stop_owned().await;
        assert!(
            tokio::net::TcpStream::connect(external.local_addr().unwrap())
                .await
                .is_ok()
        );
        drop(external);

        Service::launch_configured(&mut runtime, &script, &config).await;
        assert!(runtime.phase == Phase::SetupRequired && runtime.managed.is_none());
        fs::write(config.state.join("tsnet/tailscaled.state"), "synthetic").unwrap();
        Service::launch_configured(&mut runtime, &script, &config).await;
        timeout(Duration::from_secs(3), async {
            while runtime.phase == Phase::Starting {
                tokio::time::sleep(Duration::from_millis(20)).await;
                runtime.refresh().await;
            }
        })
        .await
        .unwrap();
        assert!(runtime.phase == Phase::Running);
        runtime.stop_owned().await;
        assert!(root.0.join("stopped").is_file());
    }
}
