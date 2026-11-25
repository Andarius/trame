use super::{BoxFuture, Connector, Field, Message, Spec, Values};
use anyhow::{Result, bail};
use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use std::{env, time::Duration};

const TOKEN: &str = "TELEGRAM_BOT_TOKEN";
const CHAT: &str = "TELEGRAM_CHAT_ID";
// Bot API limit for one message's text
const LIMIT: usize = 4096;

pub const SPEC: Spec = Spec {
    name: "telegram",
    summary: "a Telegram bot messages you (token from @BotFather)",
    fields: &[
        Field {
            key: TOKEN,
            prompt: "Bot token (from @BotFather)",
            secret: true,
            auto: false,
        },
        Field {
            key: CHAT,
            prompt: "Chat id",
            secret: false,
            auto: true,
        },
    ],
    complete,
    build,
};

pub struct Telegram {
    token: String,
    chat_id: String,
}

fn api() -> String {
    env::var("TRAME_TELEGRAM_API").unwrap_or_else(|_| "https://api.telegram.org".into())
}

fn build(values: &Values) -> Option<Box<dyn Connector>> {
    Some(Box::new(Telegram {
        token: values.get(TOKEN)?.clone(),
        chat_id: values.get(CHAT)?.clone(),
    }))
}

async fn call(client: &Client, token: &str, method: &str, body: &Value) -> Result<Value> {
    let mut wait = Duration::from_secs(1);
    for attempt in 1..=3 {
        let res = client
            .post(format!("{}/bot{token}/{method}", api()))
            .json(body)
            .send()
            .await;
        let (status, reply) = match res {
            Ok(r) => (r.status(), r.json::<Value>().await.unwrap_or(Value::Null)),
            Err(_) if attempt < 3 => {
                tokio::time::sleep(wait).await;
                wait *= 2;
                continue;
            }
            Err(_) => bail!("telegram {method}: api.telegram.org is not reachable"),
        };
        if reply["ok"] == true {
            return Ok(reply["result"].clone());
        }
        let retry = status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error();
        if retry && attempt < 3 {
            let after = reply["parameters"]["retry_after"]
                .as_u64()
                .map(Duration::from_secs);
            tokio::time::sleep(after.unwrap_or(wait)).await;
            wait *= 2;
            continue;
        }
        let why = reply["description"].as_str().unwrap_or("no description");
        bail!("telegram {method}: HTTP {} — {why}", status.as_u16());
    }
    unreachable!("the last attempt returns")
}

/// Checks the token and, without a chat id, takes it from the last private `/start`.
fn complete<'a>(client: &'a Client, values: &'a mut Values) -> BoxFuture<'a, Result<()>> {
    Box::pin(async move {
        let token = values.get(TOKEN).cloned().unwrap_or_default();
        let me = call(client, &token, "getMe", &json!({})).await?;
        let bot = me["username"].as_str().unwrap_or("your bot").to_owned();
        if values.contains_key(CHAT) {
            return Ok(());
        }
        let updates = call(client, &token, "getUpdates", &json!({})).await?;
        let chat = updates
            .as_array()
            .into_iter()
            .flatten()
            .rev()
            .map(|u| &u["message"]["chat"])
            .find(|c| c["type"] == "private")
            .and_then(|c| c["id"].as_i64());
        let Some(chat) = chat else {
            bail!(
                "no private message to @{bot} yet: open it in Telegram, send /start, then rerun (or pass --chat-id)"
            );
        };
        values.insert(CHAT.into(), chat.to_string());
        Ok(())
    })
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Telegram HTML, split on line boundaries so no chunk exceeds the limit.
pub fn render(message: &Message) -> Vec<String> {
    let mut lines = vec![format!("<b>{}</b>", esc(&message.title))];
    if let Some(body) = &message.body {
        lines.push(esc(body));
    }
    for group in &message.groups {
        lines.push(String::new());
        lines.push(format!("<b>{}</b>", esc(&group.heading)));
        for entry in &group.entries {
            // Telegram only links http(s)/tg URLs; others are shown as copyable code
            let link = match &entry.link {
                Some(l) if l.starts_with("http") => format!(" <a href=\"{}\">↗</a>", esc(l)),
                Some(l) => format!(" <code>{}</code>", esc(l)),
                None => String::new(),
            };
            lines.push(format!("{}{link}", esc(&entry.label)));
            lines.extend(entry.lines.iter().map(|l| esc(l)));
        }
    }
    let mut chunks = vec![String::new()];
    for line in lines {
        let line: String = line.chars().take(LIMIT - 1).collect();
        let last = chunks.last_mut().expect("one chunk");
        if !last.is_empty() && last.chars().count() + line.chars().count() + 1 > LIMIT {
            chunks.push(line);
        } else {
            if !last.is_empty() {
                last.push('\n');
            }
            last.push_str(&line);
        }
    }
    chunks
}

impl Connector for Telegram {
    fn name(&self) -> &'static str {
        "telegram"
    }

    fn send<'a>(&'a self, client: &'a Client, message: &'a Message) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            for text in render(message) {
                call(
                    client,
                    &self.token,
                    "sendMessage",
                    &json!({"chat_id": self.chat_id, "text": text, "parse_mode": "HTML",
                            "link_preview_options": {"is_disabled": true}}),
                )
                .await?;
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::{Entry, Group};

    #[test]
    fn render_escapes_links_and_splits() {
        let message = Message {
            title: "Due <today>".into(),
            body: None,
            groups: vec![Group {
                heading: "Soren".into(),
                entries: vec![Entry {
                    label: "[active] Rotate & renew".into(),
                    link: Some("trame://card/c-1".into()),
                    lines: vec!["⚑ rotate (2 days late)".into()],
                }],
            }],
        };
        assert_eq!(
            render(&message),
            vec![
                "<b>Due &lt;today&gt;</b>\n\n<b>Soren</b>\n[active] Rotate &amp; renew <code>trame://card/c-1</code>\n⚑ rotate (2 days late)"
            ]
        );
        let long = Message {
            title: "t".into(),
            body: None,
            groups: vec![Group {
                heading: "g".into(),
                entries: (0..300)
                    .map(|i| Entry {
                        label: format!("entry {i:03} {}", "x".repeat(40)),
                        link: None,
                        lines: vec![],
                    })
                    .collect(),
            }],
        };
        let chunks = render(&long);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|c| c.chars().count() <= LIMIT));
        assert_eq!(
            chunks
                .iter()
                .map(|c| c.matches("entry ").count())
                .sum::<usize>(),
            300
        );
    }
}
