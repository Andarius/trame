use crate::{
    connectors::{self, Connector, Entry, Group, Message},
    due::{self, Options, Window},
    target::{data_file, resolve_target},
};
use anyhow::{Context, Result, bail};
use chrono::{Datelike, Duration, Local, NaiveDate, NaiveDateTime, NaiveTime, Weekday};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, env, fs, path::PathBuf, process::Command};

const DAYS: [&str; 7] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/// One `due.schedules` entry in settings.json; times are host local time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Schedule {
    pub name: String,
    #[serde(default = "default_at")]
    pub at: String,
    #[serde(default = "default_until")]
    pub until: String,
    #[serde(default = "all_days")]
    pub days: Vec<String>,
    /// "late", "today", "week", or a number of days ahead
    #[serde(default = "default_window")]
    pub window: Value,
    /// connector names; empty = every set-up connector
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub to: Vec<String>,
}

fn default_at() -> String {
    "08:30".into()
}
fn default_until() -> String {
    "12:00".into()
}
fn all_days() -> Vec<String> {
    DAYS.map(String::from).to_vec()
}
fn default_window() -> Value {
    json!("today")
}

impl Schedule {
    pub fn morning() -> Self {
        Self {
            name: "morning".into(),
            at: default_at(),
            until: default_until(),
            days: all_days(),
            window: default_window(),
            to: Vec::new(),
        }
    }

    fn time(s: &str, field: &str, name: &str) -> Result<NaiveTime> {
        NaiveTime::parse_from_str(s, "%H:%M")
            .with_context(|| format!("schedule {name}: {field} must be HH:MM, got {s:?}"))
    }

    pub fn window(&self) -> Result<Window> {
        Ok(match &self.window {
            Value::String(s) if s == "late" => Window::Late,
            Value::String(s) if s == "today" => Window::Within(0),
            Value::String(s) if s == "week" => Window::Within(7),
            Value::Number(n) if n.as_u64().is_some() => {
                Window::Within(i64::try_from(n.as_u64().unwrap_or(0)).unwrap_or(i64::MAX))
            }
            other => bail!(
                "schedule {}: window must be late, today, week or a number of days, got {other}",
                self.name
            ),
        })
    }

    pub fn validate(&self) -> Result<()> {
        if self.name.is_empty()
            || !self
                .name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            bail!(
                "schedule name must be letters, digits, - or _, got {:?}",
                self.name
            );
        }
        let (at, until) = (
            Self::time(&self.at, "at", &self.name)?,
            Self::time(&self.until, "until", &self.name)?,
        );
        if at >= until {
            bail!(
                "schedule {}: until ({}) must be after at ({})",
                self.name,
                self.until,
                self.at
            );
        }
        if self.days.is_empty() {
            bail!("schedule {}: days is empty", self.name);
        }
        if let Some(day) = self.days.iter().find(|d| !DAYS.contains(&d.as_str())) {
            bail!(
                "schedule {}: unknown day {day:?} (use {})",
                self.name,
                DAYS.join(", ")
            );
        }
        self.window()?;
        for name in &self.to {
            connectors::spec(name)?;
        }
        Ok(())
    }

    fn runs_on(&self, day: Weekday) -> bool {
        self.days
            .iter()
            .any(|d| d == DAYS[day.num_days_from_monday() as usize])
    }

    /// Inside today's send window: a run day, at or after `at`, before `until`.
    pub fn open_at(&self, now: NaiveDateTime) -> bool {
        let (Ok(at), Ok(until)) = (
            Self::time(&self.at, "at", &self.name),
            Self::time(&self.until, "until", &self.name),
        ) else {
            return false;
        };
        self.runs_on(now.weekday()) && now.time() >= at && now.time() < until
    }

    /// The next start of a send window after `now`, skipping today when it already ran.
    pub fn next_run(&self, now: NaiveDateTime, ran_today: bool) -> Option<NaiveDateTime> {
        let at = Self::time(&self.at, "at", &self.name).ok()?;
        let until = Self::time(&self.until, "until", &self.name).ok()?;
        (0..8).find_map(|offset| {
            let day = now.date() + Duration::days(offset);
            if !self.runs_on(day.weekday()) || (offset == 0 && (ran_today || now.time() >= until)) {
                return None;
            }
            Some(
                day.and_time(at)
                    .max(if offset == 0 { now } else { day.and_time(at) }),
            )
        })
    }
}

