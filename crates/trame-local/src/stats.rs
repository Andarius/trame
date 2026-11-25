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
const CACHE_VERSION: u32 = 4;
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
    // cache reads (not in `input`) and cache writes (part of `input`)
    #[serde(default)]
    cached: u64,
    #[serde(default)]
    written: u64,
}

impl Tokens {
    fn add(&mut self, t: &Self) {
        self.input += t.input;
        self.output += t.output;
        self.cached += t.cached;
        self.written += t.written;
    }
}

/// One transcript's activity: prompts per day, tokens per day and model.
#[derive(Default, Serialize, Deserialize, PartialEq, Debug)]
struct FileStats {
    source: String,
    cwd: Option<String>,
    prompts: BTreeMap<NaiveDate, u64>,
    tokens: BTreeMap<NaiveDate, BTreeMap<String, Tokens>>,
    // prompts per day and local hour
    #[serde(default)]
    hours: BTreeMap<NaiveDate, BTreeMap<u8, u64>>,
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
    // when each forge was last tried, failures included
    #[serde(default)]
    attempted: BTreeMap<String, i64>,
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
    // this machine's split of `tokens`, for cost and cache stats
    split: Tokens,
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
    // card repo path → project id, one per repo
    repos: Vec<(String, String)>,
    // PR repo (as `forge::pr_repo`) → project id
    pr_projects: HashMap<String, String>,
    gitlab_hosts: BTreeSet<String>,
    // transcript UUID → card id
    cards: HashMap<String, String>,
    // cards closed in range: id, project, done day, days open
    closed: Vec<Value>,
    // agent time on cards: day, agent, ms
    agent_time: Vec<Value>,
    // agents at work at once: day, peak, ms with two or more
    parallel: Vec<Value>,
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
    let vibe = transcript_dir(&db, "TRACKER_VIBE_DIR", "vibe-sessions")?;
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
    let (files, parsed, changed) = transcript_rows(
        &mut cache,
        [&claude, &codex, &vibe],
        from,
        &owners.repos,
        &mut mine,
    );
    share_usage(state, &cache, &cache_path, from, &mine);
    for (key, c) in mine {
        let row = rows.entry(key).or_default();
        row.prompts += c.prompts;
        row.tokens += c.tokens;
        row.split.add(&c.split);
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
            let _fetching = Reset(&FETCHING);
            let found = fetch_merged(since);
            let _scan = SCAN
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let mut cache = load_cache(&path);
            let now = Local::now().timestamp_millis();
            // a failed forge waits for the next window too, rather than retrying on every page load
            cache.attempted.extend(stale.into_iter().map(|f| (f, now)));
            for (forge, prs) in found {
                cache.prs.extend(prs);
                cache.checked.insert(forge, now);
            }
            cache.prs.retain(|_, pr| pr.day >= from);
            save_cache(&path, &mut cache);
        });
    }
    merged_rows(&cache, from, &owners.pr_projects, &mut rows);
    let cards = card_rows(&cache.files, &owners.cards, from);
    let hours = hour_rows(&cache.files, from);
    if changed {
        save_cache(&cache_path, &mut cache);
    }
    let rows: Vec<Value> = rows
        .into_iter()
        .map(|((d, p, r, a, m), c)| {
            let t = c.split;
            json!({"d":d,"p":p,"r":r,"a":a,"m":m,"prompts":c.prompts,"entries":c.entries,"tokens":c.tokens,"done":c.done,"prs":c.prs,"merged":c.merged,
                   "out":t.output,"cached":t.cached,"written":t.written})
        })
        .collect();
    Ok(json!({
        "today": Local::now().date_naive(),
        "from": from,
        "rows": rows,
        "cards": cards,
        "hours": hours,
        "closed": owners.closed,
        "agent_time": owners.agent_time,
        "parallel": owners.parallel,
        "scan": {"files": files, "parsed": parsed, "ms": started.elapsed().as_millis()},
        "prs": {"pending": FETCHING.load(Ordering::SeqCst), "fetched": !cache.checked.is_empty()},
        "devices": {
            "others": cache.usage.iter().map(|u| &u.node_id).collect::<BTreeSet<_>>().len(),
            "pending": SHARING.load(Ordering::SeqCst),
            "hub": settings::hub_api(&state.settings).is_some() && !state.sync.offline,
        },
    }))
}

