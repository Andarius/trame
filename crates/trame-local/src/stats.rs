// Usage stats for the Insights view: worklog and cards from the DB, prompts and tokens from agent transcripts.
use crate::{
    db::Db,
    imports::{transcript, transcript_dir},
    routes::{Native, json_response},
    settings,
};
use anyhow::Result;
use axum::response::Response;
use chrono::{DateTime, Local, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fs::File,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Instant, UNIX_EPOCH},
};

const DAYS: i64 = 366;
const CACHE: &str = "stats-cache.json";
const CACHE_VERSION: u32 = 3;
// how long fetched merged PRs, and other devices' usage, stay fresh
const PRS_TTL_MS: i64 = 15 * 60_000;
static SCAN: Mutex<()> = Mutex::new(());
static FETCHING: AtomicBool = AtomicBool::new(false);
static SHARING: AtomicBool = AtomicBool::new(false);

pub fn owns(method: &str, path: &str) -> bool {
    method == "GET" && path == "/api/stats"
}

pub async fn serve(state: Native) -> Response {
    let result = crate::blocking::spawn(move || stats(&state)).await;
    match result {
        Ok(Ok(value)) => json_response(200, value),
        Ok(Err(error)) => json_response(500, json!({"error":format!("{error:#}")})),
        Err(_) => json_response(500, json!({"error":"stats failed"})),
    }
}

#[derive(Default, Clone, Copy, Serialize, Deserialize, PartialEq, Debug)]
struct Tokens {
    input: u64,
    output: u64,
}

/// One transcript's activity: prompts per day, tokens per day and model.
#[derive(Default, Serialize, Deserialize, PartialEq, Debug)]
struct FileStats {
    source: String,
    cwd: Option<String>,
    prompts: BTreeMap<NaiveDate, u64>,
    tokens: BTreeMap<NaiveDate, BTreeMap<String, Tokens>>,
}

#[derive(Serialize, Deserialize)]
struct Cached {
    len: u64,
    mtime: u128,
    stats: FileStats,
}

#[derive(Serialize, Deserialize)]
struct MergedPr {
    day: NaiveDate,
    repo: String,
}

