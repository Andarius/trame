#![allow(
    clippy::print_stdout,
    clippy::print_stderr,
    reason = "CLI output is the product; stderr is the app log"
)]

pub mod assets;
pub mod blocking;
pub mod cli;
pub mod comments;
pub mod db;
pub mod files;
pub mod forge;
pub mod imports;
pub mod json;
pub mod local;
pub mod notify;
pub mod pages;
pub mod pg;
pub mod platform;
pub mod plugin_host;
pub mod plugins;
pub mod proxy;
pub mod pty;
pub mod routes;
pub mod runtime;
pub mod sessions;
pub mod settings;
pub mod share;
pub mod startup;
pub mod sync;
pub mod terminal;
pub mod udb;
pub mod update;
pub mod web;

use anyhow::{Context, Result, bail};
use std::{
    fs,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::sync::oneshot;

pub fn workspace() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
}

/// Require scratch confinement for debug runtimes and explicitly isolated releases.
pub fn isolated_mode() -> bool {
    cfg!(debug_assertions) || std::env::var("TRAME_ISOLATED").as_deref() == Ok("1")
}

pub fn scratch_path(path: &Path) -> Result<PathBuf> {
    let scratch = workspace().join(".scratch").canonicalize()?;
    if path
        .components()
        .any(|part| part == std::path::Component::ParentDir)
    {
        bail!("parent traversal is forbidden");
    }
    let mut ancestor = path.to_path_buf();
    let mut suffix = Vec::new();
    while !ancestor.exists() {
        suffix.push(
            ancestor
                .file_name()
                .context("missing path ancestor")?
                .to_os_string(),
        );
        if !ancestor.pop() {
            bail!("missing path ancestor");
        }
    }
    let mut root = ancestor.canonicalize()?;
    for name in suffix.iter().rev() {
        root.push(name);
    }
    if !root.starts_with(&scratch) || root == scratch {
        bail!("slice requires an isolated .scratch directory");
    }
    Ok(root)
}

pub fn scratch_root(path: &Path) -> Result<PathBuf> {
    let root = scratch_path(path)?;
    if root.join("PG_VERSION").exists() {
        bail!("expected an app directory, not a database directory");
    }
    fs::create_dir_all(&root)?;
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
    Ok(root)
}

#[allow(unsafe_code, reason = "libc::kill liveness probe")]
#[allow(
    clippy::cast_possible_truncation,
    reason = "values fit by construction (timestamps, ids, pids, JS-number parity)"
)]
fn refuse_live_port(path: &Path) -> Result<()> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let owner: serde_json::Value = serde_json::from_slice(&bytes)
        .context("existing port file is invalid; inspect it before starting")?;
    let pid = owner["pid"]
        .as_i64()
        .filter(|pid| *pid > 0 && *pid <= i64::from(i32::MAX))
        .context("existing port file has no valid PID; inspect it before starting")?
        as libc::pid_t;
    let result = unsafe { libc::kill(pid, 0) };
    let error = std::io::Error::last_os_error();
    if result == 0 || error.raw_os_error() == Some(libc::EPERM) {
        bail!("another Trame process owns the port file (pid {pid}); stop it before starting");
    }
    if error.raw_os_error() != Some(libc::ESRCH) {
        return Err(error.into());
    }
    Ok(())
}

pub struct Config {
    pub root: PathBuf,
    pub pg_bin: PathBuf,
    pub port: u16,
    pub web_dir: PathBuf,
    pub desktop: bool,
}
impl Config {
    pub fn from_env() -> Result<Self> {
        let root = std::env::var_os("TRAME_LOCAL_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                if isolated_mode() {
                    return workspace().join(".scratch/dev-local");
                }
                std::env::var_os("XDG_DATA_HOME")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| {
                        PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
                            .join(".local/share")
                    })
                    .join("trame")
            });
        let pg_bin = std::env::var_os("TRAME_PG_BIN")
            .map(PathBuf::from)
            .unwrap_or_else(|| workspace().join(".scratch/stage0/pg18/usr/lib/postgresql/18/bin"));
        let port: u16 = std::env::var("TRACKER_PORT")
            .unwrap_or_else(|_| "0".into())
            .parse()?;
        if isolated_mode() && [8787, 5181].contains(&port) {
            bail!("reserved live-app port");
        }
        let web_dir = std::env::var_os("TRAME_WEB_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| workspace().join("app/web/dist"));
        let desktop = std::env::var("TRACKER_DESKTOP").as_deref() == Ok("1");
        Ok(Self {
            root,
            pg_bin,
            port,
            web_dir,
            desktop,
        })
    }
}

