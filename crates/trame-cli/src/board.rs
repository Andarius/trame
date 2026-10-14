use crate::{
    refs::{RefKind, parse_session_ref},
    target::Target,
};
use anyhow::{Result, bail};
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    io::IsTerminal,
    time::Duration,
};

fn rows(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}
fn string<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
pub fn board_rows(board: &Value) -> Value {
    let terminal: HashSet<_> = rows(&board["statuses"])
        .into_iter()
        .filter(|s| s["terminal"] == true)
        .filter_map(|s| s["key"].as_str().map(str::to_owned))
        .collect();
    let stories: HashMap<_, _> = rows(&board["stories"])
        .into_iter()
        .filter_map(|s| {
            Some((
                s["id"].as_str()?.to_owned(),
                s["title"].as_str()?.to_owned(),
            ))
        })
        .collect();
    json!(
        rows(&board["sessions"])
            .into_iter()
            .filter(|s| s["deleted"] != true && !terminal.contains(string(s, "status")))
            .map(|s| {
                let mut out = serde_json::Map::new();
                for key in [
                    "id",
                    "title",
                    "status",
                    "story",
                    "branch",
                    "branches",
                    "repo_path",
                    "last_touched",
                    "next_step",
                    "pr_url",
                ] {
                    if key == "story" {
                        out.insert(
                            key.into(),
                            json!(s["page_id"].as_str().and_then(|id| stories.get(id))),
                        );
                    } else if let Some(value) = s.get(key) {
                        out.insert(key.into(), value.clone());
                    }
                }
                Value::Object(out)
            })
            .collect::<Vec<_>>()
    )
}
pub fn format_board(board: &Value) -> String {
    format_board_with_color(board, false)
}
fn tint(text: String, code: &str, color: bool) -> String {
    if color {
        format!("\x1b[{code}m{text}\x1b[0m")
    } else {
        text
    }
}
fn format_board_with_color(board: &Value, color: bool) -> String {
    let terminal: HashSet<_> = rows(&board["statuses"])
        .into_iter()
        .filter(|s| s["terminal"] == true)
        .filter_map(|s| s["key"].as_str().map(str::to_owned))
        .collect();
    let stories: HashMap<_, _> = rows(&board["stories"])
        .into_iter()
        .filter_map(|s| {
            Some((
                s["id"].as_str()?.to_owned(),
                s["title"].as_str()?.to_owned(),
            ))
        })
        .collect();
    let mut groups: Vec<(String, Vec<Value>)> = Vec::new();
    for s in rows(&board["sessions"])
        .into_iter()
        .filter(|s| s["deleted"] != true && !terminal.contains(string(s, "status")))
    {
        let story = s["page_id"]
            .as_str()
            .and_then(|id| stories.get(id))
            .cloned()
            .unwrap_or_else(|| "(no story)".into());
        if let Some((_, items)) = groups.iter_mut().find(|(name, _)| *name == story) {
            items.push(s);
        } else {
            groups.push((story, vec![s]));
        }
    }
    if groups.is_empty() {
        return "no open sessions".into();
    }
    groups
        .into_iter()
        .map(|(name, items)| {
            let lines = items
                .into_iter()
                .map(|s| {
                    let branch = if string(&s, "branch").is_empty() {
                        String::new()
                    } else {
                        format!(" ({})", string(&s, "branch"))
                    };
                    let next = if string(&s, "next_step").is_empty() {
                        String::new()
                    } else {
                        tint(format!(" — next: {}", string(&s, "next_step")), "2", color)
                    };
                    let status = string(&s, "status");
                    let color_code = match status {
                        "active" => "32",
                        "todo" => "34",
                        "paused" => "33",
                        "blocked" => "31",
                        _ => "36",
                    };
                    format!(
                        "  {} {}{}{}",
                        tint(format!("[{status}]"), color_code, color),
                        string(&s, "title"),
                        branch,
                        next
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            format!("{}\n{lines}", tint(name, "1", color))
        })
        .collect::<Vec<_>>()
        .join("\n")
}
/// Every enabled plugin's `cardFaces` route merged; plugins run only in the local app, never on the hub.
pub async fn load_assigners(target: &Target) -> Result<Value> {
    if target.hub {
        bail!("assigner: needs the running Trame app (plugin data, the hub has none)");
    }
    let mut out = serde_json::Map::new();
    let mut found = false;
    for m in rows(&target.get("/api/plugins").await?) {
        let (Some(id), Some(route)) = (m["id"].as_str(), m["cardFaces"].as_str()) else {
            continue;
        };
        if m["enabled"] != true {
            continue;
        }
        found = true;
        if let Value::Object(faces) = target.get(&format!("/api/plugins/{id}{route}")).await? {
            out.extend(faces);
        }
    }
    if !found {
        bail!("assigner: no enabled plugin provides card assigners (e.g. Cockpit)");
    }
    Ok(Value::Object(out))
}
pub async fn list(args: &[String], json_out: bool, target: &Target) -> Result<()> {
    let deleted = args.iter().any(|a| a == "--deleted");
    let query = args
        .iter()
        .position(|a| a == "--query" || a == "-q")
        .map(|i| {
            args.get(i + 1)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| anyhow::anyhow!("--query needs a query — see `tramecli query`"))
        })
        .transpose()?;
    let mut board = target
        .get(if deleted {
            "/api/board?deleted=1"
        } else {
            "/api/board"
        })
        .await?;
    if deleted {
        for s in board["sessions"].as_array_mut().into_iter().flatten() {
            s["deleted"] = json!(false);
        }
        for s in board["statuses"].as_array_mut().into_iter().flatten() {
            s["terminal"] = json!(false);
        }
    }
    if let Some(query) = query {
        let parsed = crate::query::parse(query);
        if !parsed.errors.is_empty() {
            bail!("{} — see `tramecli query`", parsed.errors.join(", "));
        }
        let assigners = if crate::query::needs_assigners(&parsed.terms) {
            load_assigners(target).await?
        } else {
            Value::Null
        };
        let sessions: Vec<_> = rows(&board["sessions"])
            .into_iter()
            .filter(|s| crate::query::matches(s, &board, &assigners, &parsed.terms))
            .collect();
        board["sessions"] = json!(sessions);
        if parsed
            .terms
            .iter()
            .any(|t| t.key.as_deref() == Some("status"))
        {
            for s in board["statuses"].as_array_mut().into_iter().flatten() {
                s["terminal"] = json!(false);
            }
        }
    }
    println!(
        "{}",
        if json_out {
            board_rows(&board).to_string()
        } else {
            format_board_with_color(
                &board,
                std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none(),
            )
        }
    );
    Ok(())
}
pub async fn stories(args: &[String], json_out: bool, target: &Target) -> Result<()> {
    let flag = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .map(String::as_str)
    };
    let q = args
        .iter()
        .position(|a| a == "--query" || a == "-q")
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("stories needs -q \"<topic>\""))?;
    let client = flag("--client");
    let mut url = reqwest::Url::parse("http://localhost/api/stories/similar")?;
    url.query_pairs_mut().append_pair("q", q);
    if let Some(client) = client {
        url.query_pairs_mut().append_pair("client", client);
    } else {
        url.query_pairs_mut()
            .append_pair("repo_path", &std::env::current_dir()?.to_string_lossy());
    }
    let path = format!("{}?{}", url.path(), url.query().unwrap_or(""));
    let hits = target.get(&path).await?;
    if json_out {
        println!("{hits}");
    } else if rows(&hits).is_empty() {
        println!("no similar open story — name a new one");
    } else {
        for hit in rows(&hits) {
            println!(
                "{:.2}  {}  ({} open cards)",
                hit["score"].as_f64().unwrap_or(0.0),
                string(&hit, "title"),
                hit["open_cards"]
            );
        }
    }
    Ok(())
}
pub async fn convert(args: &[String], json_out: bool, target: &Target) -> Result<()> {
    let story = args.iter().any(|a| a == "--story");
    let id = args
        .iter()
        .find(|a| a.as_str() != "--story")
        .ok_or_else(|| anyhow::anyhow!("usage: tramecli convert [--story] <page-id>"))?;
    let res = target
        .request(
            Method::POST,
            &format!(
                "/api/pages/{id}/{}",
                if story { "story" } else { "session" }
            ),
            None,
            Some(Duration::from_secs(5)),
        )
        .await?;
    if json_out {
        println!("{res}");
    } else if story {
        let id = string(&res, "id");
        println!(
            "ok: page {id} is a user story{}",
            target.app_link(&format!("page={id}"))
        );
    } else {
        let id = string(&res, "id");
        println!(
            "ok: session {id} {} this page{}",
            if res["created"] == true {
                "created from"
            } else {
                "already specced by"
            },
            target.app_link(&format!("view=card&card={id}"))
        );
    }
    Ok(())
}
pub async fn archive(args: &[String], json_out: bool, target: &Target) -> Result<()> {
    let restore = args.iter().any(|a| a == "--restore");
    let raw = args.iter().find(|a| !a.starts_with("--"));
    let reference = raw.and_then(|s| parse_session_ref(s)).ok_or_else(|| {
        anyhow::anyhow!("usage: tramecli archive [--restore] <page id | page URL>")
    })?;
    let id = reference.id;
    if target.get(&format!("/api/pages/{id}")).await.is_err() {
        bail!("no page with id {id} — a card is closed by tracking it done");
    }
    let status = if restore { "open" } else { "archived" };
    target
        .post(&format!("/api/pages/{id}"), &json!({"status":status}))
        .await?;
    if json_out {
        println!("{}", json!({"id":id,"status":status}));
    } else {
        println!(
            "ok: page {id} {status}{}",
            target.app_link(&format!("page={id}"))
        );
    }
    Ok(())
}
pub async fn move_page(args: &[String], json_out: bool, target: &Target) -> Result<()> {
    let top = args.iter().any(|a| a == "--top");
    let refs = args
        .iter()
        .filter(|a| !a.starts_with("--"))
        .map(|s| parse_session_ref(s).map(|r| r.id))
        .collect::<Option<Vec<_>>>()
        .unwrap_or_default();
    let (id, parent) = match (refs.as_slice(), top) {
        ([id], true) => (id.clone(), None),
        ([id, parent], false) => (id.clone(), Some(parent.clone())),
        _ => bail!("usage: tramecli move <page id | page URL> (<parent id | parent URL> | --top)"),
    };
    for page in std::iter::once(&id).chain(parent.as_ref()) {
        if target.get(&format!("/api/pages/{page}")).await.is_err() {
            bail!("no page with id {page}");
        }
    }
    target
        .post(
            &format!("/api/pages/{id}/move"),
            &json!({"parent_id":parent}),
        )
        .await?;
    if json_out {
        println!("{}", json!({"id":id,"parent_id":parent}));
    } else {
        println!(
            "ok: page {id} moved under {}{}",
            parent.as_deref().unwrap_or("the top level"),
            target.app_link(&format!("page={id}"))
        );
    }
    Ok(())
}
pub async fn show(args: &[String], json_out: bool, target: &Target) -> Result<()> {
    let events_at = args.iter().position(|a| a == "--events");
    let events = events_at
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|n| *n != 0.0)
        .unwrap_or(20.0);
    let raw = args
        .iter()
        .enumerate()
        .find(|(i, a)| !a.starts_with("--") && events_at.is_none_or(|at| *i != at + 1))
        .map(|(_, a)| a);
    let reference = raw.and_then(|s| parse_session_ref(s)).ok_or_else(|| {
        anyhow::anyhow!(
            "usage: tramecli show <session id | page id | Trame URL> [--events N] [--json]"
        )
    })?;
    if reference.kind == RefKind::Session {
        let path = format!("/api/sessions/{}?events={events}", reference.id);
        if let Ok(card) = target.get(&path).await {
            if json_out {
                println!("{card}");
            } else {
                print_card(&card, target);
            }
            return Ok(());
        }
    }
    let page = target
        .get(&format!("/api/pages/{}", reference.id))
        .await
        .map_err(|_| anyhow::anyhow!("nothing in Trame with id {}", reference.id))?;
    if json_out {
        println!("{page}");
    } else {
        print_page(&page, target)?;
    }
    Ok(())
}
fn print_card(card: &Value, target: &Target) {
    let id = string(card, "id");
    println!(
        "▦ {}  [{}]{}",
        string(card, "title"),
        string(card, "status"),
        target.app_link(&format!("view=card&card={id}"))
    );
    let meta = [
        card["project"]["name"]
            .as_str()
            .map(|s| format!("project: {s}")),
        card["story"]["title"]
            .as_str()
            .map(|s| format!("story: {s}")),
        card["branch"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(|s| format!("branch: {s}")),
        card["pr_url"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(|s| format!("PR: {}", s.replace('\n', ", "))),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" · ");
    if !meta.is_empty() {
        println!("{meta}");
    }
    if let Some(next) = card["next_step"].as_str().filter(|s| !s.is_empty()) {
        println!("next: {next}");
    }
    let links = rows(&card["links"])
        .iter()
        .filter_map(|l| {
            l["anchor"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or_else(|| l["page_title"].as_str())
        })
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if !links.is_empty() {
        println!("works on: {}", links.join(" · "));
    }
    if let Some(specs) = card["specs"].as_str().filter(|s| !s.trim().is_empty()) {
        println!("\n## Specs\n\n{}", specs.trim());
    }
    if !rows(&card["activity"]).is_empty() {
        println!("\n## Worklog\n");
        for event in rows(&card["activity"]) {
            let who = [event["agent"].as_str(), event["model"].as_str()]
                .into_iter()
                .flatten()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" · ");
            let who = if who.is_empty() {
                String::new()
            } else {
                format!("{who} · ")
            };
            let at = string(&event, "at").chars().take(10).collect::<String>();
            println!(
                "- {at} · {who}{} — {}",
                string(&event, "kind"),
                string(&event, "summary")
            );
        }
    }
}
fn print_page(page: &Value, target: &Target) -> Result<()> {
    let id = string(page, "id");
    println!(
        "# {}  [{}]{}",
        page["title"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("Untitled"),
        string(page, "kind"),
        target.app_link(&format!("page={id}"))
    );
    if let Some(brief) = page["brief"].as_str().filter(|s| !s.trim().is_empty()) {
        println!("\n{}", brief.trim());
    }
    let content = rows(&page["content"]);
    let markdown =
        trame_core::page_markdown::page_blocks_to_markdown(&content).map_err(anyhow::Error::msg)?;
    if !markdown.trim().is_empty() {
        println!("\n{}", markdown.trim());
    }
    let sessions = rows(&page["sessions"]);
    let specs: HashSet<_> = sessions
        .iter()
        .filter_map(|s| s["specs_page_id"].as_str())
        .collect();
    let subs = rows(&page["children"])
        .into_iter()
        .filter(|p| !specs.contains(string(p, "id")))
        .map(|p| {
            format!(
                "- {} ({})",
                p["title"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Untitled"),
                string(&p, "kind")
            )
        })
        .collect::<Vec<_>>();
    if !subs.is_empty() {
        println!("\n## Sub-pages\n\n{}", subs.join("\n"));
    }
    if !sessions.is_empty() {
        let cards = sessions
            .iter()
            .map(|s| format!("- {} [{}]", string(s, "title"), string(s, "status")))
            .collect::<Vec<_>>();
        println!("\n## Cards\n\n{}", cards.join("\n"));
    }
    Ok(())
}