/// Another device's daily prompts and tokens, as the hub's `GET /usage` returns them.
#[derive(Serialize, Deserialize, Clone)]
struct DeviceUsage {
    node_id: String,
    d: NaiveDate,
    p: Option<String>,
    r: Option<String>,
    a: String,
    m: Option<String>,
    prompts: u64,
    tokens: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct Cache {
    version: u32,
    files: HashMap<PathBuf, Cached>,
    // merged PRs and MRs by link, and when each forge ("github" or a GitLab host) was last asked
    prs: BTreeMap<String, MergedPr>,
    checked: BTreeMap<String, i64>,
    // the other devices' usage from the hub, when it was last asked, and a hash of each day this device pushed
    usage: Vec<DeviceUsage>,
    usage_checked: Option<i64>,
    usage_pushed: BTreeMap<NaiveDate, u64>,
}

#[derive(Default)]
struct Counts {
    prompts: u64,
    entries: u64,
    tokens: u64,
    done: u64,
    prs: u64,
    merged: u64,
}

// date, project id, repo name (when no project), agent, model
type Key = (
    NaiveDate,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
);

/// What the DB says about where work belongs.
#[derive(Default)]
struct Owners {
    // card repo path → project id
    repos: Vec<(String, String)>,
    // PR repo (as `forge::pr_repo`) → project id
    pr_projects: HashMap<String, String>,
    gitlab_hosts: BTreeSet<String>,
}

fn stats(state: &Native) -> Result<Value> {
    let started = Instant::now();
    let mut db = Db::connect(
        &state.root.join("socket"),
        &state.origin,
        Some(state.settings.clone()),
    )?;
    let claude = transcript_dir(&db, "TRACKER_CLAUDE_DIR", "claude-projects")?;
    let codex = transcript_dir(&db, "TRACKER_CODEX_DIR", "codex-sessions")?;
    let from = Local::now().date_naive() - chrono::Days::new(DAYS as u64);
    let mut rows: BTreeMap<Key, Counts> = BTreeMap::new();
    let owners = db_rows(&mut db, from, &mut rows)?;
    drop(db);
    let cache_path = state.root.join(CACHE);
    let _scan = SCAN
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut cache = load_cache(&cache_path);
    let mut mine: BTreeMap<Key, Counts> = BTreeMap::new();
    let (files, parsed, changed) =
        transcript_rows(&mut cache, &claude, &codex, from, &owners.repos, &mut mine);
    share_usage(state, &cache, &cache_path, from, &mine);
    for (key, c) in mine {
        let row = rows.entry(key).or_default();
        row.prompts += c.prompts;
        row.tokens += c.tokens;
    }
    for u in cache.usage.iter().filter(|u| u.d >= from) {
        let row = rows
            .entry((u.d, u.p.clone(), u.r.clone(), u.a.clone(), u.m.clone()))
            .or_default();
        row.prompts += u.prompts;
        row.tokens += u.tokens;
    }
    let stale = stale_forges(&cache, &owners.gitlab_hosts);
    if !state.sync.offline && !stale.is_empty() && !FETCHING.swap(true, Ordering::SeqCst) {
        let since: Vec<_> = stale
            .iter()
            .map(|f| (f.clone(), fetch_since(&cache, f, from)))
            .collect();
        let path = cache_path.clone();
        std::thread::spawn(move || {
            let found = fetch_merged(since);
            let _scan = SCAN
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let mut cache = load_cache(&path);
            for (forge, prs) in found {
                cache.prs.extend(prs);
                cache.checked.insert(forge, Local::now().timestamp_millis());
            }
            save_cache(&path, &mut cache);
            FETCHING.store(false, Ordering::SeqCst);
        });
    }
    merged_rows(&cache, from, &owners.pr_projects, &mut rows);
    if changed {
        save_cache(&cache_path, &mut cache);
    }
    let rows: Vec<Value> = rows
        .into_iter()
        .map(|((d, p, r, a, m), c)| {
            json!({"d":d,"p":p,"r":r,"a":a,"m":m,"prompts":c.prompts,"entries":c.entries,"tokens":c.tokens,"done":c.done,"prs":c.prs,"merged":c.merged})
        })
        .collect();
    Ok(json!({
        "today": Local::now().date_naive(),
        "rows": rows,
        "scan": {"files": files, "parsed": parsed, "ms": started.elapsed().as_millis()},
        "prs": {"pending": FETCHING.load(Ordering::SeqCst), "fetched": !cache.checked.is_empty()},
        "devices": {
            "others": cache.usage.iter().map(|u| &u.node_id).collect::<BTreeSet<_>>().len(),
            "pending": SHARING.load(Ordering::SeqCst),
            "hub": settings::hub_api(&state.settings).is_some() && !state.sync.offline,
        },
    }))
}

/// In the background, at most every `PRS_TTL_MS`: push this device's transcript counts to the hub
/// when they changed, then fetch the user's other devices' counts into the cache.
fn share_usage(
    state: &Native,
    cache: &Cache,
    path: &Path,
    from: NaiveDate,
    mine: &BTreeMap<Key, Counts>,
) {
    let now = Local::now().timestamp_millis();
    if state.sync.offline || cache.usage_checked.is_some_and(|t| now - t < PRS_TTL_MS) {
        return;
    }
    let Some((url, token)) = settings::hub_api(&state.settings) else {
        return;
    };
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        return;
    };
    if SHARING.swap(true, Ordering::SeqCst) {
        return;
    }
    let (push, hashes) = usage_push(mine, &cache.usage_pushed, from);
    let (sync, path) = (state.sync.clone(), path.to_path_buf());
    handle.spawn(async move {
        let pushed = push.is_some();
        let fetched = exchange_usage(&sync, &url, &token, push, from).await;
        if let Err(e) = &fetched {
            eprintln!("insights: hub usage: {e:#}");
        }
        let _ = tokio::task::spawn_blocking(move || {
            let _scan = SCAN
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let mut cache = load_cache(&path);
            // a failure waits for the next window too, rather than retrying on every page load
            cache.usage_checked = Some(Local::now().timestamp_millis());
            if let Ok(usage) = fetched {
                cache.usage = usage;
                if pushed {
                    cache.usage_pushed = hashes;
                }
            }
            save_cache(&path, &mut cache);
        })
        .await;
        SHARING.store(false, Ordering::SeqCst);
    });
}

