use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

// a composed build publishes its own releases (see .github/workflows/compose.yml); "none" turns self-update off
fn repo() -> Option<&'static str> {
    match option_env!("TRAME_UPDATE_REPO") {
        None | Some("") => Some("Andarius/trame"),
        Some("none") => None,
        Some(repo) => Some(repo),
    }
}
// a local plugin build (`tramecli plugins build`) updates by rebuilding itself, plugins included
fn rebuilds() -> bool {
    option_env!("TRAME_UPDATE_VIA") == Some("rebuild")
}
fn endpoint(repo: &str) -> String {
    format!("https://api.github.com/repos/{repo}/releases/latest")
}
/// The version releases are compared with: a composed build's own (`0.23.0-2`), else Trame's.
fn installed() -> &'static str {
    option_env!("TRAME_DISTRO_VERSION")
        .filter(|v| !v.is_empty())
        .unwrap_or_else(crate::runtime::version)
}
const AUTO_EVERY: Duration = Duration::from_hours(6);

/// What a self-update replaces: the running `AppImage` file or the macOS `.app` bundle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    AppImage(PathBuf),
    App(PathBuf),
}

#[derive(Default)]
pub struct Updater {
    cache: Option<(Instant, Value)>,
    asset: Option<String>,
    // version now in place; the next launch runs it
    applied: Option<String>,
}
static UPDATER: Mutex<Updater> = Mutex::const_new(Updater {
    cache: None,
    asset: None,
    applied: None,
});

/// The `.app` enclosing a macOS executable path (`X.app/Contents/MacOS/<exe>`), or `None`.
pub fn app_bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    (macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app")
        .then(|| bundle.to_path_buf())
}

/// Release asset name pattern for an OS/arch (see release.yml's upload names).
pub fn asset_pattern(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("linux", "x86_64") => Some(r"(?i)^Trame-v?[^/]+-native-x64\.AppImage$"),
        ("macos", "aarch64") => Some(r"(?i)^Trame-v?[^/]+-native-arm64\.dmg$"),
        _ => None,
    }
}

fn target() -> Option<Target> {
    if cfg!(target_os = "linux") {
        return std::env::var_os("APPIMAGE").map(|p| Target::AppImage(p.into()));
    }
    if cfg!(target_os = "macos") {
        return std::env::current_exe()
            .ok()
            .and_then(|exe| app_bundle_of(&exe))
            .map(Target::App);
    }
    None
}

// Hidden siblings, so the swap is a same-volume rename; `.old` is swept on next launch.
fn sibling(bundle: &Path, suffix: &str) -> PathBuf {
    let name = bundle.file_name().unwrap_or_default().to_string_lossy();
    bundle.with_file_name(format!(".{name}.{suffix}"))
}

// up to four integer parts (`0.23.0`, a composed build's `0.23.0-2`); anything else is None
fn parts(version: &str) -> Option<[u64; 4]> {
    let mut out = [0; 4];
    let mut it = version.split(['.', '-']);
    for (slot, part) in out.iter_mut().zip(&mut it) {
        *slot = part.parse().ok()?;
    }
    it.next().is_none().then_some(out)
}