/// Clears a busy flag when dropped, so a panicking worker does not leave it set.
struct Reset(&'static AtomicBool);

impl Drop for Reset {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
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

/// Worklog entries, closed cards and cards with a PR; returns which project each repo and PR repo belongs to.
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
                extract(epoch from coalesce(done_at, last_touched))::float8 dt,
                status in (select key from statuses where terminal and not deleted) done,
                coalesce(pr_url, '') <> '' pr
           from sessions where not deleted and (last_touched >= $1::date or done_at >= $1::date)",
        std::slice::from_ref(&since),
    )? {
        let project = s["p"].as_str().map(str::to_owned);
        let repo = project
            .is_none()
            .then(|| s["r"].as_str().map(repo_name))
            .flatten();
        // a card counts as done on the day it was closed, as having a PR on its last activity
        for (flag, at, done) in [("done", "dt", true), ("pr", "t", false)] {
            let day = s[at].as_f64().and_then(local_date).filter(|d| *d >= from);
            if let (true, Some(d)) = (s[flag] == true, day) {
                let key = (d, project.clone(), repo.clone(), "you".into(), None);
                let row = rows.entry(key).or_default();
                row.done += u64::from(done);
                row.prs += u64::from(!done);
            }
        }
    }
    let mut owners = Owners::default();
    let (mut repos, mut pr_repos) = (Votes::new(), Votes::new());
    for s in db.query(
        "select rtrim(repo_path, '/') r, pr_url u, client_id::text p from sessions
          where not deleted and (coalesce(repo_path, '') <> '' or coalesce(pr_url, '') <> '')",
        &[],
    )? {
        let project = s["p"].as_str();
        if let (Some(repo), Some(project)) = (s["r"].as_str().filter(|r| !r.is_empty()), project) {
            vote(&mut repos, repo, project);
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
                vote(&mut pr_repos, &repo, project);
            }
        }
    }
    for s in db.query(
        "select id::text s, claude_id::text c from sessions where not deleted and claude_id is not null",
        &[],
    )? {
        if let (Some(card), Some(id)) = (s["s"].as_str(), s["c"].as_str()) {
            owners.cards.insert(id.to_owned(), card.to_owned());
        }
    }
    owners.closed = closed_cards(db, &since)?;
    (owners.agent_time, owners.parallel) = agent_time(db, &since)?;
    owners.repos = elected(repos).collect();
    owners.pr_projects = elected(pr_repos).collect();
    Ok(owners)
}

// repo → project id → cards
type Votes = HashMap<String, BTreeMap<String, u64>>;

fn vote(votes: &mut Votes, repo: &str, project: &str) {
    *votes
        .entry(repo.to_owned())
        .or_default()
        .entry(project.to_owned())
        .or_default() += 1;
}

/// Each repo's project: the one with the most cards there, the lowest id on a tie.
fn elected(votes: Votes) -> impl Iterator<Item = (String, String)> {
    votes.into_iter().filter_map(|(repo, projects)| {
        let (project, _) = projects.into_iter().rev().max_by_key(|(_, n)| *n)?;
        Some((repo, project))
    })
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

/// The forges ("github", then GitLab hosts) not asked for merged PRs recently, whether or not they answered.
fn stale_forges(cache: &Cache, gitlab_hosts: &BTreeSet<String>) -> Vec<String> {
    let now = Local::now().timestamp_millis();
    std::iter::once("github".to_owned())
        .chain(gitlab_hosts.iter().cloned())
        .filter(|f| {
            let last = cache.checked.get(f).max(cache.attempted.get(f));
            last.is_none_or(|t| now - t >= PRS_TTL_MS)
        })
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
    [claude, codex, vibe]: [&Path; 3],
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
    files.extend(vibe_files(vibe).into_iter().map(|p| (p, "vibe")));
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
                    let stats = match *source {
                        "codex" => codex_stats(BufReader::new(file)),
                        "vibe" => vibe_stats(BufReader::new(file), path),
                        _ => claude_stats(BufReader::new(file)),
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
                let row = rows.entry(key).or_default();
                row.tokens += t.input + t.output;
                row.split.add(t);
            }
        }
    }
    // files left in the old map are gone or out of range
    let changed = parsed > 0 || !cache.files.is_empty();
    cache.files = keep;
    (total, parsed, changed)
}