/// The body to push (days from the first one that changed, appeared or vanished since `pushed`,
/// `None` when nothing did) and each day's hash, to remember once the push lands.
fn usage_push(
    mine: &BTreeMap<Key, Counts>,
    pushed: &BTreeMap<NaiveDate, u64>,
    from: NaiveDate,
) -> (Option<Value>, BTreeMap<NaiveDate, u64>) {
    let mut days: BTreeMap<NaiveDate, Vec<Value>> = BTreeMap::new();
    for ((d, p, r, a, m), c) in mine.iter().filter(|(_, c)| c.prompts + c.tokens > 0) {
        days.entry(*d)
            .or_default()
            .push(json!({"d":d,"p":p,"r":r,"a":a,"m":m,"prompts":c.prompts,"tokens":c.tokens}));
    }
    let hashes: BTreeMap<NaiveDate, u64> = days
        .iter()
        .map(|(d, rows)| {
            let mut hasher = std::hash::DefaultHasher::new();
            std::hash::Hash::hash(&Value::from(rows.clone()).to_string(), &mut hasher);
            (*d, std::hash::Hasher::finish(&hasher))
        })
        .collect();
    let changed = hashes
        .keys()
        .chain(pushed.keys())
        .filter(|d| **d >= from && hashes.get(d) != pushed.get(d))
        .min()
        .copied();
    let body = changed.map(|since| {
        let rows: Vec<&Value> = days.range(since..).flat_map(|(_, rows)| rows).collect();
        json!({"from": since, "rows": rows})
    });
    (body, hashes)
}