/// `days` from the CLI: "mon-fri", "sat,sun", "all".
pub fn parse_days(s: &str) -> Result<Vec<String>> {
    if s == "all" {
        return Ok(all_days());
    }
    let index = |d: &str| {
        DAYS.iter()
            .position(|x| *x == d)
            .ok_or_else(|| anyhow::anyhow!("unknown day {d:?} (use {})", DAYS.join(", ")))
    };
    let mut out = Vec::new();
    for part in s.split(',').map(str::trim) {
        match part.split_once('-') {
            Some((a, b)) => {
                let (a, b) = (index(a)?, index(b)?);
                if a > b {
                    bail!("day range {part} runs backwards");
                }
                out.extend(DAYS[a..=b].iter().map(|d| (*d).to_owned()));
            }
            None => out.push(DAYS[index(part)?].to_owned()),
        }
    }
    Ok(out)
}

// Settings

fn settings_path() -> PathBuf {
    data_file("TRACKER_SETTINGS_FILE", "settings.json")
}

fn read_settings() -> Result<Value> {
    match fs::read_to_string(settings_path()) {
        Ok(text) => serde_json::from_str(&text).context("settings.json is not valid JSON"),
        Err(_) => Ok(json!({})),
    }
}

pub fn schedules_from(settings: &Value) -> Result<Vec<Schedule>> {
    let Some(raw) = settings.get("due").and_then(|d| d.get("schedules")) else {
        return Ok(vec![Schedule::morning()]);
    };
    let list: Vec<Schedule> =
        serde_json::from_value(raw.clone()).context("settings.json due.schedules")?;
    for s in &list {
        s.validate()?;
    }
    Ok(list)
}

fn write_schedules(list: &[Schedule]) -> Result<()> {
    let mut settings = read_settings()?;
    if !settings.is_object() {
        settings = json!({});
    }
    if !settings["due"].is_object() {
        settings["due"] = json!({});
    }
    settings["due"]["schedules"] = serde_json::to_value(list)?;
    let path = settings_path();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(&settings)? + "\n")?;
    fs::rename(tmp, path)?;
    Ok(())
}

// Stamps: the day a schedule last reached a connector (and the day it last reported a failure)

fn state_dir() -> PathBuf {
    if let Some(dir) = env::var_os("TRAME_STATE_DIR") {
        return PathBuf::from(dir);
    }
    env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env::var_os("HOME").unwrap_or_default()).join(".local/state")
        })
        .join("trame")
}

fn stamp_path(schedule: &str, connector: &str, failed: bool) -> PathBuf {
    state_dir().join(format!(
        "due-{schedule}-{connector}{}",
        if failed { ".failed" } else { "" }
    ))
}

fn stamped(schedule: &str, connector: &str, failed: bool, today: NaiveDate) -> bool {
    fs::read_to_string(stamp_path(schedule, connector, failed))
        .is_ok_and(|s| s.trim() == today.to_string())
}

fn stamp(schedule: &str, connector: &str, failed: bool, today: NaiveDate) -> Result<()> {
    fs::create_dir_all(state_dir())?;
    fs::write(stamp_path(schedule, connector, failed), today.to_string())?;
    Ok(())
}

// Digest

/// Due rows (from `due::rows`) as a message grouped by project, then card or page.
pub fn digest(rows: &[Value]) -> Message {
    let s = |v: &Value| v.as_str().unwrap_or("").to_owned();
    let late = rows
        .iter()
        .filter(|r| r["days"].as_i64().unwrap_or(0) < 0)
        .count();
    let mut counts = Vec::new();
    if late > 0 {
        counts.push(format!("{late} late"));
    }
    let today = rows.iter().filter(|r| r["days"] == 0).count();
    if today > 0 {
        counts.push(format!("{today} due today"));
    }
    let ahead = rows.len() - late - today;
    if ahead > 0 {
        counts.push(format!("{ahead} coming up"));
    }
    let mut projects: BTreeMap<String, BTreeMap<String, Entry>> = BTreeMap::new();
    for r in rows {
        let project = r["project"].as_str().unwrap_or("No project").to_owned();
        let (label, link) = match r["card_title"].as_str() {
            Some(title) => (
                format!("[{}] {title}", s(&r["status"])),
                format!("trame://card/{}", s(&r["card_id"])),
            ),
            None => (
                s(&r["page_title"]),
                format!("trame://page/{}", s(&r["page_id"])),
            ),
        };
        projects
            .entry(project)
            .or_default()
            .entry(link.clone())
            .or_insert_with(|| Entry {
                label,
                link: Some(link),
                lines: Vec::new(),
            })
            .lines
            .push(format!(
                "⚑ {} ({})",
                s(&r["text"]),
                due::when(r["days"].as_i64().unwrap_or(0))
            ));
    }
    Message {
        title: format!("Trame · {}", counts.join(", ")),
        body: None,
        groups: projects
            .into_iter()
            .map(|(heading, cards)| Group {
                heading,
                entries: cards.into_values().collect(),
            })
            .collect(),
    }
}

