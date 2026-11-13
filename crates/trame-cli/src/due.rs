use crate::target::Target;
use anyhow::{Result, bail};
use serde_json::{Value, json};
use trame_core::due::days_until;

/// Which due todos to keep, by days until due.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Window {
    All,
    Late,
    Within(i64),
}

pub struct Options {
    pub window: Window,
    pub query: Option<String>,
}

impl Options {
    pub fn parse(args: &[String]) -> Result<Self> {
        let value = |name: &str, short: Option<&str>| {
            args.iter()
                .position(|a| a == name || Some(a.as_str()) == short)
                .map(|i| {
                    args.get(i + 1)
                        .filter(|s| !s.is_empty())
                        .cloned()
                        .ok_or_else(|| anyhow::anyhow!("{name} needs a value"))
                })
                .transpose()
        };
        let within = value("--within", None)?
            .map(|n| {
                n.parse::<i64>()
                    .map_err(|_| anyhow::anyhow!("--within needs a number of days, got {n}"))
            })
            .transpose()?;
        let late = args.iter().any(|a| a == "--late");
        let all = args.iter().any(|a| a == "--all");
        let window = match (late, all, within) {
            (true, false, None) => Window::Late,
            (false, true, None) => Window::All,
            (false, false, Some(n)) => Window::Within(n),
            (false, false, None) => Window::Within(7),
            _ => bail!("pick one of --late, --all, --within N"),
        };
        Ok(Self {
            window,
            query: value("--query", Some("-q"))?,
        })
    }
}

fn keep(window: Window, days: i64) -> bool {
    match window {
        Window::All => true,
        Window::Late => days < 0,
        Window::Within(n) => days <= n,
    }
}

/// `due` rows (from /api/due) joined to their card and project, filtered and annotated.
pub fn rows(
    due: &Value,
    board: &Value,
    today: &str,
    options: &Options,
    url: &dyn Fn(&str) -> Value,
) -> Result<Vec<Value>> {
    let parsed = options.query.as_deref().map(crate::query::parse);
    if let Some(parsed) = &parsed {
        if !parsed.errors.is_empty() {
            bail!("{} — see `tramecli query`", parsed.errors.join(", "));
        }
    }
    let sessions = board["sessions"].as_array().cloned().unwrap_or_default();
    let mut out = Vec::new();
    for d in due.as_array().into_iter().flatten() {
        let Ok(days) = days_until(d["due"].as_str().unwrap_or(""), today) else {
            continue;
        };
        if !keep(options.window, days) {
            continue;
        }
        let card = d["card_id"]
            .as_str()
            .and_then(|id| sessions.iter().find(|s| s["id"] == id));
        // a todo on a plain page matches as a card filed at that page
        let subject = card
            .cloned()
            .unwrap_or_else(|| json!({"page_id": d["page_id"], "title": d["page_title"]}));
        if let Some(parsed) = &parsed {
            if !crate::query::matches(&subject, board, &Value::Null, &parsed.terms) {
                continue;
            }
        }
        let block = format!(
            "page={}&block={}",
            d["page_id"].as_str().unwrap_or(""),
            d["block_id"].as_str().unwrap_or("")
        );
        out.push(json!({
            "due": d["due"],
            "days": days,
            "text": d["text"],
            "project": crate::query::project_names(&subject, board).first(),
            "card_id": card.map(|c| &c["id"]),
            "card_title": card.map(|c| &c["title"]),
            "status": card.map(|c| &c["status"]),
            "page_id": d["page_id"],
            "page_title": d["page_title"],
            "block_id": d["block_id"],
            "url": url(&block),
        }));
    }
    Ok(out)
}

pub fn when(days: i64) -> String {
    match days {
        d if d < -1 => format!("{} days late", -d),
        -1 => "1 day late".into(),
        0 => "today".into(),
        1 => "tomorrow".into(),
        d => format!("in {d} days"),
    }
}