/// Whether `a` is a later version than `b`; an unparseable version is never newer.
pub fn newer(a: &str, b: &str) -> bool {
    parts(a).zip(parts(b)).is_some_and(|(a, b)| a > b)
}
impl Updater {
    async fn check(
        &mut self,
        force: bool,
        repo: &str,
        endpoint: &str,
        target: Option<&Target>,
    ) -> Value {
        if !force {
            if let Some((at, info)) = &self.cache {
                if at.elapsed() < Duration::from_hours(1) {
                    return info.clone();
                }
            }
        }
        let mut info = json!({"current":installed(),"latest":null,"available":false,"releaseUrl":format!("https://github.com/{repo}/releases/latest"),"canSelfUpdate":target.is_some(),"applied":self.applied.is_some()});
        if let Some(applied) = &self.applied {
            info["latest"] = json!(applied);
        }
        let mut reached = false;
        let mut error = "GitHub unreachable".to_owned();
        let client = reqwest::Client::new();
        match client
            .get(endpoint)
            .header("accept", "application/vnd.github+json")
            .header("user-agent", "Trame")
            .timeout(Duration::from_secs(8))
            .send()
            .await
        {
            Err(e) if e.is_timeout() => error = "GitHub timed out".into(),
            Err(_) => {}
            Ok(response) if !response.status().is_success() => {
                let status = response.status().as_u16();
                error = if matches!(status, 403 | 429) {
                    format!("GitHub rate limit ({status})")
                } else {
                    format!("GitHub answered {status}")
                };
            }
            Ok(response) => {
                error = "no release published".into();
                if let Ok(rel) = response.json::<Value>().await {
                    let tag = rel["tag_name"]
                        .as_str()
                        .unwrap_or("")
                        .strip_prefix('v')
                        .unwrap_or_else(|| rel["tag_name"].as_str().unwrap_or(""));
                    if !tag.is_empty() {
                        info["latest"] = json!(tag);
                        reached = true;
                    }
                    let installed = self.applied.as_deref().unwrap_or(installed());
                    info["available"] = json!(!tag.is_empty() && newer(tag, installed));
                    if !rel["html_url"].is_null() {
                        info["releaseUrl"] = rel["html_url"].clone();
                    }
                    let pattern = asset_pattern(std::env::consts::OS, std::env::consts::ARCH)
                        .map(|p| regex::Regex::new(p).unwrap());
                    self.asset = pattern
                        .zip(rel["assets"].as_array())
                        .and_then(|(re, a)| {
                            a.iter()
                                .find(|a| re.is_match(a["name"].as_str().unwrap_or("")))
                        })
                        .and_then(|a| a["browser_download_url"].as_str())
                        .map(str::to_owned);
                }
            }
        }
        // a failed check is retried next time, not served as "up to date" for an hour
        if reached {
            self.cache = Some((Instant::now(), info.clone()));
        } else {
            info["error"] = json!(error);
        }
        info["checked"] = json!(reached);
        info
    }
    async fn apply(&mut self, repo: &str, endpoint: &str, target: Option<&Target>) -> Value {
        let Some(target) = target else {
            return json!({"ok":false,"error":"self-update only works for the AppImage or the macOS app"});
        };
        let info = self.check(true, repo, endpoint, Some(target)).await;
        if info["available"] != true {
            // a background update already staged it: the caller only needs to restart
            return if self.applied.is_some() {
                json!({"ok":true})
            } else {
                json!({"ok":false,"error":"already up to date"})
            };
        }
        let Some(asset) = self.asset.clone() else {
            return json!({"ok":false,"error":"no build for this platform on the latest release"});
        };
        let result = match target {
            Target::AppImage(path) => replace_appimage(&asset, path).await,
            Target::App(bundle) => replace_app(&asset, bundle).await,
        };
        match result {
            Ok(()) => {
                self.applied = info["latest"].as_str().map(str::to_owned);
                self.cache = None;
                json!({"ok":true})
            }
            Err(error) => json!({"ok":false,"error":error}),
        }
    }
}

fn io_error(path: &Path) -> impl Fn(std::io::Error) -> String + '_ {
    move |e| {
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            format!("no write access to {}", path.display())
        } else {
            e.to_string()
        }
    }
}

/// Streams `url` into a new file at `dest`; never touches a file that already exists there.
async fn download(url: &str, dest: &Path) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    use tokio::io::AsyncWriteExt;
    let response = reqwest::Client::new()
        .get(url)
        .timeout(Duration::from_mins(10))
        .send()
        .await
        .map_err(|_| "download failed".to_owned())?;
    if !response.status().is_success() {
        return Err(format!("download failed ({})", response.status().as_u16()));
    }
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o755)
        .custom_flags(libc::O_NOFOLLOW)
        .open(dest)
        .map_err(io_error(dest))?;
    let result = async {
        let mut file = tokio::fs::File::from_std(file);
        let mut response = response;
        while let Some(bytes) = response
            .chunk()
            .await
            .map_err(|_| "download interrupted".to_owned())?
        {
            file.write_all(&bytes).await.map_err(|e| e.to_string())?;
        }
        file.sync_all().await.map_err(|e| e.to_string())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(dest).await;
    }
    result
}