fn failure(reason: &str) -> Message {
    Message {
        title: "Trame due digest failed".into(),
        body: Some(format!(
            "{reason}\nIt retries every 5 minutes until the schedule closes."
        )),
        groups: Vec::new(),
    }
}

fn plain(message: &Message) -> String {
    let mut out = vec![message.title.clone()];
    out.extend(message.body.clone());
    for g in &message.groups {
        out.push(format!("\n{}", g.heading));
        for e in &g.entries {
            out.push(format!(
                "  {}{}",
                e.label,
                e.link
                    .as_ref()
                    .map(|l| format!(" — {l}"))
                    .unwrap_or_default()
            ));
            out.extend(e.lines.iter().map(|l| format!("    {l}")));
        }
    }
    out.join("\n")
}

// Commands

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

async fn send(args: &[String]) -> Result<()> {
    let dry = args.iter().any(|a| a == "--dry-run");
    let force = flag(args, "--now");
    let to: Option<Vec<String>> =
        flag(args, "--to").map(|s| s.split(',').map(str::trim).map(String::from).collect());
    let schedules = schedules_from(&read_settings()?)?;
    if let Some(name) = &force {
        if !schedules.iter().any(|s| &s.name == name) {
            bail!("no schedule named {name} — see `tramecli due schedule list`");
        }
    }
    let values = connectors::load_values();
    let now = Local::now().naive_local();
    let today = now.date();
    let client = connectors::client()?;
    let mut failed = Vec::new();
    for schedule in &schedules {
        let forced = force.as_deref() == Some(schedule.name.as_str());
        if force.is_some() && !forced {
            continue;
        }
        let targets: Vec<Box<dyn Connector>> = match to
            .as_ref()
            .or((!schedule.to.is_empty()).then_some(&schedule.to))
        {
            Some(names) => connectors::named(&values, names)?,
            None => connectors::configured(&values),
        };
        if targets.is_empty() && !dry {
            bail!("no connector is set up — run `tramecli connector setup telegram`");
        }
        let ran_today = targets
            .iter()
            .all(|c| stamped(&schedule.name, c.name(), false, today));
        let pending: Vec<_> = targets
            .into_iter()
            .filter(|c| forced || dry || !stamped(&schedule.name, c.name(), false, today))
            .collect();
        if dry {
            println!(
                "{}: window {}, {} → {}; next run {}",
                schedule.name,
                schedule.window.to_string().trim_matches('"'),
                if schedule.open_at(now) {
                    "open now"
                } else {
                    "closed now"
                },
                pending
                    .iter()
                    .map(|c| c.name())
                    .collect::<Vec<_>>()
                    .join(", "),
                schedule.next_run(now, ran_today).map_or_else(
                    || "never".into(),
                    |t| t.format("%a %Y-%m-%d %H:%M").to_string()
                )
            );
        } else if pending.is_empty() || !(forced || schedule.open_at(now)) {
            continue;
        }
        let options = Options {
            window: schedule.window()?,
            query: None,
        };
        let rows = match resolve_target().await {
            Ok(target) => due::load(&options, &target).await,
            Err(e) => Err(e),
        };
        let message = match rows {
            Ok(rows) if rows.is_empty() => {
                if dry {
                    println!("  nothing due: no message");
                    continue;
                }
                for c in &pending {
                    stamp(&schedule.name, c.name(), false, today)?;
                }
                continue;
            }
            Ok(rows) => digest(&rows),
            Err(e) => {
                let message = failure(&format!("{e:#}"));
                if dry {
                    println!("{}", plain(&message));
                    continue;
                }
                for c in pending
                    .iter()
                    .filter(|c| !stamped(&schedule.name, c.name(), true, today))
                {
                    if c.send(&client, &message).await.is_ok() {
                        stamp(&schedule.name, c.name(), true, today)?;
                    }
                }
                failed.push(format!("{}: {e:#}", schedule.name));
                continue;
            }
        };
        if dry {
            println!("{}\n", plain(&message));
            continue;
        }
        for c in &pending {
            match c.send(&client, &message).await {
                Ok(()) => {
                    stamp(&schedule.name, c.name(), false, today)?;
                    println!("{}: sent to {}", schedule.name, c.name());
                }
                Err(e) => failed.push(format!("{} → {}: {e:#}", schedule.name, c.name())),
            }
        }
    }
    if !failed.is_empty() {
        bail!("{}", failed.join("\n"));
    }
    Ok(())
}

