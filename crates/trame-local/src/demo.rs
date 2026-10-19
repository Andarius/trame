use crate::routes::{Native, json_response};
use anyhow::{Context, Result, bail, ensure};
use axum::{body::Body, http::Request, response::Response};
use chrono::{Days, NaiveDate};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, LazyLock, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::mpsc::UnboundedSender;

/// Bundle shape the app replays; bump with `DEMO_FORMAT` in scripts/demo-seed.ts.
pub const FORMAT: u32 = 1;
const MAX_BUNDLE: u64 = 50 * 1024 * 1024;
const BUNDLE: &str = "bundle.json";
const SEEDED: &str = "seeded";

static UUID: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").unwrap()
});
static DAY: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"\b(\d{4})-(\d{2})-(\d{2})\b").unwrap());

/// Whether the running backend is the demo workspace; one backend runs per process.
pub static ACTIVE: AtomicBool = AtomicBool::new(false);

pub fn active() -> bool {
    ACTIVE.load(Ordering::SeqCst)
}

/// A path override from the environment, ignored in the demo so it never touches real files.
pub fn env_path(name: &str) -> Option<PathBuf> {
    if active() {
        return None;
    }
    std::env::var_os(name).map(PathBuf::from)
}

/// Which data root the desktop supervisor should run next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Switch {
    Main,
    Demo { reset: bool },
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum Phase {
    #[default]
    Idle,
    Downloading,
    Downloaded,
    Seeding,
    Ready,
    Failed,
}

#[derive(Default)]
struct Progress {
    phase: Phase,
    received: u64,
    total: Option<u64>,
    done: usize,
    ops: usize,
    error: Option<String>,
}

/// Per-backend demo state: whether this run is the demo workspace, its progress, and the
/// channel to the desktop supervisor (absent outside the desktop app).
#[derive(Clone, Default)]
pub struct Demo {
    pub active: bool,
    /// Changes on every backend start, so the page can tell a restart happened.
    pub boot: String,
    pub switch: Option<UnboundedSender<Switch>>,
    progress: Arc<Mutex<Progress>>,
}
impl Demo {
    pub fn new(active: bool, switch: Option<UnboundedSender<Switch>>) -> Self {
        Self {
            active,
            boot: uuid::Uuid::new_v4().to_string(),
            switch,
            progress: Arc::default(),
        }
    }
    fn set(&self, f: impl FnOnce(&mut Progress)) {
        f(&mut self.progress.lock().unwrap());
    }
}

#[derive(Deserialize)]
struct Bundle {
    format: u32,
    recorded_on: String,
    ops: Vec<Op>,
}
#[derive(Deserialize)]
struct Op {
    method: String,
    path: String,
    body: Option<Value>,
    #[serde(default)]
    ids: Map<String, Value>,
}

/// The demo workspace's data root, inside the real one.
pub fn root(main: &Path) -> PathBuf {
    main.join("demo")
}

/// Whether the demo root finished seeding (a half-seeded one is wiped before reuse).
pub fn seeded(main: &Path) -> bool {
    root(main).join(SEEDED).exists()
}

fn bundle_url() -> String {
    std::env::var("TRAME_DEMO_URL").unwrap_or_else(|_| {
        format!("https://github.com/Andarius/trame/releases/download/demo-f{FORMAT}/demo.json")
    })
}