/// Closed cards with how long they stayed open, from their first worklog event to `done_at`.
fn closed_cards(db: &mut Db, since: &Value) -> Result<Vec<Value>> {
    let rows = db.query(
        "select s.id::text s, s.client_id::text p, extract(epoch from s.done_at)::float8 dt,
                extract(epoch from min(e.at))::float8 st
           from sessions s join session_events e on e.session_id = s.id and not e.deleted
          where not s.deleted and s.done_at >= $1::date
            and s.status in (select key from statuses where terminal and not deleted)
          group by s.id",
        std::slice::from_ref(since),
    )?;
    Ok(rows
        .into_iter()
        .filter_map(|r| {
            let (dt, st) = (r["dt"].as_f64()?, r["st"].as_f64()?);
            let d = local_date(dt)?;
            Some(json!({"s":r["s"],"p":r["p"],"d":d,"days":((dt - st).max(0.0) / 86_400.0)}))
        })
        .collect())
}

// a visit longer than this lost its "left" event
const MAX_VISIT_MS: f64 = 12.0 * 3_600_000.0;

/// Agent time on cards per day and agent, and per day how many agents worked at once.
fn agent_time(db: &mut Db, since: &Value) -> Result<(Vec<Value>, Vec<Value>)> {
    let rows = db.query(
        "select session_id::text s, coalesce(agent_name, agent, '') k, coalesce(agent, 'agent') a,
                extract(epoch from at)::float8 t, summary like 'joined%' joined
           from session_events
          where not deleted and kind = 'presence' and at >= $1::date
          order by at, id",
        std::slice::from_ref(since),
    )?;
    let events = rows.iter().filter_map(|r| {
        Some((
            (r["s"].as_str()?, r["k"].as_str()?),
            r["a"].as_str()?,
            r["t"].as_f64()?,
            r["joined"] == true,
        ))
    });
    let visits = visits(events);
    let time = presence_ms(&visits)
        .into_iter()
        .map(|((d, a), ms)| json!({"d":d,"a":a,"ms":ms}))
        .collect();
    let parallel = parallel(&visits)
        .into_iter()
        .map(|(d, (peak, ms))| json!({"d":d,"peak":peak,"ms":ms}))
        .collect();
    Ok((time, parallel))
}

/// One agent's stay on a card: start and end in epoch seconds, agent.
type Visit = (f64, f64, String);

/// Pairs each join with the next leave of the same (card, agent); `events` must be in time order.
fn visits<'a>(
    events: impl Iterator<Item = ((&'a str, &'a str), &'a str, f64, bool)>,
) -> Vec<Visit> {
    let mut open: HashMap<(&str, &str), f64> = HashMap::new();
    let mut out = Vec::new();
    for (key, agent, t, joined) in events {
        if joined {
            open.entry(key).or_insert(t);
            continue;
        }
        let Some(start) = open.remove(&key) else {
            continue;
        };
        let ms = (t - start) * 1000.0;
        if ms > 0.0 && ms <= MAX_VISIT_MS {
            out.push((start, t, agent_of(agent)));
        }
    }
    out
}

/// Agent time per day (the day a visit started) and agent.
fn presence_ms(visits: &[Visit]) -> BTreeMap<(NaiveDate, String), u64> {
    let mut out: BTreeMap<(NaiveDate, String), u64> = BTreeMap::new();
    for (start, end, agent) in visits {
        if let Some(d) = local_date(*start) {
            *out.entry((d, agent.clone())).or_default() += secs_ms(end - start);
        }
    }
    out
}