async fn exchange_usage(
    sync: &crate::sync::Sync,
    url: &str,
    token: &str,
    push: Option<Value>,
    since: NaiveDate,
) -> Result<Vec<DeviceUsage>> {
    let client = sync.client()?;
    if let Some(body) = push {
        let res = client
            .put(format!("{url}/usage"))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .map_err(reqwest::Error::without_url)?;
        if !res.status().is_success() {
            anyhow::bail!("push answered {}", res.status().as_u16());
        }
    }
    let res = client
        .get(format!("{url}/usage?since={since}"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(reqwest::Error::without_url)?;
    if !res.status().is_success() {
        anyhow::bail!("fetch answered {}", res.status().as_u16());
    }
    Ok(res.json().await.map_err(reqwest::Error::without_url)?)
}

fn local_date(epoch: f64) -> Option<NaiveDate> {
    #[allow(clippy::cast_possible_truncation, reason = "epoch seconds fit in i64")]
    DateTime::from_timestamp(epoch as i64, 0).map(|t| t.with_timezone(&Local).date_naive())
}

fn repo_name(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path)
        .to_owned()
}

/// Worklog entries and closed cards; returns which project each repo and PR repo belongs to.
fn db_rows(db: &mut Db, from: NaiveDate, rows: &mut BTreeMap<Key, Counts>) -> Result<Owners> {
    let since = json!(from.to_string());
    for e in db.query(
        "select extract(epoch from e.at)::float8 t, s.client_id::text p, s.repo_path r, e.agent a, e.model m
           from session_events e join sessions s on s.id = e.session_id
          where not e.deleted and not s.deleted and e.kind in ('track','log') and e.at >= $1::date",
        std::slice::from_ref(&since),
    )? {
        let Some(d) = e["t"].as_f64().and_then(local_date) else {
            continue;
        };
        let project = e["p"].as_str().map(str::to_owned);
        let repo = project
            .is_none()
            .then(|| e["r"].as_str().map(repo_name))
            .flatten();
        let agent = e["a"].as_str().unwrap_or("you").to_owned();
        let model = e["m"].as_str().map(str::to_owned);
        rows.entry((d, project, repo, agent, model)).or_default().entries += 1;
    }
    for s in db.query(
        "select extract(epoch from last_touched)::float8 t, client_id::text p, repo_path r,
                status in (select key from statuses where terminal and not deleted) done,
                coalesce(pr_url, '') <> '' pr
           from sessions where not deleted and last_touched >= $1::date",
        &[since],
    )? {
        let Some(d) = s["t"].as_f64().and_then(local_date) else {
            continue;
        };
        let (done, pr) = (s["done"] == true, s["pr"] == true);
        if !done && !pr {
            continue;
        }
        let project = s["p"].as_str().map(str::to_owned);
        let repo = project
            .is_none()
            .then(|| s["r"].as_str().map(repo_name))
            .flatten();
        let row = rows
            .entry((d, project, repo, "you".into(), None))
            .or_default();
        row.done += u64::from(done);
        row.prs += u64::from(pr);
    }
    let mut owners = Owners::default();
    for s in db.query(
        "select rtrim(repo_path, '/') r, pr_url u, client_id::text p from sessions
          where not deleted and (coalesce(repo_path, '') <> '' or coalesce(pr_url, '') <> '')",
        &[],
    )? {
        let project = s["p"].as_str();
        if let (Some(repo), Some(project)) = (s["r"].as_str().filter(|r| !r.is_empty()), project) {
            owners.repos.push((repo.to_owned(), project.to_owned()));
        }
        // pr_url holds one link per line
        for url in s["u"].as_str().unwrap_or("").lines() {
            let Some(repo) = crate::forge::pr_repo(url) else {
                continue;
            };
            if url.contains("/-/merge_requests/") {
                owners
                    .gitlab_hosts
                    .insert(repo.split('/').next().unwrap_or("").to_owned());
            }
            if let Some(project) = project {
                owners.pr_projects.insert(repo, project.to_owned());
            }
        }
    }
    owners.repos.sort();
    owners.repos.dedup();
    Ok(owners)
}

fn load_cache(path: &Path) -> Cache {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .filter(|c: &Cache| c.version == CACHE_VERSION)
        .unwrap_or_default()
}

fn save_cache(path: &Path, cache: &mut Cache) {
    cache.version = CACHE_VERSION;
    if let Ok(bytes) = serde_json::to_vec(cache) {
        let tmp = path.with_extension("tmp");
        if std::fs::write(&tmp, bytes).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

/// The forges ("github", then GitLab hosts) not asked for merged PRs recently.
fn stale_forges(cache: &Cache, gitlab_hosts: &BTreeSet<String>) -> Vec<String> {
    let now = Local::now().timestamp_millis();
    std::iter::once("github".to_owned())
        .chain(gitlab_hosts.iter().cloned())
        .filter(|f| cache.checked.get(f).is_none_or(|t| now - t >= PRS_TTL_MS))
        .collect()
}

/// Where to resume a forge: a day before its last check (time zones, merges racing it), or `from`.
fn fetch_since(cache: &Cache, forge: &str, from: NaiveDate) -> NaiveDate {
    cache
        .checked
        .get(forge)
        .and_then(|t| DateTime::from_timestamp_millis(*t))
        .map(|t| t.with_timezone(&Local).date_naive() - chrono::Days::new(1))
        .map_or(from, |d| d.max(from))
}

/// Each forge's merged PRs by link; a forge whose CLI fails or is missing is left out, to ask again later.
fn fetch_merged(forges: Vec<(String, NaiveDate)>) -> Vec<(String, BTreeMap<String, MergedPr>)> {
    let today = Local::now().date_naive();
    forges
        .into_iter()
        .filter_map(|(forge, since)| {
            let found = if forge == "github" {
                crate::forge::merged_github(since, today)
            } else {
                crate::forge::merged_gitlab(&forge, since)
            }?;
            let prs = found
                .into_iter()
                .filter_map(|pr| {
                    let day = DateTime::parse_from_rfc3339(&pr.at)
                        .ok()?
                        .with_timezone(&Local)
                        .date_naive();
                    Some((pr.url, MergedPr { day, repo: pr.repo }))
                })
                .collect();
            Some((forge, prs))
        })
        .collect()
}

fn merged_rows(
    cache: &Cache,
    from: NaiveDate,
    pr_projects: &HashMap<String, String>,
    rows: &mut BTreeMap<Key, Counts>,
) {
    for pr in cache.prs.values().filter(|pr| pr.day >= from) {
        let project = pr_projects.get(&pr.repo).cloned();
        let repo = project.is_none().then(|| repo_name(&pr.repo));
        rows.entry((pr.day, project, repo, "you".into(), None))
            .or_default()
            .merged += 1;
    }
}

/// The project whose card repo is the longest prefix of `cwd`.
fn project_of(cwd: &str, repos: &[(String, String)]) -> Option<String> {
    let cwd = cwd.trim_end_matches('/');
    repos
        .iter()
        .filter(|(repo, _)| cwd == repo || cwd.starts_with(&format!("{repo}/")))
        .max_by_key(|(repo, _)| repo.len())
        .map(|(_, project)| project.clone())
}

fn jsonl_files(dir: &Path, depth: u8, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            // headless runs in /tmp are not the user's work, as in the import scan
            let tmp = depth == 0 && entry.file_name().to_string_lossy().starts_with("-tmp-");
            if depth < 4 && !tmp {
                jsonl_files(&path, depth + 1, out);
            }
        } else if path.extension().is_some_and(|e| e == "jsonl") {
            out.push(path);
        }
    }
}

/// Prompts and tokens from the transcripts, parsing only new or changed files; (files, parsed, cache changed).
fn transcript_rows(
    cache: &mut Cache,
    claude: &Path,
    codex: &Path,
    from: NaiveDate,
    repos: &[(String, String)],
    rows: &mut BTreeMap<Key, Counts>,
) -> (usize, usize, bool) {
    let cutoff = from
        .and_hms_opt(0, 0, 0)
        .and_then(|t| t.and_local_timezone(Local).single())
        .map_or(0, |t| u128::try_from(t.timestamp_millis()).unwrap_or(0));
    let mut files = Vec::new();
    for (dir, source) in [(claude, "claude"), (codex, "codex")] {
        let mut found = Vec::new();
        jsonl_files(dir, 0, &mut found);
        files.extend(found.into_iter().map(|p| (p, source)));
    }
    let mut todo = Vec::new();
    let mut keep = HashMap::new();
    for (path, source) in files {
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis());
        if mtime < cutoff {
            continue;
        }
        match cache.files.remove(&path) {
            Some(c) if c.len == meta.len() && c.mtime == mtime => {
                keep.insert(path, c);
            }
            _ => todo.push((path, source, meta.len(), mtime)),
        }
    }
    let parsed = todo.len();
    let next = AtomicUsize::new(0);
    let done = Mutex::new(Vec::new());
    let workers = std::thread::available_parallelism().map_or(4, |n| n.get().min(8));
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                while let Some((path, source, len, mtime)) =
                    todo.get(next.fetch_add(1, Ordering::Relaxed))
                {
                    let Ok(file) = File::open(path) else {
                        continue;
                    };
                    let stats = if *source == "codex" {
                        codex_stats(BufReader::new(file))
                    } else {
                        claude_stats(BufReader::new(file))
                    };
                    let cached = Cached {
                        len: *len,
                        mtime: *mtime,
                        stats,
                    };
                    done.lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .push((path.clone(), cached));
                }
            });
        }
    });
    keep.extend(
        done.into_inner()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
    );
    let total = keep.len();
    for c in keep.values() {
        let s = &c.stats;
        let project = s.cwd.as_deref().and_then(|cwd| project_of(cwd, repos));
        let repo = project
            .is_none()
            .then(|| s.cwd.as_deref().map(repo_name))
            .flatten();
        for (d, n) in s.prompts.range(from..) {
            let key = (*d, project.clone(), repo.clone(), s.source.clone(), None);
            rows.entry(key).or_default().prompts += n;
        }
        for (d, models) in s.tokens.range(from..) {
            for (model, t) in models {
                let key = (
                    *d,
                    project.clone(),
                    repo.clone(),
                    s.source.clone(),
                    Some(model.clone()),
                );
                rows.entry(key).or_default().tokens += t.input + t.output;
            }
        }
    }
    // files left in the old map are gone or out of range
    let changed = parsed > 0 || !cache.files.is_empty();
    cache.files = keep;
    (total, parsed, changed)
}