async fn replace_appimage(asset: &str, target: &Path) -> Result<(), String> {
    let tmp = PathBuf::from(format!("{}.new", target.display()));
    download(asset, &tmp).await?;
    // atomic: the running image keeps its inode
    if let Err(e) = tokio::fs::rename(&tmp, target).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(io_error(target)(e));
    }
    Ok(())
}

async fn run(cmd: &str, args: &[&std::ffi::OsStr]) -> Result<(), String> {
    let out = tokio::process::Command::new(cmd)
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .map_err(|e| format!("{cmd}: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "{cmd} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// Mounts the release dmg, copies its `.app` next to `bundle`, then swaps the two by rename.
async fn replace_app(asset: &str, bundle: &Path) -> Result<(), String> {
    let tmp = std::env::temp_dir().join(format!("trame-update-{}", uuid::Uuid::new_v4().simple()));
    tokio::fs::create_dir(&tmp)
        .await
        .map_err(|e| e.to_string())?;
    let (staged, retired) = (sibling(bundle, "new"), sibling(bundle, "old"));
    let result = async {
        let (dmg, mnt) = (tmp.join("Trame.dmg"), tmp.join("mnt"));
        download(asset, &dmg).await?;
        run(
            "hdiutil",
            &[
                "attach",
                "-nobrowse",
                "-readonly",
                "-noautoopen",
                "-mountpoint",
            ]
            .map(std::ffi::OsStr::new)
            .into_iter()
            .chain([mnt.as_os_str(), dmg.as_os_str()])
            .collect::<Vec<_>>(),
        )
        .await?;
        let copied = async {
            let mut entries = tokio::fs::read_dir(&mnt).await.map_err(|e| e.to_string())?;
            let mut app = None;
            while let Some(e) = entries.next_entry().await.map_err(|e| e.to_string())? {
                if e.path().extension().is_some_and(|x| x == "app") {
                    app = Some(e.path());
                }
            }
            let app = app.ok_or("no .app in the downloaded dmg")?;
            let _ = tokio::fs::remove_dir_all(&staged).await;
            // ditto keeps the bundle's signature and extended attributes intact
            run("ditto", &[app.as_os_str(), staged.as_os_str()]).await
        }
        .await;
        let _ = run(
            "hdiutil",
            &["detach", "-force"]
                .map(std::ffi::OsStr::new)
                .into_iter()
                .chain([mnt.as_os_str()])
                .collect::<Vec<_>>(),
        )
        .await;
        copied?;
        let _ = tokio::fs::remove_dir_all(&retired).await;
        tokio::fs::rename(bundle, &retired)
            .await
            .map_err(io_error(bundle))?;
        if let Err(e) = tokio::fs::rename(&staged, bundle).await {
            // put the running app back
            let _ = tokio::fs::rename(&retired, bundle).await;
            return Err(io_error(bundle)(e));
        }
        Ok(())
    }
    .await;
    let _ = tokio::fs::remove_dir_all(&staged).await;
    let _ = tokio::fs::remove_dir_all(&tmp).await;
    result
}

/// Desktop background loop: download and stage new releases so the next launch runs them.
pub async fn background() {
    if std::env::var("TRACKER_UPDATE_CHECK").as_deref() == Ok("0")
        || std::env::var("TRACKER_AUTO_UPDATE").as_deref() == Ok("0")
    {
        return;
    }
    let (Some(target), Some(repo)) = (target(), repo()) else {
        return;
    };
    // a rebuild takes minutes of CPU: only on request
    if rebuilds() {
        return;
    }
    let endpoint = endpoint(repo);
    if let Target::App(bundle) = &target {
        let _ = tokio::fs::remove_dir_all(sibling(bundle, "old")).await;
    }
    tokio::time::sleep(Duration::from_secs(30)).await;
    loop {
        {
            let mut updater = UPDATER.lock().await;
            let info = updater.check(true, repo, &endpoint, Some(&target)).await;
            if info["available"] == true {
                let result = updater.apply(repo, &endpoint, Some(&target)).await;
                match result["error"].as_str() {
                    None => eprintln!(
                        "update: v{} staged, restart to run it",
                        info["latest"].as_str().unwrap_or("?")
                    ),
                    Some(error) => eprintln!("update: {error}"),
                }
            }
        }
        tokio::time::sleep(AUTO_EVERY).await;
    }
}

fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', r"'\''"))
}

/// Relaunches the installed build once this process has exited, then quits through the desktop's SIGTERM path.
pub fn restart(desktop: bool) -> Value {
    use std::os::unix::process::CommandExt;
    let Some(target) = target().filter(|_| desktop) else {
        return json!({"ok":false,"error":"restart only works for the AppImage or the macOS app"});
    };
    let launch = match &target {
        Target::App(bundle) => format!("open -n {}", shell_quote(bundle)),
        // drop the old mount's env so the new image sets its own
        Target::AppImage(path) => format!(
            "env -u APPIMAGE -u APPDIR -u ARGV0 -u OWD {}",
            shell_quote(path)
        ),
    };
    let pid = std::process::id();
    let spawned = std::process::Command::new("sh")
        .arg("-c")
        .arg(format!(
            "while kill -0 {pid} 2>/dev/null; do sleep 0.2; done; {launch}"
        ))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .process_group(0)
        .spawn();
    if let Err(e) = spawned {
        return json!({"ok":false,"error":e.to_string()});
    }
    tokio::spawn(async move {
        // let the response go out first
        tokio::time::sleep(Duration::from_millis(300)).await;
        let _ = tokio::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()
            .await;
    });
    json!({"ok":true})
}

/// Plugins of this build with a newer release that a rebuild would pick up (not pinned in plugins.json).
/// The `owner/name[@tag]` specs `tramecli plugins add` listed in plugins.json.
fn listed_plugins(root: &Path) -> Vec<String> {
    let list = std::env::var_os("TRAME_PLUGINS_FILE")
        .map_or_else(|| root.join("plugins.json"), PathBuf::from);
    std::fs::read_to_string(list)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| serde_json::from_value(v["plugins"].clone()).ok())
        .unwrap_or_default()
}

/// Listed plugins this build does not contain: a stock release installed over a plugin build.
fn missing_plugins(specs: &[String], manifests: &[Value]) -> Vec<String> {
    specs
        .iter()
        .map(|s| s.split_once('@').map_or(s.as_str(), |(repo, _)| repo))
        .filter(|repo| {
            !manifests.iter().any(|m| {
                m["repo"]
                    .as_str()
                    .is_some_and(|r| r.eq_ignore_ascii_case(repo))
            })
        })
        .map(str::to_owned)
        .collect()
}

async fn pending_plugins(root: &Path, settings: &Path) -> Vec<Value> {
    let specs = listed_plugins(root);
    let pinned = |repo: &str| {
        specs.iter().any(|s| {
            s.split_once('@')
                .is_some_and(|(r, _)| r.eq_ignore_ascii_case(repo))
        })
    };
    let manifests = crate::plugins::manifest_list(settings);
    let updates = crate::plugin_updates::serve(false, false, settings).await;
    updates
        .as_array()
        .into_iter()
        .flatten()
        .filter(|u| u["available"] == true)
        .filter(|u| {
            manifests
                .iter()
                .find(|m| m["id"] == u["id"])
                .and_then(|m| m["repo"].as_str())
                .is_some_and(|repo| !pinned(repo))
        })
        .map(|u| json!({"id":u["id"],"current":u["current"],"latest":u["latest"]}))
        .collect()
}

// when the running rebuild started
static BUILDING: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);