fn schedule_cmd(args: &[String]) -> Result<()> {
    let mut list = schedules_from(&read_settings()?)?;
    let action = args.first().map_or("list", String::as_str);
    let name = args.get(1).cloned();
    match action {
        "list" => {
            let now = Local::now().naive_local();
            let values = connectors::load_values();
            let set_up: Vec<String> = connectors::configured(&values)
                .iter()
                .map(|c| c.name().to_owned())
                .collect();
            for s in &list {
                let to = if s.to.is_empty() {
                    set_up.clone()
                } else {
                    s.to.clone()
                };
                let sent: Vec<String> = to
                    .iter()
                    .map(|c| {
                        let last = fs::read_to_string(stamp_path(&s.name, c, false))
                            .unwrap_or_else(|_| "never".into());
                        format!("{c} (last {})", last.trim())
                    })
                    .collect();
                let ran = to.iter().all(|c| stamped(&s.name, c, false, now.date()));
                println!(
                    "{:<10} {}–{} {:<27} window {:<7} → {}; next {}",
                    s.name,
                    s.at,
                    s.until,
                    s.days.join(","),
                    s.window.to_string().trim_matches('"'),
                    if sent.is_empty() {
                        "no connector set up".into()
                    } else {
                        sent.join(", ")
                    },
                    s.next_run(now, ran)
                        .map_or_else(|| "never".into(), |t| t.format("%a %H:%M").to_string())
                );
            }
            let timer = Command::new("systemctl")
                .args(["--user", "is-active", "trame-due.timer"])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
                .unwrap_or_else(|_| "unknown".into());
            println!("timer trame-due.timer: {timer}");
            return Ok(());
        }
        "add" | "set" => {
            let Some(name) = name else {
                bail!("usage: tramecli due schedule {action} <name> [--at HH:MM] …")
            };
            let existing = list.iter().position(|s| s.name == name);
            let mut s = match (action, existing) {
                ("add", Some(_)) => bail!("schedule {name} exists — use `due schedule set {name}`"),
                ("set", None) => bail!("no schedule named {name} — use `due schedule add {name}`"),
                (_, Some(i)) => list.remove(i),
                (_, None) => Schedule {
                    name: name.clone(),
                    ..Schedule::morning()
                },
            };
            if let Some(v) = flag(args, "--at") {
                s.at = v;
            }
            if let Some(v) = flag(args, "--until") {
                s.until = v;
            }
            if let Some(v) = flag(args, "--days") {
                s.days = parse_days(&v)?;
            }
            if let Some(v) = flag(args, "--window") {
                s.window = v.parse::<u64>().map_or(json!(v), |n| json!(n));
            }
            if let Some(v) = flag(args, "--to") {
                s.to = if v == "all" {
                    Vec::new()
                } else {
                    v.split(',').map(str::trim).map(String::from).collect()
                };
            }
            s.validate()?;
            list.push(s);
        }
        "rm" => {
            let Some(name) = name else {
                bail!("usage: tramecli due schedule rm <name>")
            };
            let before = list.len();
            list.retain(|s| s.name != name);
            if list.len() == before {
                bail!("no schedule named {name}");
            }
        }
        other => bail!("unknown schedule command: {other} — see `tramecli due --help`"),
    }
    write_schedules(&list)?;
    println!(
        "saved {} schedule(s) to {}",
        list.len(),
        settings_path().display()
    );
    Ok(())
}

fn install(args: &[String]) -> Result<()> {
    let dir = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env::var_os("HOME").unwrap_or_default()).join(".config"))
        .join("systemd/user");
    let systemctl = |args: &[&str]| -> Result<()> {
        let ok = Command::new("systemctl")
            .arg("--user")
            .args(args)
            .status()?
            .success();
        if !ok {
            bail!("systemctl --user {} failed", args.join(" "));
        }
        Ok(())
    };
    if args.iter().any(|a| a == "--uninstall") {
        let _ = systemctl(&["disable", "--now", "trame-due.timer"]);
        for unit in ["trame-due.service", "trame-due.timer"] {
            let _ = fs::remove_file(dir.join(unit));
        }
        systemctl(&["daemon-reload"])?;
        println!("removed trame-due.timer");
        return Ok(());
    }
    let exe = env::current_exe()?;
    fs::create_dir_all(&dir)?;
    fs::write(
        dir.join("trame-due.service"),
        format!(
            "[Unit]\nDescription=Trame due digest (tramecli due --send)\n\n[Service]\nType=oneshot\nExecStart={} due --send\n",
            exe.display()
        ),
    )?;
    fs::write(
        dir.join("trame-due.timer"),
        "[Unit]\nDescription=Trame due digest, every 5 minutes; schedules live in settings.json\n\n[Timer]\nOnCalendar=*:0/5\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n",
    )?;
    systemctl(&["daemon-reload"])?;
    systemctl(&["enable", "--now", "trame-due.timer"])?;
    println!(
        "installed trame-due.timer in {} (runs {} due --send)",
        dir.display(),
        exe.display()
    );
    Ok(())
}