/// Per day: the most agents at work at once, and the time two or more were.
fn parallel(visits: &[Visit]) -> BTreeMap<NaiveDate, (u64, u64)> {
    let mut edges: Vec<(f64, i64)> = visits
        .iter()
        .flat_map(|(s, e, _)| [(*s, 1), (*e, -1)])
        .collect();
    // a leave sorts before a join at the same instant, so back-to-back visits don't overlap
    edges.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    let mut out: BTreeMap<NaiveDate, (u64, u64)> = BTreeMap::new();
    let mut running = 0_i64;
    for (i, (t, step)) in edges.iter().enumerate() {
        running += step;
        let Some(d) = local_date(*t) else {
            continue;
        };
        let day = out.entry(d).or_default();
        day.0 = day.0.max(running.unsigned_abs());
        if let (true, Some((next, _))) = (running >= 2, edges.get(i + 1)) {
            day.1 += secs_ms(next - t);
        }
    }
    out.retain(|_, (peak, _)| *peak > 0);
    out
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn secs_ms(secs: f64) -> u64 {
    (secs.max(0.0) * 1000.0) as u64
}

// journal agent ids name harnesses differently
fn agent_of(agent: &str) -> String {
    if agent == "claude-code" {
        "claude".into()
    } else {
        agent.to_owned()
    }
}

/// Prompts per day and local hour, across this machine's transcripts.
fn hour_rows(files: &HashMap<PathBuf, Cached>, from: NaiveDate) -> Vec<Value> {
    let mut by: BTreeMap<(NaiveDate, u8), u64> = BTreeMap::new();
    for c in files.values() {
        for (d, hours) in c.stats.hours.range(from..) {
            for (h, n) in hours {
                *by.entry((*d, *h)).or_default() += n;
            }
        }
    }
    by.into_iter()
        .map(|((d, h), n)| json!({"d":d,"h":h,"n":n}))
        .collect()
}

/// The transcript UUID a file belongs to: its own, or its parent's for a Claude subagent file.
fn transcript_id(path: &Path) -> Option<String> {
    path.ancestors().take(3).find_map(|p| {
        let name = p.file_stem()?.to_str()?;
        let id = name.get(name.len().checked_sub(36)?..)?;
        uuid::Uuid::try_parse(id).ok().map(|u| u.to_string())
    })
}

// tokens, prompts, tokens spent in subagents
type CardTotals = (Tokens, u64, u64);

/// Tokens and prompts per card and day, from the transcripts cards link to.
fn card_rows(
    files: &HashMap<PathBuf, Cached>,
    cards: &HashMap<String, String>,
    from: NaiveDate,
) -> Vec<Value> {
    // prompts sit on the row without a model
    let mut by: BTreeMap<(&str, NaiveDate, Option<&str>), CardTotals> = BTreeMap::new();
    for (path, c) in files {
        let Some(card) = transcript_id(path).and_then(|t| cards.get(&t)) else {
            continue;
        };
        let sub = path
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|n| n == "subagents");
        for (d, n) in c.stats.prompts.range(from..) {
            by.entry((card, *d, None)).or_default().1 += n;
        }
        for (d, models) in c.stats.tokens.range(from..) {
            for (m, t) in models {
                let row = by.entry((card, *d, Some(m))).or_default();
                row.0.add(t);
                if sub {
                    row.2 += t.input + t.output;
                }
            }
        }
    }
    by.into_iter()
        .map(|((s, d, m), (t, prompts, sub))| {
            json!({"s":s,"d":d,"m":m,"tokens":t.input + t.output,"out":t.output,"cached":t.cached,"written":t.written,"prompts":prompts,"sub":sub})
        })
        .collect()
}

fn event_date(event: &Value) -> Option<NaiveDate> {
    event["timestamp"]
        .as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.with_timezone(&Local).date_naive())
}