fn building_since() -> std::sync::MutexGuard<'static, Option<Instant>> {
    BUILDING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

// (marker a log line starts with, once trimmed, phase it opens); the last match wins
const PHASES: &[(&str, &str)] = &[
    ("bun install", "Installing dependencies"),
    ("gen-plugins:", "Composing plugins"),
    ("> vite build", "Building the web app"),
    ("Compiling ", "Compiling"),
    ("Built application", "Packaging the AppImage"),
    ("installed ", "Installing"),
];

/// The phase a rebuild log has reached and its last line, without ANSI codes or overwritten progress.
fn progress(log: &str) -> (&'static str, String) {
    let ansi = regex::Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]").expect("valid regex");
    let mut phase = "Starting";
    let mut last = String::new();
    for raw in log.lines() {
        let clean = ansi.replace_all(raw.rsplit('\r').next().unwrap_or(""), "");
        let line = clean.trim();
        if line.is_empty() {
            continue;
        }
        if let Some((_, p)) = PHASES.iter().rev().find(|(m, _)| line.starts_with(m)) {
            phase = p;
        }
        line.clone_into(&mut last);
    }
    (phase, last.chars().take(200).collect())
}

/// `{phase, line, elapsedSecs}` of the running rebuild, from the tail of its log.
fn build_progress(log: &Path, since: Instant) -> Value {
    let text = std::fs::read(log).unwrap_or_default();
    let (phase, line) = progress(&String::from_utf8_lossy(&text));
    json!({"phase": phase, "line": line, "elapsedSecs": since.elapsed().as_secs()})
}

