// Release check for out-of-tree plugins that declare `version` and `repo`: GitHub `owner/name`, or
// `owner/name/plugin` for one plugin of a plugins repo, released as `<plugin>-vX.Y.Z` tags.
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

const API: &str = "https://api.github.com";
const TTL: Duration = Duration::from_hours(1);

// repo → (checked at, latest tag without `v`, release page)
type Cache = HashMap<String, (Instant, Option<(String, String)>)>;
static CACHE: Mutex<Option<Cache>> = Mutex::const_new(None);

/// `owner/name` and, for a plugins repo, the plugin's name; `None` unless safe in an API path.
pub fn split_repo(repo: &str) -> Option<(&str, Option<&str>)> {
    let ok = |s: &str| {
        !s.is_empty()
            && !s.starts_with('.')
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    };
    let parts: Vec<&str> = repo.split('/').collect();
    if !(2..=3).contains(&parts.len()) || !parts.iter().all(|p| ok(p)) {
        return None;
    }
    let name_end = parts[0].len() + 1 + parts[1].len();
    Some((&repo[..name_end], parts.get(2).copied()))
}

pub fn valid_repo(repo: &str) -> bool {
    split_repo(repo).is_some()
}

async fn get(api: &str, path: &str) -> Option<Value> {
    let response = reqwest::Client::new()
        .get(format!("{api}{path}"))
        .header("accept", "application/vnd.github+json")
        .header("user-agent", "Trame")
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<Value>().await.ok()
}

/// The newest `<plugin>-vX.Y.Z` among `releases` (drafts and prereleases skipped), as `X.Y.Z`.
fn newest_for(releases: &[Value], plugin: &str) -> Option<(String, String)> {
    let prefix = format!("{plugin}-v");
    releases
        .iter()
        .filter(|r| r["draft"] != true && r["prerelease"] != true)
        .filter_map(|r| {
            let version = r["tag_name"].as_str()?.strip_prefix(&prefix)?;
            let key: Vec<u64> = version
                .split('.')
                .map(str::parse)
                .collect::<Result<_, _>>()
                .ok()?;
            (key.len() == 3).then(|| (key, version.to_owned(), r["html_url"].clone()))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, version, url)| (version, url.as_str().unwrap_or("").to_owned()))
}

async fn latest(api: &str, repo: &str) -> Option<(String, String)> {
    let (name, plugin) = split_repo(repo)?;
    if let Some(plugin) = plugin {
        let releases = get(api, &format!("/repos/{name}/releases?per_page=100")).await?;
        return newest_for(releases.as_array()?, plugin);
    }
    let rel = get(api, &format!("/repos/{name}/releases/latest")).await?;
    let tag = rel["tag_name"].as_str()?;
    let tag = tag.strip_prefix('v').unwrap_or(tag);
    if tag.is_empty() {
        return None;
    }
    let url = rel["html_url"].as_str().map_or_else(
        || format!("https://github.com/{name}/releases/latest"),
        str::to_owned,
    );
    Some((tag.to_owned(), url))
}

/// One entry per manifest carrying a valid `repo` and a `version`; repos are fetched concurrently.
async fn check(cache: &mut Cache, manifests: &[Value], api: &str, force: bool) -> Vec<Value> {
    let tracked: Vec<(&str, &str, &str)> = manifests
        .iter()
        .filter_map(|m| {
            Some((
                m["id"].as_str()?,
                m["version"].as_str()?,
                m["repo"].as_str()?,
            ))
        })
        .filter(|(_, _, repo)| valid_repo(repo))
        .collect();
    let mut stale: Vec<&str> = tracked
        .iter()
        .map(|(_, _, repo)| *repo)
        .filter(|repo| force || cache.get(*repo).is_none_or(|(at, _)| at.elapsed() >= TTL))
        .collect();
    stale.sort_unstable();
    stale.dedup();
    let fetched = futures_util::future::join_all(stale.iter().map(|repo| latest(api, repo))).await;
    for (repo, release) in stale.into_iter().zip(fetched) {
        cache.insert(repo.to_owned(), (Instant::now(), release));
    }
    tracked
        .into_iter()
        .map(|(id, version, repo)| {
            let release = cache.get(repo).and_then(|(_, r)| r.clone());
            let available = release
                .as_ref()
                .is_some_and(|(tag, _)| crate::update::newer(tag, version));
            let (latest, url) = release.map_or((None, None), |(t, u)| (Some(t), Some(u)));
            json!({"id":id,"current":version,"latest":latest,"available":available,"releaseUrl":url})
        })
        .collect()
}

