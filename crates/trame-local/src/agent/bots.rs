//! Bots: named agent setups (provider, folder, mode) that Slack, a hook or the app start runs from.
//! Stored in `agent_bots`, a table of this machine's database that is not synced.

use anyhow::Result;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};

use super::run::{Provider, Run, valid_choice};
use super::{MODES, claude::Launch};
use crate::db::Db;

/// Live runs a bot may have at once; a trigger beyond it is refused, not queued.
const MAX_LIVE: usize = 4;
const MAX_BOTS: i64 = 64;
const COLUMNS: &str = "id, name, provider, cwd, mode, model, effort, slack, hook, role, face, hue,
    exists (select 1 from agent_bot_images i where i.bot_id = agent_bots.id) as has_image";
const FACES: &[&str] = &["f1", "f2", "f3", "f4"];
/// Largest avatar an upload may be.
pub(crate) const MAX_IMAGE: usize = 256 << 10;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Bot {
    pub id: String,
    pub name: String,
    pub provider: Provider,
    pub cwd: PathBuf,
    pub mode: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// offered to Slack mentions
    pub slack: bool,
    /// the secret a hook presents to start a run
    pub hook: String,
    pub role: Option<String>,
    pub face: Option<String>,
    pub hue: Option<i64>,
    pub has_image: bool,
}

impl Bot {
    /// What the app shows; the hook secret only through its own route.
    pub(crate) fn summary(&self, (live, working): (usize, usize)) -> Value {
        json!({
            "id":self.id,"name":self.name,"provider":self.provider.name(),"cwd":self.cwd,
            "mode":self.mode,"model":self.model,"effort":self.effort,"slack":self.slack,"live":live,"working":working,
            "role":self.role,"face":self.face,"hue":self.hue.unwrap_or_else(|| name_hue(&self.name)),
            "hasImage":self.has_image,
        })
    }

    fn from_row(r: &Value) -> Option<Self> {
        let text = |k: &str| r[k].as_str().map(str::to_owned);
        Some(Self {
            id: text("id")?,
            name: text("name")?,
            provider: Provider::parse(r["provider"].as_str()?)?,
            cwd: PathBuf::from(r["cwd"].as_str()?),
            mode: text("mode"),
            model: text("model"),
            effort: text("effort"),
            slack: r["slack"] == true,
            hook: text("hook")?,
            role: text("role"),
            face: text("face"),
            hue: r["hue"].as_i64(),
            has_image: r["has_image"] == true,
        })
    }

    pub(crate) fn launch(&self) -> Launch {
        Launch {
            mode: self.mode.clone(),
            model: self.model.clone(),
            effort: self.effort.clone(),
        }
    }
}

/// A bot's name is how Slack and the relay address it: `[a-z0-9-]`, up to 32, starting alphanumeric.
pub(crate) fn valid_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    let first = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    name.len() <= 32 && bytes.next().is_some_and(first) && bytes.all(|c| first(c) || c == b'-')
}

/// A hue for a bot that has none: a stable hash of its name, 0–359.
pub(crate) fn name_hue(name: &str) -> i64 {
    // FNV-1a, stable across builds and platforms
    let hash = name.bytes().fold(0x811c_9dc5_u32, |h, b| {
        (h ^ u32::from(b)).wrapping_mul(0x0100_0193)
    });
    i64::from(hash % 360)
}

pub(crate) fn valid_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok()
}

fn new_secret() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

pub(crate) fn list(db: &mut Db) -> Result<Vec<Bot>> {
    let rows = db.query(
        &format!("select {COLUMNS} from agent_bots order by name"),
        &[],
    )?;
    Ok(rows.iter().filter_map(Bot::from_row).collect())
}

pub(crate) fn get(db: &mut Db, id: &str) -> Result<Option<Bot>> {
    if !valid_id(id) {
        return Ok(None);
    }
    let rows = db.query(
        &format!("select {COLUMNS} from agent_bots where id = $1::uuid"),
        &[json!(id)],
    )?;
    Ok(rows.first().and_then(Bot::from_row))
}

/// Why a create or update was refused: the user's mistake, or the database's.
#[derive(Debug)]
pub(crate) enum Refused {
    Missing,
    Invalid(String),
    Db(anyhow::Error),
}

