use anyhow::{Result, bail};
use reqwest::{Client, Method};
use serde_json::{Value, json};
use std::{
    env, fs,
    path::PathBuf,
    sync::{
        LazyLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

static LAST_HUB: AtomicBool = AtomicBool::new(false);
static NOTED_HUB: AtomicBool = AtomicBool::new(false);
static PROTOCOL_VERSION: LazyLock<String> = LazyLock::new(|| {
    serde_json::from_str::<Value>(include_str!("../../../protocol/rust-entities.json"))
        .expect("generated protocol registry")["version"]
        .to_string()
});
const NOT_RUNNING: &str = "Trame app is not running and no hub is configured (hubApi + hubApiToken in settings.json, or TRACKER_HUB_API + TRACKER_HUB_API_TOKEN). Start it with `just dev` or `just serve`.";

#[derive(Clone)]
pub struct Target {
    pub base: String,
    pub hub: bool,
    token: Option<String>,
    client: Client,
}

#[derive(Debug)]
pub enum RequestFailure {
    Transport(String),
    Http {
        path: String,
        status: u16,
        body: String,
    },
    InvalidJson(String),
}

impl std::fmt::Display for RequestFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(message) | Self::InvalidJson(message) => f.write_str(message),
            Self::Http { path, status, body } => write!(f, "{path} → HTTP {status}: {body}"),
        }
    }
}

impl std::error::Error for RequestFailure {}

pub fn data_file(override_name: &str, name: &str) -> PathBuf {
    if let Some(path) = env::var_os(override_name) {
        return PathBuf::from(path);
    }
    if let Some(root) = env::var_os("TRAME_LOCAL_DIR") {
        return PathBuf::from(root).join(name);
    }
    let base = env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env::var_os("HOME").unwrap_or_default()).join(".local/share")
        });
    base.join("trame").join(name)
}

/// The running local app named by the port file, if it answers /api/status.
pub async fn local_target() -> Result<Option<Target>> {
    let Some(port) = fs::read_to_string(data_file("TRACKER_PORT_FILE", "port.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v["port"].as_u64())
        .filter(|p| *p > 0 && u16::try_from(*p).is_ok())
    else {
        return Ok(None);
    };
    let base = format!("http://127.0.0.1:{port}");
    let client = Client::builder()
        .timeout(Duration::from_millis(800))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    if !client
        .get(format!("{base}/api/status"))
        .send()
        .await
        .is_ok_and(|r| r.status().is_success())
    {
        return Ok(None);
    }
    Ok(Some(Target {
        base,
        hub: false,
        token: None,
        client: Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()?,
    }))
}

pub async fn resolve_target() -> Result<Target> {
    if let Some(target) = local_target().await? {
        if LAST_HUB.swap(false, Ordering::SeqCst) {
            let _ = target
                .client
                .post(format!("{}/api/sync", target.base))
                .timeout(Duration::from_secs(30))
                .send()
                .await;
        }
        return Ok(target);
    }
    if env::var("TRAME_OFFLINE").ok().as_deref() == Some("1") {
        bail!("Trame app is not running (TRAME_OFFLINE=1)");
    }
    let settings = fs::read_to_string(data_file("TRACKER_SETTINGS_FILE", "settings.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or(Value::Null);
    let url = settings["hubApi"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_owned())
        .or_else(|| env::var("TRACKER_HUB_API").ok())
        .unwrap_or_default();
    let token = settings["hubApiToken"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_owned())
        .or_else(|| env::var("TRACKER_HUB_API_TOKEN").ok())
        .unwrap_or_default();
    if url.is_empty() || token.is_empty() {
        bail!(NOT_RUNNING);
    }
    let mut builder = Client::builder().redirect(reqwest::redirect::Policy::none());
    let ca = data_file("TRACKER_TLS_DIR", "certs").join("ca.crt");
    if let Ok(bytes) = fs::read(ca) {
        if let Ok(cert) = reqwest::Certificate::from_pem(&bytes) {
            builder = builder.add_root_certificate(cert);
        }
    }
    let target = Target {
        base: url.trim_end_matches('/').into(),
        hub: true,
        token: Some(token),
        client: builder.build()?,
    };
    LAST_HUB.store(true, Ordering::SeqCst);
    if !NOTED_HUB.swap(true, Ordering::SeqCst) {
        eprintln!(
            "note: Trame app not running — using the hub at {}",
            target.base
        );
    }
    Ok(target)
}

impl Target {
    pub fn local(base: String) -> Self {
        Self {
            base,
            hub: false,
            token: None,
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("reqwest client"),
        }
    }

    pub async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        timeout: Option<Duration>,
    ) -> Result<Value> {
        let mut request = self
            .client
            .request(method, format!("{}{}", self.base, path));
        if let Some(token) = &self.token {
            request = request
                .bearer_auth(token)
                .header("x-trame-protocol", PROTOCOL_VERSION.as_str());
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        if let Some(timeout) = timeout {
            request = request.timeout(timeout);
        }
        let response = request.send().await.map_err(|_| {
            RequestFailure::Transport(if self.hub { format!("the hub at {} is not reachable", self.base) }
                else { "Trame app is not reachable (stale port file?). Start it with `just dev` or `just serve`.".into() })
        })?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(RequestFailure::Http {
                path: path.into(),
                status: status.as_u16(),
                body: text,
            }
            .into());
        }
        response.json().await.map_err(|_| {
            RequestFailure::InvalidJson(format!("{path} returned invalid JSON")).into()
        })
    }
    pub async fn get(&self, path: &str) -> Result<Value> {
        self.request(Method::GET, path, None, Some(Duration::from_secs(5)))
            .await
    }
    pub async fn post(&self, path: &str, body: &Value) -> Result<Value> {
        self.request(Method::POST, path, Some(body), Some(Duration::from_secs(5)))
            .await
    }
    pub fn app_link(&self, query: &str) -> String {
        if self.hub {
            String::new()
        } else {
            format!(" — {}/?{query}", self.base)
        }
    }
    pub fn app_url(&self, query: &str) -> Value {
        if self.hub {
            Value::Null
        } else {
            json!(format!("{}/?{query}", self.base))
        }
    }
}