fn event_date(event: &Value) -> Option<NaiveDate> {
    event["timestamp"]
        .as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.with_timezone(&Local).date_naive())
}

fn count(v: &Value) -> u64 {
    v.as_u64().unwrap_or(0)
}

fn claude_stats(reader: impl BufRead) -> FileStats {
    let mut stats = FileStats {
        source: "claude".into(),
        ..FileStats::default()
    };
    // streamed replies repeat the same message (and usage) on several lines
    let mut seen = HashSet::new();
    for line in reader.lines().map_while(Result::ok) {
        let user = line.contains(r#""type":"user""#);
        if !user && !line.contains(r#""type":"assistant""#)
            || user && line.contains(r#""tool_result""#)
        {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if stats.cwd.is_none() {
            stats.cwd = event["cwd"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
        }
        let Some(d) = event_date(&event) else {
            continue;
        };
        if event["type"] == "user" {
            if event["isSidechain"] != true
                && event["isMeta"] != true
                && transcript::claude_user(&event).is_some()
            {
                *stats.prompts.entry(d).or_default() += 1;
            }
            continue;
        }
        let m = &event["message"];
        if event["type"] != "assistant" || !m["usage"].is_object() {
            continue;
        }
        if let Some(id) = m["id"].as_str()
            && !seen.insert(id.to_owned())
        {
            continue;
        }
        let Some(model) = m["model"].as_str().filter(|s| !s.starts_with('<')) else {
            continue;
        };
        let u = &m["usage"];
        let t = stats
            .tokens
            .entry(d)
            .or_default()
            .entry(model.to_owned())
            .or_default();
        t.input += count(&u["input_tokens"]) + count(&u["cache_creation_input_tokens"]);
        t.output += count(&u["output_tokens"]);
    }
    stats
}

fn codex_stats(reader: impl BufRead) -> FileStats {
    let mut stats = FileStats {
        source: "codex".into(),
        ..FileStats::default()
    };
    let (mut model, mut subagent) = (String::from("codex"), false);
    for line in reader.lines().map_while(Result::ok) {
        if ![
            "session_meta",
            "turn_context",
            "token_count",
            "user_message",
        ]
        .iter()
        .any(|k| line.contains(k))
        {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let p = &event["payload"];
        match (event["type"].as_str(), p["type"].as_str()) {
            (Some("session_meta"), _) => {
                stats.cwd = p["cwd"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned);
                subagent = trame_core::truthy(&p["parent_thread_id"])
                    || p["thread_source"] == "subagent"
                    || p["source"].get("subagent").is_some();
            }
            (Some("turn_context"), _) => {
                if let Some(m) = p["model"].as_str() {
                    m.clone_into(&mut model);
                }
            }
            (Some("event_msg"), Some("token_count")) => {
                let (Some(d), u) = (event_date(&event), &p["info"]["last_token_usage"]) else {
                    continue;
                };
                let t = stats
                    .tokens
                    .entry(d)
                    .or_default()
                    .entry(model.clone())
                    .or_default();
                // input_tokens includes the cached part
                t.input +=
                    count(&u["input_tokens"]).saturating_sub(count(&u["cached_input_tokens"]));
                t.output += count(&u["output_tokens"]);
            }
            (Some("event_msg"), Some("user_message")) if !subagent => {
                if let Some(d) = event_date(&event)
                    && transcript::codex_user(&event).is_some()
                {
                    *stats.prompts.entry(d).or_default() += 1;
                }
            }
            _ => {}
        }
    }
    stats
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(s: &str) -> NaiveDate {
        DateTime::parse_from_rfc3339(s)
            .unwrap()
            .with_timezone(&Local)
            .date_naive()
    }

    #[test]
    fn claude_counts_prompts_and_dedupes_streamed_usage() {
        let ts = "2026-03-02T12:00:00Z";
        let lines = [
            json!({"type":"user","cwd":"/w/acme","timestamp":ts,"message":{"role":"user","content":"fix the login"}}),
            json!({"type":"user","timestamp":ts,"isMeta":true,"message":{"content":"meta"}}),
            json!({"type":"user","timestamp":ts,"isSidechain":true,"message":{"content":"subagent brief"}}),
            json!({"type":"user","timestamp":ts,"message":{"content":[{"type":"tool_result","content":"ok"}]}}),
            json!({"type":"user","timestamp":ts,"message":{"content":"<command-name>/clear</command-name>"}}),
            json!({"type":"assistant","timestamp":ts,"message":{"id":"m1","model":"claude-x","usage":{"input_tokens":10,"cache_creation_input_tokens":5,"output_tokens":7}}}),
            json!({"type":"assistant","timestamp":ts,"message":{"id":"m1","model":"claude-x","usage":{"input_tokens":10,"cache_creation_input_tokens":5,"output_tokens":7}}}),
            json!({"type":"assistant","timestamp":ts,"message":{"id":"m2","model":"<synthetic>","usage":{"input_tokens":1,"output_tokens":1}}}),
        ];
        let text = lines.map(|l| l.to_string()).join("\n");
        let stats = claude_stats(text.as_bytes());
        assert_eq!(stats.cwd.as_deref(), Some("/w/acme"));
        assert_eq!(stats.prompts, BTreeMap::from([(day(ts), 1)]));
        let tokens = BTreeMap::from([(
            "claude-x".to_owned(),
            Tokens {
                input: 15,
                output: 7,
            },
        )]);
        assert_eq!(stats.tokens, BTreeMap::from([(day(ts), tokens)]));
    }

    #[test]
    fn codex_counts_turn_tokens_without_cache_and_skips_subagent_prompts() {
        let ts = "2026-03-02T12:00:00Z";
        let usage = json!({"input_tokens":100,"cached_input_tokens":60,"output_tokens":9});
        let session = |subagent: bool| {
            let meta = if subagent {
                json!({"cwd":"/w/globex","thread_source":"subagent"})
            } else {
                json!({"cwd":"/w/globex"})
            };
            [
                json!({"type":"session_meta","timestamp":ts,"payload":meta}),
                json!({"type":"turn_context","timestamp":ts,"payload":{"model":"gpt-x"}}),
                json!({"type":"event_msg","timestamp":ts,"payload":{"type":"user_message","message":"add tests"}}),
                json!({"type":"event_msg","timestamp":ts,"payload":{"type":"token_count","info":{"last_token_usage":usage}}}),
            ]
            .map(|l| l.to_string())
            .join("\n")
        };
        let main = codex_stats(session(false).as_bytes());
        assert_eq!(main.prompts, BTreeMap::from([(day(ts), 1)]));
        let tokens = BTreeMap::from([(
            "gpt-x".to_owned(),
            Tokens {
                input: 40,
                output: 9,
            },
        )]);
        assert_eq!(main.tokens, BTreeMap::from([(day(ts), tokens.clone())]));
        let sub = codex_stats(session(true).as_bytes());
        assert!(sub.prompts.is_empty());
        assert_eq!(sub.tokens, BTreeMap::from([(day(ts), tokens)]));
    }

    #[test]
    fn project_is_the_longest_matching_repo() {
        let repos = [
            ("/w/acme".to_owned(), "p1".to_owned()),
            ("/w/acme/web".to_owned(), "p2".to_owned()),
        ];
        for (cwd, want) in [
            ("/w/acme", Some("p1")),
            ("/w/acme/api/src", Some("p1")),
            ("/w/acme/web/", Some("p2")),
            ("/w/acme-old", None),
        ] {
            assert_eq!(project_of(cwd, &repos).as_deref(), want, "{cwd}");
        }
    }

    #[test]
    fn usage_push_resends_from_the_first_changed_day() {
        let d = |n: u32| NaiveDate::from_ymd_opt(2026, 10, n).unwrap();
        let counts = |prompts: u64| Counts {
            prompts,
            ..Counts::default()
        };
        let mine = |days: &[(u32, u64)]| -> BTreeMap<Key, Counts> {
            days.iter()
                .map(|(n, p)| {
                    (
                        (d(*n), None, Some("acme".into()), "claude".into(), None),
                        counts(*p),
                    )
                })
                .collect()
        };
        let (_, pushed) = usage_push(&mine(&[(1, 3), (2, 4), (3, 5)]), &BTreeMap::new(), d(1));
        let from = |body: Option<Value>| body.map(|b| b["from"].as_str().unwrap().to_owned());
        for (name, now, want) in [
            ("unchanged", vec![(1, 3), (2, 4), (3, 5)], None),
            (
                "today grew",
                vec![(1, 3), (2, 4), (3, 6)],
                Some("2026-10-03"),
            ),
            (
                "a new day",
                vec![(1, 3), (2, 4), (3, 5), (4, 1)],
                Some("2026-10-04"),
            ),
            ("a day vanished", vec![(1, 3), (3, 5)], Some("2026-10-02")),
        ] {
            assert_eq!(
                from(usage_push(&mine(&now), &pushed, d(1)).0),
                want.map(str::to_owned),
                "{name}"
            );
        }
        // a day before the window no longer counts as vanished
        assert_eq!(
            from(usage_push(&mine(&[(2, 4), (3, 5)]), &pushed, d(2)).0),
            None
        );
    }

    #[test]
    fn hub_usage_rows_parse() {
        // `GET /usage` as hub/api/usage.ts answers it
        let body = r#"[{"node_id":"laptop","d":"2026-10-22","p":null,"r":"globex","a":"codex","m":"gpt-6-sol","prompts":0,"tokens":50000}]"#;
        let rows: Vec<DeviceUsage> = serde_json::from_str(body).unwrap();
        assert_eq!(
            (
                rows[0].d,
                rows[0].r.as_deref(),
                rows[0].m.as_deref(),
                rows[0].tokens
            ),
            (
                NaiveDate::from_ymd_opt(2026, 10, 22).unwrap(),
                Some("globex"),
                Some("gpt-6-sol"),
                50000
            )
        );
    }
}