/// Empties the demo root but keeps the downloaded bundle, so a reset reseeds offline.
pub fn wipe(main: &Path) -> Result<()> {
    let demo = root(main);
    ensure!(
        demo.parent() == Some(main)
            && demo.file_name() == Some("demo".as_ref())
            && !std::fs::symlink_metadata(&demo).is_ok_and(|m| m.file_type().is_symlink()),
        "refusing to wipe {}",
        demo.display()
    );
    let Ok(entries) = std::fs::read_dir(&demo) else {
        return Ok(());
    };
    for entry in entries {
        let entry = entry?;
        if entry.file_name() == BUNDLE {
            continue;
        }
        if entry.file_type()?.is_dir() {
            std::fs::remove_dir_all(entry.path())?;
        } else {
            std::fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

fn parse(bytes: &[u8]) -> Result<Bundle> {
    let bundle: Bundle = serde_json::from_slice(bytes).context("demo bundle is not valid JSON")?;
    if bundle.format != FORMAT {
        bail!(
            "demo bundle format {} is not supported (this app reads {FORMAT})",
            bundle.format
        );
    }
    NaiveDate::parse_from_str(&bundle.recorded_on, "%Y-%m-%d")
        .context("demo bundle has no valid recorded_on")?;
    Ok(bundle)
}

/// Rewrites recorded UUIDs to the ones this replay created.
fn remap(text: &str, ids: &HashMap<String, String>) -> String {
    UUID.replace_all(text, |c: &regex::Captures| {
        ids.get(&c[0]).cloned().unwrap_or_else(|| c[0].to_owned())
    })
    .into_owned()
}

/// Moves every calendar day by `days`, so due dates stay relative to today.
fn shift_days(text: &str, days: i64) -> String {
    if days == 0 {
        return text.to_owned();
    }
    DAY.replace_all(text, |c: &regex::Captures| {
        NaiveDate::parse_from_str(&c[0], "%Y-%m-%d")
            .ok()
            .and_then(|d| {
                if days >= 0 {
                    d.checked_add_days(Days::new(days.unsigned_abs()))
                } else {
                    d.checked_sub_days(Days::new(days.unsigned_abs()))
                }
            })
            .map_or_else(|| c[0].to_owned(), |d| d.format("%Y-%m-%d").to_string())
    })
    .into_owned()
}

/// Pairs each recorded UUID with the one at the same JSON pointer in the live response.
fn learn(ids: &mut HashMap<String, String>, recorded: &Map<String, Value>, actual: &Value) {
    for (pointer, old) in recorded {
        if let (Some(old), Some(new)) = (
            old.as_str(),
            actual.pointer(pointer).and_then(Value::as_str),
        ) {
            ids.insert(old.to_owned(), new.to_owned());
        }
    }
}

async fn replay(demo: &Demo, port: u16, bundle: Bundle) -> Result<()> {
    let client = reqwest::Client::builder().no_proxy().build()?;
    let recorded_on = NaiveDate::parse_from_str(&bundle.recorded_on, "%Y-%m-%d")?;
    let days = (chrono::Local::now().date_naive() - recorded_on).num_days();
    let mut ids = HashMap::new();
    demo.set(|p| {
        p.ops = bundle.ops.len();
        p.done = 0;
    });
    for (i, op) in bundle.ops.into_iter().enumerate() {
        let url = format!("http://127.0.0.1:{port}{}", remap(&op.path, &ids));
        let request = match op.method.as_str() {
            "GET" => client.get(url),
            "POST" => {
                let body = op
                    .body
                    .as_ref()
                    .map(crate::json::stringify)
                    .unwrap_or_default();
                client
                    .post(url)
                    .header("content-type", "application/json")
                    .body(shift_days(&remap(&body, &ids), days))
            }
            other => bail!("demo op {i}: unsupported method {other}"),
        };
        let response = request.send().await?;
        let status = response.status();
        ensure!(
            status.is_success(),
            "demo op {i} {} {} → {status}",
            op.method,
            op.path
        );
        learn(&mut ids, &op.ids, &response.json().await?);
        demo.set(|p| p.done = i + 1);
    }
    Ok(())
}

/// Seeds a fresh demo root from its bundle once; later starts find the marker and skip.
pub async fn seed(native: Native) {
    let marker = native.root.join(SEEDED);
    if marker.exists() {
        native.demo.set(|p| p.phase = Phase::Ready);
        return;
    }
    native.demo.set(|p| p.phase = Phase::Seeding);
    let result = async {
        let bytes = tokio::fs::read(native.root.join(BUNDLE))
            .await
            .context("no demo bundle downloaded")?;
        replay(&native.demo, native.port, parse(&bytes)?).await?;
        tokio::fs::write(&marker, b"").await?;
        anyhow::Ok(())
    }
    .await;
    native.demo.set(|p| match result {
        Ok(()) => p.phase = Phase::Ready,
        Err(error) => {
            eprintln!("demo seed: {error:#}");
            p.phase = Phase::Failed;
            p.error = Some(format!("{error:#}"));
        }
    });
}

async fn download(demo: Demo, dir: PathBuf) {
    let result = async {
        let url = bundle_url();
        let bytes = if url.starts_with("http://") || url.starts_with("https://") {
            let mut response = reqwest::Client::new()
                .get(&url)
                .header("user-agent", "Trame")
                .send()
                .await?
                .error_for_status()?;
            demo.set(|p| p.total = response.content_length());
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await? {
                bytes.extend_from_slice(&chunk);
                ensure!(bytes.len() as u64 <= MAX_BUNDLE, "demo bundle is too large");
                let received = bytes.len() as u64;
                demo.set(|p| p.received = received);
            }
            bytes
        } else {
            tokio::fs::read(&url)
                .await
                .with_context(|| format!("read {url}"))?
        };
        parse(&bytes)?;
        tokio::fs::create_dir_all(&dir).await?;
        let tmp = dir.join(format!("{BUNDLE}.tmp"));
        tokio::fs::write(&tmp, &bytes).await?;
        tokio::fs::rename(&tmp, dir.join(BUNDLE)).await?;
        anyhow::Ok(())
    }
    .await;
    demo.set(|p| match result {
        Ok(()) => p.phase = Phase::Downloaded,
        Err(error) => {
            eprintln!("demo download: {error:#}");
            p.phase = Phase::Failed;
            p.error = Some(format!("Could not download the demo: {error:#}"));
        }
    });
}

pub fn owns(path: &str) -> bool {
    path == "/api/demo" || path.starts_with("/api/demo/")
}

fn ask(native: &Native, switch: Switch) -> Response {
    match &native.demo.switch {
        Some(tx) if tx.send(switch).is_ok() => json_response(202, json!({"ok":true})),
        _ => json_response(
            409,
            json!({"error":"the demo workspace needs the desktop app"}),
        ),
    }
}

pub fn serve(native: &Native, req: &Request<Body>) -> Response {
    let post = req.method() == axum::http::Method::POST;
    let demo = &native.demo;
    let dir = if demo.active {
        native.root.clone()
    } else {
        root(&native.root)
    };
    match (post, req.uri().path()) {
        (false, "/api/demo") => {
            let seeded = dir.join(SEEDED).exists();
            let p = demo.progress.lock().unwrap();
            json_response(
                200,
                json!({
                    "available": demo.switch.is_some(),
                    "active": demo.active,
                    "seeded": seeded,
                    "phase": format!("{:?}", p.phase).to_lowercase(),
                    "received": p.received,
                    "total": p.total,
                    "done": p.done,
                    "ops": p.ops,
                    "error": p.error,
                }),
            )
        }
        (true, "/api/demo/download") if !demo.active => {
            let start = {
                let mut p = demo.progress.lock().unwrap();
                let start = p.phase != Phase::Downloading;
                if start {
                    *p = Progress {
                        phase: Phase::Downloading,
                        ..Progress::default()
                    };
                }
                start
            };
            if start {
                tokio::spawn(download(demo.clone(), dir));
            }
            json_response(202, json!({"ok":true}))
        }
        (true, "/api/demo/enter") if !demo.active => {
            if !dir.join(BUNDLE).exists() && !dir.join(SEEDED).exists() {
                return json_response(409, json!({"error":"download the demo first"}));
            }
            ask(native, Switch::Demo { reset: false })
        }
        (true, "/api/demo/reset") if demo.active => ask(native, Switch::Demo { reset: true }),
        (true, "/api/demo/exit") if demo.active => ask(native, Switch::Main),
        _ => json_response(404, json!({"error":"not found"})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remap_rewrites_known_uuids_only() {
        let old = "019f674d-08b7-7000-ab88-f35d3434e995";
        let other = "01a01df5-df64-7000-bc1e-7b013321ab48";
        let ids = HashMap::from([(old.to_owned(), "new-id".to_owned())]);
        assert_eq!(
            remap(&format!("/api/udb/{old}/props?x={other}"), &ids),
            format!("/api/udb/new-id/props?x={other}")
        );
    }

    #[test]
    fn shift_days_moves_dates_and_leaves_uuids_alone() {
        let text = r#"{"t":"Ship {{trame:due=2026-10-16}}","d":{"start":"2026-02-28"},"id":"01a01df5-df64-7000-bc1e-7b013321ab48"}"#;
        assert_eq!(
            shift_days(text, 3),
            r#"{"t":"Ship {{trame:due=2026-10-19}}","d":{"start":"2026-03-03"},"id":"01a01df5-df64-7000-bc1e-7b013321ab48"}"#
        );
        assert_eq!(shift_days("2026-10-16", -16), "2026-09-30");
    }

    #[test]
    fn learn_pairs_by_pointer() {
        let recorded = json!({"/id": "a0000000-0000-4000-8000-000000000001", "/properties/1/id": "a0000000-0000-4000-8000-000000000002"});
        let actual = json!({"id": "x", "properties": [{"id": "title"}, {"id": "y"}]});
        let mut ids = HashMap::new();
        learn(&mut ids, recorded.as_object().unwrap(), &actual);
        assert_eq!(ids["a0000000-0000-4000-8000-000000000001"], "x");
        assert_eq!(ids["a0000000-0000-4000-8000-000000000002"], "y");
    }

    #[test]
    fn parse_refuses_other_formats() {
        let other = json!({"format": FORMAT + 1, "recorded_on": "2026-10-16", "ops": []});
        assert!(
            parse(other.to_string().as_bytes())
                .is_err_and(|e| e.to_string().contains("not supported"))
        );
        assert!(parse(br#"{"format":1,"recorded_on":"2026-10-16","ops":[]}"#).is_ok());
    }

    #[test]
    fn wipe_keeps_the_bundle_and_never_leaves_the_demo_root() {
        let main = crate::scratch_root(&crate::workspace().join(format!(
            ".scratch/demo-wipe-{}",
            uuid::Uuid::new_v4().simple()
        )))
        .unwrap();
        let demo = root(&main);
        std::fs::create_dir_all(demo.join("postgres")).unwrap();
        std::fs::write(demo.join(BUNDLE), "{}").unwrap();
        std::fs::write(demo.join(SEEDED), "").unwrap();
        std::fs::write(main.join("settings.json"), "{}").unwrap();
        wipe(&main).unwrap();
        assert!(demo.join(BUNDLE).exists());
        assert!(!demo.join(SEEDED).exists() && !demo.join("postgres").exists());
        assert!(main.join("settings.json").exists());
        std::fs::remove_dir_all(&demo).unwrap();
        let target = main.join("elsewhere");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("keep"), "").unwrap();
        std::os::unix::fs::symlink(&target, &demo).unwrap();
        assert!(wipe(&main).is_err());
        assert!(target.join("keep").exists());
        std::fs::remove_dir_all(main).unwrap();
    }
}
