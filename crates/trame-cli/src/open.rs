use crate::{
    refs::{RefKind, parse_session_ref},
    target::{RequestFailure, local_target},
};
use anyhow::{Result, bail};
use serde_json::json;
use std::process::{Command, Stdio};

const USAGE: &str = "usage: tramecli open <page id | card id | Trame URL>";

/// The kind (`page`, `card`, or unknown for a bare id) and id named by an argument.
fn parse(input: &str) -> Option<(Option<&'static str>, String)> {
    let input = input.trim();
    if let Some(rest) = input.strip_prefix("trame://") {
        let (kind, id) = rest.split_once('/')?;
        let kind = match kind {
            "page" => "page",
            "card" | "session" => "card",
            _ => return None,
        };
        let id = id.split(['?', '#', '/']).next()?;
        return parse_session_ref(id).map(|r| (Some(kind), r.id));
    }
    let reference = parse_session_ref(input)?;
    let kind = match reference.kind {
        RefKind::Page => Some("page"),
        RefKind::Session if input.contains('?') => Some("card"),
        RefKind::Session => None,
    };
    Some((kind, reference.id))
}

/// Whether an installed app handles `trame://` links.
fn scheme_installed() -> bool {
    if cfg!(target_os = "macos") {
        return Command::new("open")
            .args(["-Ra", "Trame"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
    }
    Command::new("xdg-mime")
        .args(["query", "default", "x-scheme-handler/trame"])
        .stderr(Stdio::null())
        .output()
        .is_ok_and(|o| o.status.success() && !o.stdout.trim_ascii().is_empty())
}

fn launch(url: &str) -> bool {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    Command::new(opener)
        .arg(url)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

pub async fn main(args: &[String]) -> Result<i32> {
    let Some((kind, id)) = args.first().and_then(|a| parse(a)) else {
        bail!(USAGE);
    };
    if let Some(target) = local_target().await? {
        let key = kind.map_or("id".to_owned(), |k| format!("{k}_id"));
        let value = match target.post("/api/open", &json!({key: id})).await {
            Ok(value) => value,
            Err(error) => {
                if let Some(RequestFailure::Http { status: 404, .. }) = error.downcast_ref() {
                    bail!("no page or card with id {id}");
                }
                return Err(error);
            }
        };
        println!("{}", value["url"].as_str().unwrap_or_default());
        if value["opened"] == true {
            return Ok(0);
        }
        eprintln!("the Trame backend runs without its desktop window; open the URL in a browser");
        return Ok(1);
    }
    // a bare id is a card, as for `tramecli show`
    let url = format!("trame://{}/{id}", kind.unwrap_or("card"));
    println!("{url}");
    if scheme_installed() && launch(&url) {
        return Ok(0);
    }
    eprintln!("Trame app is not running; nothing to open it in");
    Ok(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "0b5c1d2e-3f40-4a51-8b62-7c83d94ea5f6";
    #[test]
    fn parses_ids_app_urls_and_scheme_links() {
        for (input, expected) in [
            (ID.to_owned(), Some((None, ID))),
            (
                format!("http://127.0.0.1:8787/?page={ID}"),
                Some((Some("page"), ID)),
            ),
            (
                format!("http://127.0.0.1:8787/?view=card&card={ID}"),
                Some((Some("card"), ID)),
            ),
            (format!("trame://page/{ID}"), Some((Some("page"), ID))),
            (format!("trame://card/{ID}/"), Some((Some("card"), ID))),
            (format!("trame://db/{ID}"), None),
            ("not-an-id".to_owned(), None),
        ] {
            assert_eq!(
                parse(&input),
                expected.map(|(k, id)| (k, id.to_owned())),
                "{input}"
            );
        }
    }
}