impl From<anyhow::Error> for Refused {
    fn from(e: anyhow::Error) -> Self {
        Self::Db(e)
    }
}

/// Create (`id` None) or update a bot from the app's
/// `{name, provider, cwd, mode, model, effort, slack, role, face, hue}`;
/// an update keeps the fields the body leaves out.
pub(crate) fn upsert(db: &mut Db, id: Option<&str>, body: &Value) -> Result<Bot, Refused> {
    let invalid = |m: &str| Refused::Invalid(m.to_owned());
    let current = match id {
        Some(id) => Some(get(db, id)?.ok_or(Refused::Missing)?),
        None => None,
    };
    let field = |k: &str| body.get(k).filter(|v| !v.is_null());
    let name = match field("name") {
        Some(v) => v.as_str().filter(|n| valid_name(n)).ok_or_else(|| {
            invalid("a name is lowercase letters, digits and dashes, up to 32 characters")
        })?,
        None => current
            .as_ref()
            .map(|b| b.name.as_str())
            .ok_or_else(|| invalid("a name is required"))?,
    }
    .to_owned();
    let provider = match field("provider") {
        Some(v) => v
            .as_str()
            .and_then(Provider::parse)
            .ok_or_else(|| invalid("unknown provider"))?,
        None => current.as_ref().map_or(Provider::Claude, |b| b.provider),
    };
    let cwd = match field("cwd") {
        Some(v) => PathBuf::from(v.as_str().unwrap_or_default()),
        None => current
            .as_ref()
            .map(|b| b.cwd.clone())
            .ok_or_else(|| invalid("a folder is required"))?,
    };
    if !cwd.is_absolute() || !cwd.is_dir() {
        return Err(invalid("the folder must be an existing absolute directory"));
    }
    // `""` or null clears an optional choice
    let choice = |k: &str, kept: Option<&String>| -> Result<Option<String>, Refused> {
        match body.get(k) {
            None => Ok(kept.cloned()),
            Some(Value::Null) => Ok(None),
            Some(Value::String(s)) if s.is_empty() => Ok(None),
            Some(Value::String(s)) if valid_choice(s) => Ok(Some(s.clone())),
            Some(_) => Err(Refused::Invalid(format!("invalid {k}"))),
        }
    };
    let mut mode = choice("mode", current.as_ref().and_then(|b| b.mode.as_ref()))?;
    if provider == Provider::Codex {
        mode = None;
    } else if mode.as_deref().is_some_and(|m| !MODES.contains(&m)) {
        return Err(invalid("unknown permission mode"));
    } else if mode.is_none() && current.is_none() {
        mode = Some("auto".into());
    }
    let model = choice("model", current.as_ref().and_then(|b| b.model.as_ref()))?;
    let effort = choice("effort", current.as_ref().and_then(|b| b.effort.as_ref()))?;
    let slack = field("slack").map_or(current.as_ref().is_some_and(|b| b.slack), |v| v == true);
    let role = match body.get("role") {
        None => current.as_ref().and_then(|b| b.role.clone()),
        Some(Value::Null) => None,
        Some(Value::String(s)) if !s.contains(['\n', '\r']) && s.trim().chars().count() <= 120 => {
            Some(s.trim().to_owned()).filter(|s| !s.is_empty())
        }
        Some(_) => return Err(invalid("a role is one line, up to 120 characters")),
    };
    let face = match body.get("face") {
        None => current.as_ref().and_then(|b| b.face.clone()),
        Some(Value::Null) => None,
        Some(Value::String(s)) if FACES.contains(&s.as_str()) => Some(s.clone()),
        Some(_) => return Err(invalid("a face is f1, f2, f3 or f4")),
    };
    let hue = match body.get("hue") {
        None => current.as_ref().and_then(|b| b.hue),
        Some(Value::Null) => None,
        Some(v) => Some(
            v.as_i64()
                .filter(|h| (0..360).contains(h))
                .ok_or_else(|| invalid("a hue is a whole number from 0 to 359"))?,
        ),
    };
    let taken = db.query(
        "select 1 from agent_bots where name = $1 and id::text is distinct from $2",
        &[json!(name), json!(current.as_ref().map(|b| &b.id))],
    )?;
    if !taken.is_empty() {
        return Err(Refused::Invalid(format!("a bot is already named {name}")));
    }
    let values = [
        json!(name),
        json!(provider.name()),
        json!(cwd),
        json!(mode),
        json!(model),
        json!(effort),
        json!(slack),
        json!(role),
        json!(face),
        json!(hue),
    ];
    let rows = if let Some(bot) = &current {
        db.query(
            &format!(
                "update agent_bots set name = $1, provider = $2, cwd = $3, mode = $4, model = $5,
                        effort = $6, slack = $7, role = $8, face = $9, hue = $10::int
                  where id = $11::uuid returning {COLUMNS}"
            ),
            &[values.as_slice(), &[json!(bot.id)]].concat(),
        )?
    } else {
        let count = db.query("select count(*) as n from agent_bots", &[])?;
        if count
            .first()
            .and_then(|r| r["n"].as_i64())
            .unwrap_or_default()
            >= MAX_BOTS
        {
            return Err(invalid("too many bots"));
        }
        db.query(
            &format!(
                "insert into agent_bots (name, provider, cwd, mode, model, effort, slack, role, face, hue, hook)
                     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::int, $11) returning {COLUMNS}"
            ),
            &[values.as_slice(), &[json!(new_secret())]].concat(),
        )?
    };
    rows.first().and_then(Bot::from_row).ok_or(Refused::Missing)
}

