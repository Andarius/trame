use serde_json::{Value, json};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct Updater {
    cache: Option<(Instant, Value)>,
    asset: Option<String>,
    applied: bool,
}
static UPDATER: Mutex<Updater> = Mutex::const_new(Updater {
    cache: None,
    asset: None,
    applied: false,
});
#[allow(
    clippy::float_cmp,
    reason = "exact float comparison is intentional for parity"
)]
pub fn newer(a: &str, b: &str) -> bool {
    let a: Vec<_> = a
        .split('.')
        .map(|s| crate::routes::number(s).unwrap_or(f64::NAN))
        .collect();
    let b: Vec<_> = b
        .split('.')
        .map(|s| crate::routes::number(s).unwrap_or(f64::NAN))
        .collect();
    for i in 0..3 {
        let a = a.get(i).copied().unwrap_or(0.0);
        let b = b.get(i).copied().unwrap_or(0.0);
        if a != b {
            return a > b;
        }
    }
    false
}
impl Updater {
    async fn check(
        &mut self,
        force: bool,
        endpoint: &str,
        target: Option<&std::path::Path>,
    ) -> Value {
        if !force {
            if let Some((at, info)) = &self.cache {
                if at.elapsed() < Duration::from_hours(1) {
                    return info.clone();
                }
            }
        }
        let mut info = json!({"current":crate::runtime::version(),"latest":null,"available":false,"releaseUrl":"https://github.com/Andarius/trame/releases/latest","canSelfUpdate":cfg!(target_os="linux")&&target.is_some(),"applied":self.applied});
        let client = reqwest::Client::new();
        if let Ok(response) = client
            .get(endpoint)
            .header("accept", "application/vnd.github+json")
            .header("user-agent", "Trame")
            .timeout(Duration::from_secs(8))
            .send()
            .await
        {
            if response.status().is_success() {
                if let Ok(rel) = response.json::<Value>().await {
                    let tag = rel["tag_name"]
                        .as_str()
                        .unwrap_or("")
                        .strip_prefix('v')
                        .unwrap_or_else(|| rel["tag_name"].as_str().unwrap_or(""));
                    info["latest"] = if tag.is_empty() {
                        Value::Null
                    } else {
                        json!(tag)
                    };
                    info["available"] =
                        json!(!tag.is_empty() && newer(tag, crate::runtime::version()));
                    if !rel["html_url"].is_null() {
                        info["releaseUrl"] = rel["html_url"].clone();
                    }
                    self.asset = rel["assets"]
                        .as_array()
                        .and_then(|a| {
                            a.iter().find(|a| {
                                regex::Regex::new(r"(?i)^Trame-v?[^/]+-native-x64\.AppImage$")
                                    .unwrap()
                                    .is_match(a["name"].as_str().unwrap_or(""))
                            })
                        })
                        .and_then(|a| a["browser_download_url"].as_str())
                        .map(str::to_owned);
                }
            }
        }
        self.cache = Some((Instant::now(), info.clone()));
        info
    }
    async fn apply(&mut self, endpoint: &str, target: Option<&std::path::Path>) -> Value {
        let Some(target) = target.filter(|_| cfg!(target_os = "linux")) else {
            return json!({"ok":false,"error":"self-update only works for the AppImage"});
        };
        if self.check(true, endpoint, Some(target)).await["available"] != true {
            return json!({"ok":false,"error":"already up to date"});
        }
        let Some(asset) = &self.asset else {
            return json!({"ok":false,"error":"no AppImage asset on the latest release"});
        };
        let tmp = PathBuf::from(format!("{}.new", target.display()));
        let mut created = false;
        let result = async {
            use std::os::unix::fs::OpenOptionsExt;
            use tokio::io::AsyncWriteExt;
            let response = reqwest::Client::new()
                .get(asset)
                .timeout(Duration::from_mins(2))
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
                .open(&tmp)
                .map_err(|e| e.to_string())?;
            created = true;
            let mut file = tokio::fs::File::from_std(file);
            let mut response = response;
            while let Some(bytes) = response
                .chunk()
                .await
                .map_err(|_| "download interrupted".to_owned())?
            {
                file.write_all(&bytes).await.map_err(|e| e.to_string())?;
            }
            file.sync_all().await.map_err(|e| e.to_string())?;
            drop(file);
            tokio::fs::rename(&tmp, target)
                .await
                .map_err(|e| e.to_string())?;
            Ok::<_, String>(())
        }
        .await;
        match result {
            Ok(()) => {
                self.applied = true;
                self.cache = None;
                json!({"ok":true})
            }
            Err(error) => {
                if created {
                    let _ = tokio::fs::remove_file(tmp).await;
                }
                json!({"ok":false,"error":error})
            }
        }
    }
}
pub async fn serve(post: bool, force: bool, offline: bool) -> (u16, Value) {
    if offline && post {
        return (503, json!({"error":"unavailable in offline mode"}));
    }
    if !post && (offline || std::env::var("TRACKER_UPDATE_CHECK").as_deref() == Ok("0")) {
        return (
            200,
            json!({"current":crate::runtime::version(),"latest":null,"available":false,"releaseUrl":"","canSelfUpdate":false}),
        );
    }
    let target = std::env::var_os("APPIMAGE").map(PathBuf::from);
    let endpoint = "https://api.github.com/repos/Andarius/trame/releases/latest";
    let mut updater = UPDATER.lock().await;
    (
        200,
        if post {
            updater.apply(endpoint, target.as_deref()).await
        } else {
            updater.check(force, endpoint, target.as_deref()).await
        },
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn versions() {
        for (a, b, want) in [
            ("0.14.0", "0.13.0", true),
            ("1", "0.99.99", true),
            ("0.13.0", "0.13.0", false),
            ("0.12.9", "0.13.0", false),
            ("x", "0.1.0", false),
        ] {
            assert_eq!(newer(a, b), want);
        }
    }
    #[tokio::test]
    async fn offline_has_no_network_or_update() {
        assert_eq!(
            serve(true, false, true).await,
            (503, json!({"error":"unavailable in offline mode"}))
        );
        assert_eq!(
            serve(false, false, true).await.1,
            json!({"current":crate::runtime::version(),"latest":null,"available":false,"releaseUrl":"","canSelfUpdate":false})
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
        let target = root.join("Trame.AppImage");
        std::fs::write(&target, "old").unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let asset = format!("{base}/image");
        let server=tokio::spawn(axum::serve(listener,Router::new().route("/latest",get(move||{let asset=asset.clone();async move{axum::Json(json!({"tag_name":"v99.0.0","html_url":"https://fixture.invalid/release","assets":[{"name":"trame-linux.AppImage","browser_download_url":"http://127.0.0.1:1/legacy"},{"name":"Trame-v99.0.0-native-x64.AppImage","browser_download_url":asset}]}))}})).route("/image",get(||async{"new image"}))).into_future());
        let mut updater = Updater::default();
        let endpoint = format!("{base}/latest");
        std::fs::write(target.with_extension("AppImage.new"), "other process").unwrap();
        assert_eq!(updater.apply(&endpoint, Some(&target)).await["ok"], false);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "old");
        assert_eq!(
            std::fs::read_to_string(target.with_extension("AppImage.new")).unwrap(),
            "other process"
        );
        std::fs::remove_file(target.with_extension("AppImage.new")).unwrap();
        assert_eq!(
            updater.apply(&endpoint, Some(&target)).await,
            json!({"ok":true})
        );
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new image");
        assert_eq!(
            updater.check(false, &endpoint, Some(&target)).await["applied"],
            true
        );
        server.abort();
        std::fs::remove_dir_all(root).unwrap();
    }
}