/// Rebuilds this `AppImage` with its plugins at Trame's latest release and swaps it in place.
async fn rebuild(image: &Path, root: &Path, latest: Option<String>) -> Value {
    let Some(cli) = std::env::current_exe()
        .ok()
        .map(|exe| exe.with_file_name("tramecli"))
        .filter(|cli| cli.is_file())
    else {
        return json!({"ok":false,"error":"no tramecli next to this build"});
    };
    {
        let mut since = building_since();
        if since.is_some() {
            return json!({"ok":false,"error":"a rebuild is already running"});
        }
        *since = Some(Instant::now());
    }
    let log = root.join("plugins-build.log");
    let image = image.to_owned();
    // its own task: a dropped request (a page reload) must not skip the bookkeeping below
    let task = tokio::spawn(async move {
        let result = run_build(&cli, &image, &log).await;
        *building_since() = None;
        match result {
            Ok(()) => {
                let mut updater = UPDATER.lock().await;
                updater.applied = Some(latest.unwrap_or_else(|| installed().to_owned()));
                updater.cache = None;
                json!({"ok":true})
            }
            Err(error) => json!({"ok":false,"error":error}),
        }
    });
    task.await
        .unwrap_or_else(|e| json!({"ok":false,"error":format!("rebuild task: {e}")}))
}