pub(crate) fn remove(db: &mut Db, id: &str) -> Result<bool> {
    if !valid_id(id) {
        return Ok(false);
    }
    let rows = db.query(
        "delete from agent_bots where id = $1::uuid returning id",
        &[json!(id)],
    )?;
    Ok(!rows.is_empty())
}

/// A new hook secret; the old one stops working at once.
pub(crate) fn rotate_hook(db: &mut Db, id: &str) -> Result<Option<String>> {
    if !valid_id(id) {
        return Ok(None);
    }
    let rows = db.query(
        "update agent_bots set hook = $1 where id = $2::uuid returning hook",
        &[json!(new_secret()), json!(id)],
    )?;
    Ok(rows
        .first()
        .and_then(|r| r["hook"].as_str())
        .map(str::to_owned))
}

pub(crate) fn offered_to_slack(db: &mut Db) -> Result<Vec<Bot>> {
    Ok(list(db)?.into_iter().filter(|b| b.slack).collect())
}

/// The Slack bot name a mention is for and its task: `name: task` names one, else the only one offered.
/// A prefix that is no offered bot's name stays part of the task.
pub(crate) fn route(offered: &[String], text: &str) -> Result<(String, String), String> {
    let (name, task) = addressed(text);
    if let Some(bot) = name.and_then(|n| offered.iter().find(|b| *b == n)) {
        return Ok((bot.clone(), task.to_owned()));
    }
    let mut names: Vec<&str> = offered.iter().map(String::as_str).collect();
    names.sort_unstable();
    match offered {
        [] => Err("No bot is offered to Slack.".into()),
        [bot] => Ok((bot.clone(), text.trim().to_owned())),
        _ => Err(format!(
            "Start with a bot's name, as in `{}: your task`. Bots here: {}.",
            names[0],
            names.join(", ")
        )),
    }
}

/// Split `name: task` when `name` could be a bot; otherwise the whole text is the task.
fn addressed(text: &str) -> (Option<&str>, &str) {
    match text.split_once(':') {
        Some((name, rest)) if valid_name(name.trim()) && !rest.trim().is_empty() => {
            (Some(name.trim()), rest.trim())
        }
        _ => (None, text.trim()),
    }
}