pub async fn serve(force: bool, offline: bool, settings: &std::path::Path) -> Value {
    if offline || std::env::var("TRACKER_UPDATE_CHECK").as_deref() == Ok("0") {
        return json!([]);
    }
    let manifests = crate::plugins::manifest_list(settings);
    let mut cache = CACHE.lock().await;
    Value::Array(check(cache.get_or_insert_default(), &manifests, API, force).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    #[test]
    fn repo_format() {
        for (repo, want) in [
            ("acme/deploy-plugin", true),
            ("Acme_Co/plugin.rs", true),
            ("acme", false),
            ("acme/plugins/deploy", true),
            ("acme/plugins/deploy/extra", false),
            ("acme/plugins/..", false),
            ("/deploy", false),
            ("acme/", false),
            ("acme/..", false),
            ("acme/deploy?x=1", false),
            ("https://github.com/acme/deploy", false),
        ] {
            assert_eq!(valid_repo(repo), want, "{repo}");
        }
    }

    #[tokio::test]
    async fn check_compares_versions_and_caches() {
        use axum::{Router, extract::Path, routing::get};
        use std::future::IntoFuture;
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api = format!("http://{}", listener.local_addr().unwrap());
        let listed = hits.clone();
        let app = Router::new()
            .route(
                "/repos/{owner}/{name}/releases",
                get(move || {
                    listed.fetch_add(1, Ordering::SeqCst);
                    async {
                        axum::Json(json!([
                            {"tag_name":"deploy-v0.10.0","html_url":"https://fixture.invalid/d10"},
                            {"tag_name":"deploy-v0.9.0","html_url":"https://fixture.invalid/d9"},
                            {"tag_name":"deploy-v0.11.0","prerelease":true,"html_url":"https://fixture.invalid/rc"},
                            {"tag_name":"other-v9.0.0","html_url":"https://fixture.invalid/o"},
                        ]))
                    }
                }),
            )
            .route(
            "/repos/{owner}/{name}/releases/latest",
            get(move |Path((owner, name)): Path<(String, String)>| {
                counter.fetch_add(1, Ordering::SeqCst);
                async move {
                    match name.as_str() {
                        "missing" => Err(axum::http::StatusCode::NOT_FOUND),
                        _ => Ok(axum::Json(
                            json!({"tag_name":"v0.2.0","html_url":format!("https://fixture.invalid/{owner}/{name}")}),
                        )),
                    }
                }
            }),
        );
        let server = tokio::spawn(axum::serve(listener, app).into_future());
        let manifests = [
            json!({"id":"old","version":"0.1.0","repo":"acme/deploy"}),
            json!({"id":"same","version":"0.2.0","repo":"acme/deploy"}),
            json!({"id":"ahead","version":"0.3.0","repo":"acme/other"}),
            json!({"id":"gone","version":"0.1.0","repo":"acme/missing"}),
            json!({"id":"bad-repo","version":"0.1.0","repo":"acme/../x"}),
            json!({"id":"member","version":"0.9.1","repo":"acme/plugins/deploy"}),
            json!({"id":"no-release","version":"0.1.0","repo":"acme/plugins/new"}),
            json!({"id":"no-version","repo":"acme/deploy"}),
            json!({"id":"builtin"}),
        ];
        let mut cache = Cache::new();
        let got = check(&mut cache, &manifests, &api, false).await;
        let url = |r: &str| json!(format!("https://fixture.invalid/acme/{r}"));
        assert_eq!(
            got,
            vec![
                json!({"id":"old","current":"0.1.0","latest":"0.2.0","available":true,"releaseUrl":url("deploy")}),
                json!({"id":"same","current":"0.2.0","latest":"0.2.0","available":false,"releaseUrl":url("deploy")}),
                json!({"id":"ahead","current":"0.3.0","latest":"0.2.0","available":false,"releaseUrl":url("other")}),
                json!({"id":"gone","current":"0.1.0","latest":null,"available":false,"releaseUrl":null}),
                json!({"id":"member","current":"0.9.1","latest":"0.10.0","available":true,"releaseUrl":"https://fixture.invalid/d10"}),
                json!({"id":"no-release","current":"0.1.0","latest":null,"available":false,"releaseUrl":null}),
            ]
        );
        assert_eq!(
            hits.load(Ordering::SeqCst),
            5,
            "one request per repo or plugin"
        );
        for (force, want) in [(false, 5), (true, 10)] {
            assert_eq!(check(&mut cache, &manifests, &api, force).await, got);
            assert_eq!(hits.load(Ordering::SeqCst), want, "force={force}");
        }
        server.abort();
    }

    #[tokio::test]
    async fn offline_skips_the_check() {
        assert_eq!(
            serve(true, true, std::path::Path::new("/nonexistent")).await,
            json!([])
        );
    }
}