pub fn format(rows: &[Value]) -> String {
    if rows.is_empty() {
        return "no due todos".into();
    }
    let s = |v: &Value| v.as_str().unwrap_or("").to_owned();
    rows.iter()
        .map(|r| {
            let place = match r["card_title"].as_str() {
                Some(title) => format!("[{}] {title}", s(&r["status"])),
                None => s(&r["page_title"]),
            };
            let project = r["project"]
                .as_str()
                .map(|p| format!("{p} · "))
                .unwrap_or_default();
            let link = r["url"]
                .as_str()
                .map(|u| format!(" — {u}"))
                .unwrap_or_default();
            format!(
                "⚑ {} ({}) {project}{place}\n    {}{link}",
                s(&r["due"]),
                when(r["days"].as_i64().unwrap_or(0)),
                s(&r["text"])
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub async fn load(options: &Options, target: &Target) -> Result<Vec<Value>> {
    let (due, board) = tokio::try_join!(target.get("/api/due"), target.get("/api/board"))?;
    let today = chrono::Local::now()
        .date_naive()
        .format("%Y-%m-%d")
        .to_string();
    rows(&due, &board, &today, options, &|q| target.app_url(q))
}

pub async fn main(args: &[String], json_out: bool, target: &Target) -> Result<()> {
    let rows = load(&Options::parse(args)?, target).await?;
    println!(
        "{}",
        if json_out {
            json!(rows).to_string()
        } else {
            format(&rows)
        }
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn board() -> Value {
        json!({
            "projects": [{"id": "p-soren", "name": "Soren"}, {"id": "p-acme", "name": "Acme"}],
            "pages": [
                {"id": "p-soren", "kind": "project", "title": "Soren", "parent_id": null},
                {"id": "p-acme", "kind": "project", "title": "Acme", "parent_id": null},
                {"id": "st-1", "kind": "story", "title": "Billing", "parent_id": "p-soren"},
                {"id": "pg-1", "kind": "page", "title": "Acme notes", "parent_id": "p-acme"},
            ],
            "sessions": [{"id": "c-1", "title": "Rotate keys", "status": "active", "page_id": "st-1"}],
            "statuses": [],
        })
    }

    fn due() -> Value {
        json!([
            {"due": "2026-10-20", "text": "rotate", "card_id": "c-1", "page_id": "spec-1", "page_title": "Rotate keys", "block_id": "b1"},
            {"due": "2026-10-25", "text": "renew cert", "card_id": null, "page_id": "pg-1", "page_title": "Acme notes", "block_id": "b2"},
            {"due": "2026-10-30", "text": "bump", "card_id": null, "page_id": "pg-1", "page_title": "Acme notes", "block_id": "b3"},
            {"due": "2026-12-01", "text": "far", "card_id": null, "page_id": "pg-1", "page_title": "Acme notes", "block_id": "b4"},
        ])
    }

    #[test]
    fn windows_and_card_queries_pick_rows() {
        for (args, texts) in [
            (vec![], vec!["rotate", "renew cert", "bump"]),
            (vec!["--late"], vec!["rotate", "renew cert"]),
            (vec!["--within", "0"], vec!["rotate", "renew cert"]),
            (vec!["--all"], vec!["rotate", "renew cert", "bump", "far"]),
            // a page todo matches through its page's project; a card through its story's
            (vec!["--late", "-q", "-project:soren"], vec!["renew cert"]),
            (vec!["--all", "-q", "project:soren"], vec!["rotate"]),
            (vec!["--all", "-q", "status:active"], vec!["rotate"]),
        ] {
            let args: Vec<String> = args.into_iter().map(str::to_owned).collect();
            let rows = rows(
                &due(),
                &board(),
                "2026-10-26",
                &Options::parse(&args).unwrap(),
                &|q| json!(q),
            )
            .unwrap();
            let got: Vec<_> = rows.iter().map(|r| r["text"].as_str().unwrap()).collect();
            assert_eq!(got, texts, "{args:?}");
        }
    }

    #[test]
    fn rows_carry_card_project_and_block_link() {
        let all = Options::parse(&["--all".to_owned()]).unwrap();
        let rows = rows(&due(), &board(), "2026-10-26", &all, &|q| json!(q)).unwrap();
        assert_eq!(rows[0]["project"], "Soren");
        assert_eq!(rows[0]["status"], "active");
        assert_eq!(rows[0]["days"], -6);
        assert_eq!(rows[1]["project"], "Acme");
        assert_eq!(rows[1]["card_id"], Value::Null);
        assert_eq!(rows[1]["url"], "page=pg-1&block=b2");
        assert!(
            format(&rows)
                .starts_with("⚑ 2026-10-20 (6 days late) Soren · [active] Rotate keys\n    rotate")
        );
    }

    #[test]
    fn conflicting_windows_are_rejected() {
        let args = ["--late", "--all"].map(str::to_owned);
        assert!(Options::parse(&args).is_err());
    }
}