/// Start a fresh run for `bot` and hand it `text` from `from`; `sender` keys the inbox rate limit.
pub(crate) fn start(
    bot: &Bot,
    from: &str,
    text: &str,
    sender: &str,
) -> Result<Arc<Run>, &'static str> {
    if text.trim().is_empty() || text.len() > 64 << 10 {
        return Err("text required, up to 64 KiB");
    }
    if !bot.cwd.is_dir() {
        return Err("the bot's folder no longer exists");
    }
    if super::bot_live(&bot.id) >= MAX_LIVE {
        return Err("this bot already has as many runs as it may");
    }
    let run = super::launch_run(
        bot.cwd.clone(),
        bot.provider,
        None,
        bot.launch(),
        Vec::new(),
    )
    .map_err(|_| "could not start the agent")?;
    run.set_bot(Some(&bot.id));
    run.deliver(from, text, Some(sender))?;
    super::save();
    let summary: String = text.trim().chars().take(200).collect();
    super::record(
        "insert into agent_bot_runs (run_id, bot_id, source, requester, summary)
         select $1, id, $3, $4, $5 from agent_bots where id = $2::uuid
         on conflict (run_id) do nothing",
        vec![
            json!(run.id),
            json!(bot.id),
            json!(sender),
            json!(from),
            json!(summary),
        ],
    );
    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
        let run = run.clone();
        runtime.spawn(async move {
            let outcome = super::runner::first_turn(&run).await;
            super::record(
                "update agent_bot_runs set ended_at = now(), outcome = $2
                  where run_id = $1 and outcome is null",
                vec![json!(run.id), json!(outcome)],
            );
        });
    }
    Ok(run)
}

/// Bot `id`'s latest `limit` runs, newest first, as the bot page lists them.
pub(crate) fn history(db: &mut Db, id: &str, limit: i64) -> Result<Vec<Value>> {
    db.query(
        r#"select run_id as id, source, summary, requester, started_at as "startedAt",
                  ended_at as "endedAt", outcome
             from agent_bot_runs where bot_id = $1::uuid
            order by started_at desc, run_id desc limit $2::int"#,
        &[json!(id), json!(limit)],
    )
}

/// Per bot (every bot, or only `bot`): run counts over the last `days` local dates, each day
/// zero-filled, oldest first. Dates follow the database's time zone.
pub(crate) fn stats(db: &mut Db, bot: Option<&str>, days: i64) -> Result<Vec<Value>> {
    let params = [json!(days), json!(bot)];
    let totals = db.query(
        "select b.id::text as bot, count(r.run_id) as runs,
                  count(r.run_id) filter (where r.outcome = 'success') as success,
                  count(r.run_id) filter (where r.outcome = 'error') as error,
                  count(r.run_id) filter (where r.outcome = 'interrupted') as interrupted,
                  count(r.run_id) filter (where r.source = 'slack') as slack,
                  count(r.run_id) filter (where r.source = 'hook') as hook,
                  count(r.run_id) filter (where r.source = 'app') as app,
                  count(r.run_id) filter (where r.source = 'relay') as relay,
                  round(percentile_cont(0.5) within group
                        (order by extract(epoch from r.ended_at - r.started_at)::float8)
                        filter (where r.ended_at is not null))::bigint as median,
                  (select max(l.started_at) from agent_bot_runs l where l.bot_id = b.id) as last
             from agent_bots b
             left join agent_bot_runs r
               on r.bot_id = b.id and r.started_at >= (current_date - ($1::int - 1))::timestamptz
            where $2::uuid is null or b.id = $2::uuid
            group by b.id order by b.name",
        &params,
    )?;
    let daily = db.query(
        "select b.id::text as bot, d::date::text as day, count(r.run_id) as runs,
                count(r.run_id) filter (where r.outcome = 'error') as failed
           from agent_bots b
          cross join generate_series(current_date - ($1::int - 1), current_date, interval '1 day') d
           left join agent_bot_runs r on r.bot_id = b.id and r.started_at::date = d::date
          where $2::uuid is null or b.id = $2::uuid
          group by b.id, d order by d",
        &params,
    )?;
    Ok(totals
        .iter()
        .map(|t| {
            let n = |k: &str| t[k].as_i64().unwrap_or_default();
            let days: Vec<Value> = daily
                .iter()
                .filter(|d| d["bot"] == t["bot"])
                .map(|d| json!({"day":d["day"],"runs":d["runs"],"failed":d["failed"]}))
                .collect();
            json!({
                "bot":t["bot"],"runs":n("runs"),"success":n("success"),"error":n("error"),
                "interrupted":n("interrupted"),"medianSeconds":t["median"],"daily":days,
                "sources":{"slack":n("slack"),"hook":n("hook"),"app":n("app"),"relay":n("relay")},
                "lastStartedAt":t["last"],
            })
        })
        .collect())
}