fn bump_hour(stats: &mut FileStats, event: &Value) {
    let Some(t) = event["timestamp"]
        .as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.with_timezone(&Local))
    else {
        return;
    };
    #[allow(clippy::cast_possible_truncation)]
    let h = chrono::Timelike::hour(&t) as u8;
    *stats
        .hours
        .entry(t.date_naive())
        .or_default()
        .entry(h)
        .or_default() += 1;
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
                bump_hour(&mut stats, &event);
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
        let written = count(&u["cache_creation_input_tokens"]);
        t.input += count(&u["input_tokens"]) + written;
        t.written += written;
        t.cached += count(&u["cache_read_input_tokens"]);
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
                let cached = count(&u["cached_input_tokens"]);
                t.input += count(&u["input_tokens"]).saturating_sub(cached);
                t.cached += cached;
                t.output += count(&u["output_tokens"]);
            }
            (Some("event_msg"), Some("user_message")) if !subagent => {
                if let Some(d) = event_date(&event)
                    && transcript::codex_user(&event).is_some()
                {
                    *stats.prompts.entry(d).or_default() += 1;
                    bump_hour(&mut stats, &event);
                }
            }
            _ => {}
        }
    }
    stats
}

/// Mistral Vibe keeps one folder per session: its `meta.json` (totals, model, folder) beside `messages.jsonl`.
fn vibe_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("session_"))
        .map(|e| e.path().join("meta.json"))
        .filter(|p| p.is_file())
        .collect()
}