/// `due --send`, `due schedule …` and `due install`; None when the args are a plain listing.
pub async fn dispatch(args: &[String]) -> Option<Result<()>> {
    match args.first().map(String::as_str) {
        Some("schedule") => Some(schedule_cmd(&args[1..])),
        Some("install") => Some(install(&args[1..])),
        _ if args.iter().any(|a| a == "--send") => Some(send(args).await),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap()
    }

    #[test]
    fn schedules_default_parse_and_reject() {
        assert_eq!(
            schedules_from(&json!({})).unwrap(),
            vec![Schedule::morning()]
        );
        let custom = json!({"due": {"schedules": [{"name": "evening", "at": "17:00", "until": "20:00", "window": "late"}]}});
        let list = schedules_from(&custom).unwrap();
        assert_eq!(
            (list[0].at.as_str(), list[0].window().unwrap()),
            ("17:00", Window::Late)
        );
        for (bad, why) in [
            (json!({"name": "m", "at": "8h30"}), "at must be HH:MM"),
            (
                json!({"name": "m", "at": "13:00"}),
                "until (12:00) must be after",
            ),
            (json!({"name": "m", "days": ["lun"]}), "unknown day"),
            (json!({"name": "m", "window": "soon"}), "window must be"),
            (json!({"name": "m", "to": ["pigeon"]}), "unknown connector"),
            (json!({"name": "m", "colour": "red"}), "unknown field"),
        ] {
            let err = format!(
                "{:#}",
                schedules_from(&json!({"due": {"schedules": [bad]}})).unwrap_err()
            );
            assert!(err.contains(why), "{why}: {err}");
        }
    }

    #[test]
    fn open_window_and_next_run() {
        let mut s = Schedule::morning();
        s.days = parse_days("mon-fri").unwrap();
        // 2026-11-25 is a Wednesday, 2026-11-28 a Saturday
        assert!(!s.open_at(at("2026-11-25 08:29")));
        assert!(s.open_at(at("2026-11-25 08:30")));
        assert!(!s.open_at(at("2026-11-25 12:00")));
        assert!(!s.open_at(at("2026-11-28 09:00")));
        assert_eq!(
            s.next_run(at("2026-11-25 07:00"), false),
            Some(at("2026-11-25 08:30"))
        );
        assert_eq!(
            s.next_run(at("2026-11-25 09:00"), false),
            Some(at("2026-11-25 09:00"))
        );
        assert_eq!(
            s.next_run(at("2026-11-25 09:00"), true),
            Some(at("2026-11-26 08:30"))
        );
        assert_eq!(
            s.next_run(at("2026-11-27 13:00"), false),
            Some(at("2026-11-30 08:30"))
        );
        assert_eq!(parse_days("sat,sun").unwrap(), ["sat", "sun"]);
        assert!(parse_days("fri-mon").is_err());
    }

    #[test]
    fn digest_groups_by_project_then_card() {
        let rows = vec![
            json!({"days": -2, "text": "rotate", "project": "Soren", "card_id": "c-1", "card_title": "Rotate keys", "status": "active", "page_id": "s-1", "page_title": "x"}),
            json!({"days": 0, "text": "renew", "project": "Soren", "card_id": "c-1", "card_title": "Rotate keys", "status": "active", "page_id": "s-1", "page_title": "x"}),
            json!({"days": 0, "text": "post", "project": null, "card_id": null, "card_title": null, "status": null, "page_id": "pg-1", "page_title": "Notes"}),
        ];
        let m = digest(&rows);
        assert_eq!(m.title, "Trame · 1 late, 2 due today");
        assert_eq!(
            plain(&m),
            "Trame · 1 late, 2 due today\n\nNo project\n  Notes — trame://page/pg-1\n    ⚑ post (today)\n\nSoren\n  [active] Rotate keys — trame://card/c-1\n    ⚑ rotate (2 days late)\n    ⚑ renew (today)"
        );
    }
}