/// The image type `bytes` hold, when it is one an avatar may be.
pub(crate) fn image_type(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, ..] => Some("image/png"),
        [0xff, 0xd8, 0xff, ..] => Some("image/jpeg"),
        [
            b'R',
            b'I',
            b'F',
            b'F',
            _,
            _,
            _,
            _,
            b'W',
            b'E',
            b'B',
            b'P',
            ..,
        ] => Some("image/webp"),
        _ => None,
    }
}

/// Store bot `id`'s avatar; false when there is no such bot.
pub(crate) fn set_image(db: &mut Db, id: &str, kind: &str, bytes: &[u8]) -> Result<bool> {
    if !valid_id(id) {
        return Ok(false);
    }
    let rows = db.query(
        "insert into agent_bot_images (bot_id, content_type, bytes)
         select id, $2, decode($3, 'base64') from agent_bots where id = $1::uuid
         on conflict (bot_id) do update set content_type = excluded.content_type, bytes = excluded.bytes
         returning bot_id",
        &[json!(id), json!(kind), json!(STANDARD.encode(bytes))],
    )?;
    Ok(!rows.is_empty())
}

/// Bot `id`'s avatar and its content type.
pub(crate) fn image(db: &mut Db, id: &str) -> Result<Option<(String, Vec<u8>)>> {
    if !valid_id(id) {
        return Ok(None);
    }
    let rows = db.query(
        "select content_type, translate(encode(bytes, 'base64'), E'\n', '') as data
           from agent_bot_images where bot_id = $1::uuid",
        &[json!(id)],
    )?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    let kind = row["content_type"].as_str().unwrap_or_default().to_owned();
    Ok(Some((
        kind,
        STANDARD.decode(row["data"].as_str().unwrap_or_default())?,
    )))
}

/// Remove bot `id`'s avatar; false when there is no such bot.
pub(crate) fn remove_image(db: &mut Db, id: &str) -> Result<bool> {
    if get(db, id)?.is_none() {
        return Ok(false);
    }
    db.query(
        "delete from agent_bot_images where bot_id = $1::uuid",
        &[json!(id)],
    )?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_task_names_its_bot_before_a_colon_or_not_at_all() {
        for (text, want) in [
            ("trame: fix the test", (Some("trame"), "fix the test")),
            ("  web-2 :  deploy ", (Some("web-2"), "deploy")),
            ("fix this: it breaks", (None, "fix this: it breaks")),
            ("Trame: up", (None, "Trame: up")),
            ("trame:", (None, "trame:")),
            ("summarize the README", (None, "summarize the README")),
        ] {
            assert_eq!(addressed(text), want, "{text}");
        }
    }

    #[test]
    fn a_mention_reaches_the_named_bot_or_the_only_one() {
        let one = ["trame".to_owned()];
        let two = ["trame".to_owned(), "web".to_owned()];
        let routed = route;
        assert_eq!(
            routed(&two, "web: deploy"),
            Ok(("web".into(), "deploy".into()))
        );
        assert_eq!(
            routed(&one, "note: keep this"),
            Ok(("trame".into(), "note: keep this".into()))
        );
        assert!(
            routed(&two, "note: keep this")
                .unwrap_err()
                .contains("trame, web")
        );
        assert!(routed(&[], "hi").is_err());
    }

    #[test]
    fn a_bots_default_hue_is_a_stable_hash_of_its_name() {
        assert_eq!(name_hue("trame"), name_hue("trame"));
        assert_eq!((name_hue(""), name_hue("a")), (61, 340));
        assert!(
            ["ci", "web-2", "trame"]
                .iter()
                .all(|n| (0..360).contains(&name_hue(n)))
        );
    }

    #[test]
    fn names_are_slugs() {
        for (name, ok) in [
            ("trame", true),
            ("a-1", true),
            ("-a", false),
            ("A", false),
            ("", false),
            (&"a".repeat(33), false),
        ] {
            assert_eq!(valid_name(name), ok, "{name}");
        }
    }
}