/// A Vibe session's prompts and tokens, all on the day it started (its messages carry no time).
fn vibe_stats(reader: impl BufRead, meta_path: &Path) -> FileStats {
    let mut stats = FileStats {
        source: "vibe".into(),
        ..FileStats::default()
    };
    let Ok(meta) = serde_json::from_reader::<_, Value>(reader) else {
        return stats;
    };
    let Some(day) = meta["start_time"]
        .as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.with_timezone(&Local).date_naive())
    else {
        return stats;
    };
    stats.cwd = meta["environment"]["working_directory"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let model = meta["config"]["active_model"].as_str().unwrap_or("vibe");
    let s = &meta["stats"];
    let t = Tokens {
        // prompt tokens include the cached part
        input: count(&s["session_prompt_tokens"])
            .saturating_sub(count(&s["session_cached_tokens"])),
        output: count(&s["session_completion_tokens"]),
        cached: count(&s["session_cached_tokens"]),
        written: 0,
    };
    if t.input + t.output > 0 {
        stats
            .tokens
            .entry(day)
            .or_default()
            .insert(model.to_owned(), t);
    }
    // a child session's prompts come from its parent, as with Codex subagents
    if meta["parent_session_id"].is_null()
        && let Ok(file) = File::open(meta_path.with_file_name("messages.jsonl"))
    {
        let prompts = BufReader::new(file)
            .lines()
            .map_while(Result::ok)
            .filter_map(|l| serde_json::from_str::<Value>(&l).ok())
            .filter(|m| m["role"] == "user" && m["injected"] != true)
            .count() as u64;
        if prompts > 0 {
            stats.prompts.insert(day, prompts);
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
            json!({"type":"assistant","timestamp":ts,"message":{"id":"m1","model":"claude-x","usage":{"input_tokens":10,"cache_creation_input_tokens":5,"cache_read_input_tokens":30,"output_tokens":7}}}),
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
                cached: 30,
                written: 5,
            },
        )]);
        assert_eq!(stats.tokens, BTreeMap::from([(day(ts), tokens)]));
        let hour = chrono::Timelike::hour(
            &DateTime::parse_from_rfc3339(ts)
                .unwrap()
                .with_timezone(&Local),
        );
        assert_eq!(
            stats.hours[&day(ts)],
            BTreeMap::from([(u8::try_from(hour).unwrap(), 1)])
        );
    }

    #[test]
    fn vibe_counts_session_tokens_without_cache_and_skips_child_prompts() {
        let dir = std::env::temp_dir().join(format!("trame-vibe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let messages = [
            json!({"role":"user","content":"review this"}),
            json!({"role":"user","content":"ctx","injected":true}),
            json!({"role":"assistant","content":"ok"}),
            json!({"role":"user","content":"and that"}),
        ];
        std::fs::write(
            dir.join("messages.jsonl"),
            messages
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        let meta = |parent: Value| {
            json!({
                "start_time":"2026-11-12T16:54:29+00:00",
                "parent_session_id":parent,
                "environment":{"working_directory":"/w/globex"},
                "config":{"active_model":"mistral-large-4"},
                "stats":{"session_prompt_tokens":1000,"session_cached_tokens":800,"session_completion_tokens":50},
            })
        };
        let d = day("2026-11-12T16:54:29+00:00");
        for (parent, prompts) in [(Value::Null, Some(2)), (json!("p-1"), None)] {
            let s = vibe_stats(meta(parent).to_string().as_bytes(), &dir.join("meta.json"));
            assert_eq!(s.source, "vibe");
            assert_eq!(s.cwd.as_deref(), Some("/w/globex"));
            assert_eq!(
                s.tokens[&d]["mistral-large-4"],
                Tokens {
                    input: 200,
                    output: 50,
                    cached: 800,
                    written: 0,
                }
            );
            assert_eq!(s.prompts.get(&d).copied(), prompts);
        }
        std::fs::remove_dir_all(&dir).unwrap();
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
                cached: 60,
                written: 0,
            },
        )]);
        assert_eq!(main.tokens, BTreeMap::from([(day(ts), tokens.clone())]));
        let sub = codex_stats(session(true).as_bytes());
        assert!(sub.prompts.is_empty());
        assert_eq!(sub.tokens, BTreeMap::from([(day(ts), tokens)]));
    }

    #[test]
    fn card_rows_sum_a_cards_transcripts_and_subagents_in_range() {
        let date = |d: &str| NaiveDate::parse_from_str(d, "%Y-%m-%d").unwrap();
        let claude = "053f0800-8e71-472d-b5db-19b7493f486c";
        let codex = "01a1f85e-01bf-7981-808a-d0c34df2f15e";
        let file = |d: &str, input: u64, prompts: u64| Cached {
            len: 0,
            mtime: 0,
            stats: FileStats {
                prompts: BTreeMap::from([(date(d), prompts)]),
                tokens: BTreeMap::from([(
                    date(d),
                    BTreeMap::from([(
                        "m".to_owned(),
                        Tokens {
                            input,
                            output: 1,
                            cached: 2,
                            written: 0,
                        },
                    )]),
                )]),
                ..FileStats::default()
            },
        };
        let files = HashMap::from([
            (
                PathBuf::from(format!("/c/-w-acme/{claude}.jsonl")),
                file("2026-05-02", 9, 2),
            ),
            (
                PathBuf::from(format!("/c/-w-acme/{claude}/subagents/agent-a1.jsonl")),
                file("2026-05-02", 4, 0),
            ),
            (
                PathBuf::from(format!(
                    "/x/2026/05/01/rollout-2026-05-01T10-00-00-{codex}.jsonl"
                )),
                file("2026-05-01", 19, 1),
            ),
            // before the range, and a transcript no card links
            (
                PathBuf::from(format!("/c/-w-acme/{claude}/subagents/agent-old.jsonl")),
                file("2025-01-01", 99, 0),
            ),
            (
                PathBuf::from("/c/-w-acme/9b2d6c1e-0000-4000-8000-000000000000.jsonl"),
                file("2026-05-02", 99, 9),
            ),
        ]);
        let cards = HashMap::from([
            (claude.to_owned(), "card-a".to_owned()),
            (codex.to_owned(), "card-b".to_owned()),
        ]);
        let rows = card_rows(&files, &cards, date("2026-01-01"));
        assert_eq!(
            rows,
            vec![
                json!({"s":"card-a","d":"2026-05-02","m":null,"tokens":0,"out":0,"cached":0,"written":0,"prompts":2,"sub":0}),
                // the subagent's 4 + 1 tokens
                json!({"s":"card-a","d":"2026-05-02","m":"m","tokens":15,"out":2,"cached":4,"written":0,"prompts":0,"sub":5}),
                json!({"s":"card-b","d":"2026-05-01","m":null,"tokens":0,"out":0,"cached":0,"written":0,"prompts":1,"sub":0}),
                json!({"s":"card-b","d":"2026-05-01","m":"m","tokens":20,"out":1,"cached":2,"written":0,"prompts":0,"sub":0}),
            ]
        );
    }

    #[test]
    fn presence_pairs_joins_with_leaves_per_card_and_agent() {
        let t0 = 1_777_716_000.0; // 2026-05-02T10:00:00Z
        let (a, b) = (("c1", "ju"), ("c2", "ju"));
        let events = [
            (a, "claude-code", t0, true),
            (a, "claude-code", t0 + 60.0, true), // a second join keeps the first start
            (b, "codex", t0 + 10.0, true),
            (a, "claude-code", t0 + 600.0, false),
            (b, "codex", t0 + 13.0 * 3600.0, false), // over the cap: lost its leave
            (a, "claude-code", t0 + 700.0, false),   // a leave without a join
        ];
        let d = day("2026-05-02T10:00:00Z");
        assert_eq!(
            presence_ms(&visits(events.into_iter())),
            BTreeMap::from([((d, "claude".to_owned()), 600_000)])
        );
    }

    #[test]
    fn parallel_counts_overlapping_visits() {
        let t0 = 1_777_716_000.0; // 2026-05-02T10:00:00Z
        let visit = |s: f64, e: f64| (t0 + s, t0 + e, "claude".to_owned());
        // three overlap on 100..200, two on 50..100 and 200..300; the last starts as one ends
        let visits = [
            visit(0.0, 300.0),
            visit(50.0, 200.0),
            visit(100.0, 400.0),
            visit(400.0, 500.0),
        ];
        let d = day("2026-05-02T10:00:00Z");
        assert_eq!(parallel(&visits), BTreeMap::from([(d, (3, 250_000))]));
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
    fn a_shared_repo_goes_to_the_project_with_most_cards() {
        let mut votes = Votes::new();
        for (repo, project) in [
            ("/w/acme", "p2"),
            ("/w/acme", "p1"),
            ("/w/acme", "p2"),
            ("/w/tie", "p2"),
            ("/w/tie", "p1"),
        ] {
            vote(&mut votes, repo, project);
        }
        let owners: BTreeMap<_, _> = elected(votes).collect();
        let want = [("/w/acme", "p2"), ("/w/tie", "p1")].map(|(r, p)| (r.to_owned(), p.to_owned()));
        assert_eq!(owners, BTreeMap::from(want));
    }

    #[test]
    fn a_failed_forge_waits_for_the_next_window() {
        let now = Local::now().timestamp_millis();
        let hosts = BTreeSet::from(["gitlab.example.com".to_owned()]);
        for (name, checked, attempted, want) in [
            (
                "never asked",
                None,
                None,
                vec!["github", "gitlab.example.com"],
            ),
            ("just failed", None, Some(now), vec![]),
            (
                "failed a window ago",
                None,
                Some(now - PRS_TTL_MS),
                vec!["github", "gitlab.example.com"],
            ),
            (
                "answered, then failed",
                Some(now - PRS_TTL_MS),
                Some(now),
                vec![],
            ),
            ("just answered", Some(now), None, vec![]),
        ] {
            let mut cache = Cache::default();
            for forge in ["github", "gitlab.example.com"] {
                cache.checked.extend(checked.map(|t| (forge.to_owned(), t)));
                cache
                    .attempted
                    .extend(attempted.map(|t| (forge.to_owned(), t)));
            }
            assert_eq!(stale_forges(&cache, &hosts), want, "{name}");
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