async fn run_build(cli: &Path, image: &Path, log: &Path) -> Result<(), String> {
    let out = std::fs::File::create(log).map_err(|e| e.to_string())?;
    let mut cmd = tokio::process::Command::new(cli);
    cmd.args(["plugins", "build", "--latest"])
        .arg(format!("--install={}", image.display()))
        .stdin(std::process::Stdio::null())
        .stdout(out.try_clone().map_err(|e| e.to_string())?)
        .stderr(out);
    for (key, value) in crate::host_env::host_env() {
        match value {
            Some(value) => cmd.env(key, value),
            None => cmd.env_remove(key),
        };
    }
    let status = cmd.status().await.map_err(|e| format!("tramecli: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("rebuild failed ({status}), see {}", log.display()))
    }
}

pub async fn serve(
    post: bool,
    force: bool,
    offline: bool,
    root: &Path,
    settings: &Path,
) -> (u16, Value) {
    if offline && post {
        return (503, json!({"error":"unavailable in offline mode"}));
    }
    let Some(repo) = repo() else {
        return (
            200,
            if post {
                json!({"ok":false,"error":"this build does not self-update: rebuild it with its plugins"})
            } else {
                json!({"current":installed(),"latest":null,"available":false,"releaseUrl":"","canSelfUpdate":false,"off":"this build has no release channel"})
            },
        );
    };
    let off = if offline {
        Some("offline mode")
    } else if std::env::var("TRACKER_UPDATE_CHECK").as_deref() == Ok("0") {
        Some("TRACKER_UPDATE_CHECK=0")
    } else {
        None
    };
    if let (false, Some(off)) = (post, off) {
        return (
            200,
            json!({"current":installed(),"latest":null,"available":false,"releaseUrl":"","canSelfUpdate":false,"off":off}),
        );
    }
    let target = target();
    let endpoint = endpoint(repo);
    // a stock AppImage over a plugin build: offer the rebuild that brings the plugins back
    let missing = if rebuilds() || !matches!(target, Some(Target::AppImage(_))) {
        Vec::new()
    } else {
        missing_plugins(
            &listed_plugins(root),
            &crate::plugins::manifest_list(settings),
        )
    };
    if rebuilds() || !missing.is_empty() {
        let image = match &target {
            Some(Target::AppImage(path)) => Some(path.clone()),
            _ => None,
        };
        let mut info = UPDATER
            .lock()
            .await
            .check(force, repo, &endpoint, image.as_ref().and(target.as_ref()))
            .await;
        let plugins = pending_plugins(root, settings).await;
        let trame_newer = info["available"] == true;
        if !(plugins.is_empty() && missing.is_empty()) && info["applied"] != true {
            info["available"] = json!(true);
        }
        info["plugins"] = json!(plugins);
        if !missing.is_empty() {
            info["missing"] = json!(missing);
        }
        info["rebuild"] = json!(true);
        if let Some(since) = *building_since() {
            info["building"] = build_progress(&root.join("plugins-build.log"), since);
        }
        if !post {
            return (200, info);
        }
        let Some(image) = image else {
            return (
                200,
                json!({"ok":false,"error":"rebuilding only replaces an AppImage"}),
            );
        };
        if info["available"] != true {
            return (200, json!({"ok":false,"error":"already up to date"}));
        }
        let latest = trame_newer
            .then(|| info["latest"].as_str().map(str::to_owned))
            .flatten();
        return (200, rebuild(&image, root, latest).await);
    }
    let mut updater = UPDATER.lock().await;
    (
        200,
        if post {
            updater.apply(repo, &endpoint, target.as_ref()).await
        } else {
            updater.check(force, repo, &endpoint, target.as_ref()).await
        },
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn listed_plugins_this_build_lacks_are_missing() {
        let manifests = [
            json!({"id": "k8s", "repo": "Acme/trame-k8s"}),
            json!({"id": "notebook"}),
        ];
        for (specs, missing) in [
            (vec![], vec![]),
            (vec!["acme/trame-k8s@v1.2.0"], vec![]),
            (
                vec!["Acme/trame-k8s", "Globex/trame-cockpit@v0.3.0"],
                vec!["Globex/trame-cockpit"],
            ),
        ] {
            let specs: Vec<String> = specs.into_iter().map(str::to_owned).collect();
            assert_eq!(missing_plugins(&specs, &manifests), missing, "{specs:?}");
        }
    }

    #[test]
    fn rebuild_progress_reads_the_last_phase_and_line() {
        for (log, phase, line) in [
            ("", "Starting", ""),
            (
                "bun install v1.4.0\nChecked 11 installs\n",
                "Installing dependencies",
                "Checked 11 installs",
            ),
            (
                "gen-plugins: a\n> vite build\n✓ built in 10s\n   Compiling tokio v1\n\n",
                "Compiling",
                "Compiling tokio v1",
            ),
            (
                "   Compiling x\n\x1b[1m    Bundling\x1b[0m T.AppImage\n",
                "Compiling",
                "Bundling T.AppImage",
            ),
            (
                "Built application at: t\n 10%\r 55%\n",
                "Packaging the AppImage",
                "55%",
            ),
            (
                "installed /x/Trame.AppImage; restart\n",
                "Installing",
                "installed /x/Trame.AppImage; restart",
            ),
        ] {
            assert_eq!(progress(log), (phase, line.to_owned()), "{log:?}");
        }
    }
    #[test]
    fn versions() {
        for (a, b, want) in [
            ("0.14.0", "0.13.0", true),
            ("1", "0.99.99", true),
            ("0.13.0", "0.13.0", false),
            ("0.12.9", "0.13.0", false),
            ("x", "0.1.0", false),
            ("0.23.0-2", "0.23.0-1", true),
            ("0.23.0-1", "0.23.0", true),
            ("0.23.0", "0.23.0-1", false),
            ("0.24.0", "0.23.0-9", true),
            ("1.x.0", "0.1.0", false),
            ("0.23.0-rc1", "0.22.0", false),
            ("0.23.0-1-2", "0.22.0", false),
        ] {
            assert_eq!(newer(a, b), want);
        }
    }
    #[test]
    fn app_bundle_of_finds_the_enclosing_app() {
        for (exe, want) in [
            (
                "/Applications/Trame.app/Contents/MacOS/trame",
                Some("/Applications/Trame.app"),
            ),
            (
                "/Users/me/My Apps/Trame.app/Contents/MacOS/trame",
                Some("/Users/me/My Apps/Trame.app"),
            ),
            ("/Applications/Trame.app/Contents/Resources/x", None),
            ("/opt/homebrew/bin/trame", None),
        ] {
            assert_eq!(
                app_bundle_of(Path::new(exe)),
                want.map(PathBuf::from),
                "{exe}"
            );
        }
    }
    #[test]
    fn asset_pattern_matches_only_this_platforms_build() {
        let assets = [
            "trame-v0.18.0-linux-x64.deb",
            "Trame-v0.18.0-native-arm64.dmg",
            "Trame-v0.18.0-native-x64.AppImage",
            "tramecli-v0.18.0-macos-arm64",
        ];
        for (os, arch, want) in [
            ("linux", "x86_64", Some("Trame-v0.18.0-native-x64.AppImage")),
            ("macos", "aarch64", Some("Trame-v0.18.0-native-arm64.dmg")),
            ("macos", "x86_64", None),
            ("windows", "x86_64", None),
        ] {
            let found = asset_pattern(os, arch).and_then(|p| {
                let re = regex::Regex::new(p).unwrap();
                assets.into_iter().find(|a| re.is_match(a))
            });
            assert_eq!(found, want, "{os}/{arch}");
        }
    }
    #[tokio::test]
    async fn offline_has_no_network_or_update() {
        let none = Path::new("/nonexistent");
        assert_eq!(
            serve(true, false, true, none, none).await,
            (503, json!({"error":"unavailable in offline mode"}))
        );
        assert_eq!(
            serve(false, false, true, none, none).await.1,
            json!({"current":installed(),"latest":null,"available":false,"releaseUrl":"","canSelfUpdate":false,"off":"offline mode"})
        );
    }
    // self-update is AppImage-only
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn updater_download_is_atomic_and_preserves_existing_files() {
        use axum::{Router, routing::get};
        use std::future::IntoFuture;
        let root = crate::scratch_root(
            &crate::workspace().join(format!(".scratch/update-{}", uuid::Uuid::new_v4())),
        )
        .unwrap();
        let path = root.join("Trame.AppImage");
        std::fs::write(&path, "old").unwrap();
        let target = Target::AppImage(path.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let asset = format!("{base}/image");
        let server=tokio::spawn(axum::serve(listener,Router::new().route("/latest",get(move||{let asset=asset.clone();async move{axum::Json(json!({"tag_name":"v99.0.0","html_url":"https://fixture.invalid/release","assets":[{"name":"trame-linux.AppImage","browser_download_url":"http://127.0.0.1:1/legacy"},{"name":"Trame-v99.0.0-native-x64.AppImage","browser_download_url":asset}]}))}})).route("/image",get(||async{"new image"}))).into_future());
        let mut updater = Updater::default();
        let endpoint = format!("{base}/latest");
        std::fs::write(path.with_extension("AppImage.new"), "other process").unwrap();
        assert_eq!(
            updater.apply("o/r", &endpoint, Some(&target)).await["ok"],
            false
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "old");
        assert_eq!(
            std::fs::read_to_string(path.with_extension("AppImage.new")).unwrap(),
            "other process"
        );
        std::fs::remove_file(path.with_extension("AppImage.new")).unwrap();
        assert_eq!(
            updater.apply("o/r", &endpoint, Some(&target)).await,
            json!({"ok":true})
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new image");
        assert_eq!(
            updater.check(false, "o/r", &endpoint, Some(&target)).await["applied"],
            true
        );
        server.abort();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn failed_check_is_not_cached() {
        use axum::{Router, http::StatusCode, routing::get};
        use std::future::IntoFuture;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(
            axum::serve(
                listener,
                Router::new()
                    .route("/down", get(|| async { StatusCode::FORBIDDEN }))
                    .route(
                        "/latest",
                        get(|| async { axum::Json(json!({"tag_name":"v99.0.0","assets":[]})) }),
                    ),
            )
            .into_future(),
        );
        let mut updater = Updater::default();
        let failed = updater
            .check(false, "o/r", &format!("{base}/down"), None)
            .await;
        assert_eq!(
            (failed["checked"].clone(), failed["latest"].clone()),
            (json!(false), Value::Null)
        );
        assert!(
            failed["error"]
                .as_str()
                .is_some_and(|e| e.starts_with("GitHub")),
            "{failed}"
        );
        let info = updater
            .check(false, "o/r", &format!("{base}/latest"), None)
            .await;
        assert_eq!(
            (info["checked"].clone(), info["latest"].clone()),
            (json!(true), json!("99.0.0"))
        );
        server.abort();
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[tokio::test]
    async fn updater_swaps_the_app_bundle_from_the_dmg() {
        use axum::{Router, routing::get};
        use std::future::IntoFuture;
        let root = crate::scratch_root(
            &crate::workspace().join(format!(".scratch/update-{}", uuid::Uuid::new_v4())),
        )
        .unwrap();
        let make_app = |dir: &Path, body: &str| {
            std::fs::create_dir_all(dir.join("Trame.app/Contents/MacOS")).unwrap();
            std::fs::write(dir.join("Trame.app/Contents/MacOS/trame"), body).unwrap();
        };
        make_app(&root.join("src"), "new build");
        make_app(&root.join("install"), "old build");
        let dmg = root.join("Trame.dmg");
        let built = std::process::Command::new("hdiutil")
            .args(["create", "-quiet", "-format", "UDZO", "-srcfolder"])
            .args([root.join("src"), dmg.clone()])
            .status()
            .unwrap();
        assert!(built.success());
        let bytes = std::fs::read(&dmg).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let asset = format!("{base}/dmg");
        let server = tokio::spawn(
            axum::serve(
                listener,
                Router::new()
                    .route(
                        "/latest",
                        get(move || {
                            let asset = asset.clone();
                            async move {
                                axum::Json(json!({"tag_name":"v99.0.0","html_url":"https://fixture.invalid/release","assets":[{"name":"Trame-v99.0.0-native-x64.AppImage","browser_download_url":"http://127.0.0.1:1/linux"},{"name":"Trame-v99.0.0-native-arm64.dmg","browser_download_url":asset}]}))
                            }
                        }),
                    )
                    .route("/dmg", get(move || async move { bytes })),
            )
            .into_future(),
        );
        let bundle = root.join("install/Trame.app");
        let mut updater = Updater::default();
        let endpoint = format!("{base}/latest");
        assert_eq!(
            updater
                .apply("o/r", &endpoint, Some(&Target::App(bundle.clone())))
                .await,
            json!({"ok":true})
        );
        let read = |p: &Path| std::fs::read_to_string(p.join("Contents/MacOS/trame")).unwrap();
        assert_eq!(read(&bundle), "new build");
        assert_eq!(read(&sibling(&bundle, "old")), "old build");
        assert!(!sibling(&bundle, "new").exists());
        // a later click (e.g. the banner) after the background update just reports success
        assert_eq!(
            updater
                .apply("o/r", &endpoint, Some(&Target::App(bundle.clone())))
                .await,
            json!({"ok":true})
        );
        server.abort();
        std::fs::remove_dir_all(root).unwrap();
    }
}
