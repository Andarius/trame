// Usage stats for the Insights view: worklog and cards from the DB, prompts and tokens from agent transcripts.
use crate::{
    db::Db,
    imports::{transcript, transcript_dir},
    routes::{Native, json_response},
};
use anyhow::Result;
use axum::response::Response;
use chrono::{DateTime, Local, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::File,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Instant, UNIX_EPOCH},
};

const DAYS: i64 = 366;
const CACHE: &str = "stats-cache.json";
const CACHE_VERSION: u32 = 1;
static SCAN: Mutex<()> = Mutex::new(());

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

#[derive(Serialize, Deserialize, Default)]
struct Cache {
    version: u32,
    files: HashMap<PathBuf, Cached>,
}

#[derive(Default)]
struct Counts {
    prompts: u64,
    entries: u64,
    tokens: u64,
    done: u64,
    prs: u64,
}

// date, project id, repo name (when no project), agent, model
type Key = (
    NaiveDate,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
);

// card repo path → project id
type Repos = Vec<(String, String)>;

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
    let repos = db_rows(&mut db, from, &mut rows)?;
    drop(db);
    let (files, parsed) = {
        let _scan = SCAN
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        transcript_rows(
            &state.root.join(CACHE),
            &claude,
            &codex,
            from,
            &repos,
            &mut rows,
        )
    };
    let rows: Vec<Value> = rows
        .into_iter()
        .map(|((d, p, r, a, m), c)| {
            json!({"d":d,"p":p,"r":r,"a":a,"m":m,"prompts":c.prompts,"entries":c.entries,"tokens":c.tokens,"done":c.done,"prs":c.prs})
        })
        .collect();
    Ok(json!({
        "today": Local::now().date_naive(),
        "rows": rows,
        "scan": {"files": files, "parsed": parsed, "ms": started.elapsed().as_millis()},
    }))
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

/// Worklog entries and closed cards; returns each card repo's project.
fn db_rows(db: &mut Db, from: NaiveDate, rows: &mut BTreeMap<Key, Counts>) -> Result<Repos> {
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
    let repos = db
        .query(
            "select distinct rtrim(repo_path, '/') r, client_id::text p from sessions
              where not deleted and coalesce(repo_path, '') <> '' and client_id is not null",
            &[],
        )?
        .iter()
        .filter_map(|r| Some((r["r"].as_str()?.to_owned(), r["p"].as_str()?.to_owned())))
        .collect();
    Ok(repos)
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

fn transcript_rows(
    cache_path: &Path,
    claude: &Path,
    codex: &Path,
    from: NaiveDate,
    repos: &[(String, String)],
    rows: &mut BTreeMap<Key, Counts>,
) -> (usize, usize) {
    let mut cache: Cache = std::fs::read(cache_path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .filter(|c: &Cache| c.version == CACHE_VERSION)
        .unwrap_or_default();
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
    if parsed > 0 || total != cache.files.len() {
        let cache = Cache {
            version: CACHE_VERSION,
            files: keep,
        };
        if let Ok(bytes) = serde_json::to_vec(&cache) {
            let tmp = cache_path.with_extension("tmp");
            if std::fs::write(&tmp, bytes).is_ok() {
                let _ = std::fs::rename(&tmp, cache_path);
            }
        }
    }
    (total, parsed)
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
}