pub async fn run(
    config: Config,
    ready: oneshot::Sender<u16>,
    stop: oneshot::Receiver<()>,
) -> Result<()> {
    let (config, mut pg, settings, origin) = crate::blocking::spawn(move || -> Result<_> {
        if isolated_mode() {
            scratch_path(&config.root)?;
        }
        let legacy = std::env::var_os("TRACKER_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| config.root.join("pglite"));
        if isolated_mode() {
            scratch_path(&legacy)?;
        }
        let published = std::env::var_os("TRACKER_PORT_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|| config.root.join("port.json"));
        if isolated_mode() {
            scratch_path(&published)?;
        }
        refuse_live_port(&published)?;
        // macOS leaves pglite/ untouched: a new cluster starts empty and the hub sync refills it
        if cfg!(target_os = "linux")
            && legacy.join("PG_VERSION").is_file()
            && !config.root.join("postgres").exists()
        {
            fs::create_dir_all(&config.root)?;
            pg::migrate(&legacy, &config.root, &config.pg_bin)?;
        }
        pg::check_staging(&config.root)?;
        let pg = pg::Pg::start(&config.root, &config.pg_bin)?;
        let settings = std::env::var_os("TRACKER_SETTINGS_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|| config.root.join("settings.json"));
        if isolated_mode() {
            scratch_path(&settings)?;
        }
        let origin = startup::node_id()?;
        startup::initialize(&config.root, &origin, &settings)?;
        Ok((config, pg, settings, origin))
    })
    .await??;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", config.port)).await?;
    let port = listener.local_addr()?.port();
    let published = std::env::var_os("TRACKER_PORT_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| config.root.join("port.json"));
    if isolated_mode() {
        scratch_path(&published)?;
    }
    refuse_live_port(&published)?;
    fs::create_dir_all(published.parent().context("port file parent")?)?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&published)?;
    write!(
        file,
        "{}",
        serde_json::json!({"port":port,"pid":std::process::id()})
    )?;
    let offline =
        std::env::var("TRAME_OFFLINE").as_deref() == Ok("1") || scratch_path(&config.root).is_ok();
    let sync = sync::Sync::new(
        config.root.clone(),
        settings.clone(),
        origin.clone(),
        offline,
    );
    let background = tokio::spawn(sync.clone().background());
    let realtime = tokio::spawn(sync.clone().realtime());
    let native = routes::Native {
        root: config.root.clone(),
        origin,
        settings,
        sync,
        port,
        desktop: config.desktop,
        web_dir: config.web_dir.clone(),
    };
    let notifier = tokio::spawn(notify::background(native.clone()));
    let updater = (config.desktop && !offline).then(|| tokio::spawn(update::background()));
    // isolated (dev/test) runs must never touch the user's agent settings
    if config.desktop && !isolated_mode() {
        drop(tokio::task::spawn_blocking(startup::install_agent_hooks));
    }
    let plugin_task = plugins::start(native.clone());
    let sql_source_task = Some(plugins::sql_source::start(&native));
    let host_task = plugin_host::start(native.clone());
    let router = proxy::router(proxy::Proxy { port, native });
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let mut server = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
    });
    let _ = ready.send(port);
    tokio::pin!(stop);
    let mut server_done = false;
    let result = loop {
        tokio::select! {
            _ = &mut stop => break Ok(()),
            outcome = &mut server => { server_done = true; break outcome.context("HTTP server task failed").and_then(|r| r.context("HTTP server failed")); },
            () = tokio::time::sleep(Duration::from_millis(200)) => {
                if !pg.is_running().unwrap_or(false) {
                    break Err(anyhow::anyhow!("PostgreSQL exited or could not be monitored"));
                }
            }
        }
    };
    let _ = shutdown_tx.send(());
    // open terminals hold WebSocket connections the graceful shutdown would wait on
    let _ = blocking::spawn(pty::shutdown).await;
    for task in [plugin_task, sql_source_task, host_task, updater]
        .into_iter()
        .flatten()
    {
        task.abort();
        let _ = task.await;
    }
    background.abort();
    realtime.abort();
    notifier.abort();
    let _ = background.await;
    let _ = realtime.await;
    let _ = notifier.await;
    if !server_done {
        let _ = server.await;
    }
    blocking::drain().await;
    crate::blocking::spawn(move || drop(pg)).await?;
    if fs::read(&published)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .is_some_and(|value| {
            value["pid"].as_u64() == Some(u64::from(std::process::id()))
                && value["port"].as_u64() == Some(u64::from(port))
        })
    {
        let _ = fs::remove_file(published);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn isolation_refuses_escape_before_creating_files() {
        assert!(scratch_path(Path::new("/tmp/trame")).is_err());
        assert!(scratch_path(&workspace().join(".scratch")).is_err());
        assert!(scratch_path(&workspace().join(".scratch/../outside")).is_err());
        let path = workspace().join(format!(".scratch/path-test-{}", uuid::Uuid::new_v4()));
        assert_eq!(scratch_path(&path).unwrap(), path);
        assert!(!path.exists());
        let link = workspace().join(format!(".scratch/path-link-{}", uuid::Uuid::new_v4()));
        std::os::unix::fs::symlink("/tmp", &link).unwrap();
        assert!(scratch_path(&link.join("settings.json")).is_err());
        fs::remove_file(link).unwrap();
    }

    #[test]
    fn port_file_refuses_a_live_owner_and_invalid_ownership() {
        let root = scratch_root(
            &workspace().join(format!(".scratch/port-guard-{}", uuid::Uuid::new_v4())),
        )
        .unwrap();
        let port = root.join("port.json");
        fs::write(
            &port,
            serde_json::json!({"pid":std::process::id(),"port":12345}).to_string(),
        )
        .unwrap();
        assert!(
            refuse_live_port(&port)
                .unwrap_err()
                .to_string()
                .contains("another Trame process")
        );
        fs::write(&port, "{}").unwrap();
        assert!(refuse_live_port(&port).is_err());
        fs::write(
            &port,
            serde_json::json!({"pid":i32::MAX,"port":12345}).to_string(),
        )
        .unwrap();
        assert!(refuse_live_port(&port).is_ok());
        fs::remove_dir_all(root).unwrap();
    }
}
