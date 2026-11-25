use super::{BoxFuture, Connector, Field, Message, Spec, Values};
use anyhow::{Result, bail};
use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use std::{env, fmt::Write as _, time::Duration};

const TOKEN: &str = "TELEGRAM_BOT_TOKEN";
const CHAT: &str = "TELEGRAM_CHAT_ID";
// sendRichMessage: "Up to 32768 UTF-8 characters"
const LIMIT: usize = 32_768;

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
    call_with(client, token, method, |r| r.json(body)).await
}

/// One Bot API call with 3 attempts; `build` fills each attempt's request.
async fn call_with(
    client: &Client,
    token: &str,
    method: &str,
    build: impl Fn(reqwest::RequestBuilder) -> reqwest::RequestBuilder,
) -> Result<Value> {
    let mut wait = Duration::from_secs(1);
    for attempt in 1..=3 {
        let res = build(client.post(format!("{}/bot{token}/{method}", api())))
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
        .replace('"', "&quot;")
}

/// Escaped text with `code` spans as <code>; a lone backtick stays literal.
fn inline(s: &str) -> String {
    let parts: Vec<&str> = s.split('`').collect();
    let mut out = String::new();
    for (i, part) in parts.iter().enumerate() {
        let closed = i % 2 == 1 && i + 1 < parts.len();
        if closed {
            out.push_str("<code>");
            out.push_str(&esc(part));
            out.push_str("</code>");
        } else {
            if i > 0 && i % 2 == 1 {
                out.push('`');
            }
            out.push_str(&esc(part));
        }
    }
    out
}

/// A rich message (Bot API 10.2 `html` field): heading, body paragraphs, one
/// collapsible section per group, todos as plain list items (a checkbox cannot tick Trame).
pub fn render(message: &Message, image: Option<&str>) -> String {
    let mut html = Vec::new();
    if let Some(id) = image {
        html.push(format!("<img src=\"tg://photo?id={id}\"/>"));
    }
    html.push(format!("<h3>{}</h3>", inline(&message.title)));
    for line in message.body.iter().flat_map(|b| b.lines()) {
        html.push(format!("<p>{}</p>", inline(line)));
    }
    let mut groups = message.groups.iter().peekable();
    while let Some(group) = groups.next() {
        let mut block = format!(
            "<details{}><summary>{}</summary><ul>",
            if group.open { " open" } else { "" },
            inline(&group.heading)
        );
        for entry in &group.entries {
            if entry.lines.is_empty() {
                let _ = write!(block, "<li>{}</li>", inline(&entry.label));
            } else {
                let lines = entry.lines.iter().fold(String::new(), |mut out, l| {
                    let _ = write!(out, "<li>{}</li>", inline(l));
                    out
                });
                let _ = write!(
                    block,
                    "<li><b>{}</b><ul>{lines}</ul></li>",
                    inline(&entry.label)
                );
            }
        }
        block.push_str("</ul></details>");
        let used: usize = html.iter().map(String::len).sum();
        if used + block.len() > LIMIT - 200 {
            html.push(format!(
                "<p>+{} more sections in Trame.</p>",
                groups.count() + 1
            ));
            break;
        }
        html.push(block);
    }
    html.join("\n")
}

/// A multipart/form-data body: text fields, then the optional banner file.
fn multipart(fields: &[(&str, String)], file: Option<(&str, &[u8])>) -> (String, Vec<u8>) {
    let boundary = format!("trame{}", uuid::Uuid::new_v4().simple());
    let mut body = Vec::new();
    for (name, value) in fields {
        body.extend(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .bytes(),
        );
    }
    if let Some((name, bytes)) = file {
        body.extend(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{name}.png\"\r\nContent-Type: image/png\r\n\r\n")
                .bytes(),
        );
        body.extend_from_slice(bytes);
        body.extend(b"\r\n");
    }
    body.extend(format!("--{boundary}--\r\n").bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

impl Connector for Telegram {
    fn name(&self) -> &'static str {
        "telegram"
    }

    fn send<'a>(&'a self, client: &'a Client, message: &'a Message) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let banner = message.image.as_deref();
            let mut rich = json!({"html": render(message, banner.map(|_| "banner"))});
            if banner.is_some() {
                rich["media"] = json!([{"id": "banner", "media": {"type": "photo", "media": "attach://banner"}}]);
            }
            let (content_type, body) = multipart(
                &[
                    ("chat_id", self.chat_id.clone()),
                    ("rich_message", rich.to_string()),
                ],
                banner.map(|b| ("banner", b)),
            );
            call_with(client, &self.token, "sendRichMessage", |r| {
                r.header(reqwest::header::CONTENT_TYPE, &content_type)
                    .body(body.clone())
            })
            .await?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::{Entry, Group};

    #[test]
    fn render_rich_sections_and_code() {
        let message = Message {
            title: "Soren <ops>".into(),
            body: Some("🔴 2 late\n+1 more cards".into()),
            groups: vec![
                Group {
                    heading: "🔴 Rotate keys · 2 late".into(),
                    open: true,
                    entries: vec![Entry {
                        label: "2d late · run `just rotate` & check".into(),
                        link: None,
                        lines: vec![],
                    }],
                },
                Group {
                    heading: "⏸ Paused or done · 1 cards".into(),
                    open: false,
                    entries: vec![Entry {
                        label: "Alerts (paused)".into(),
                        link: None,
                        lines: vec!["restart `the watch".into()],
                    }],
                },
            ],
            image: None,
        };
        assert_eq!(
            render(&message, Some("banner")),
            "<img src=\"tg://photo?id=banner\"/>\n<h3>Soren &lt;ops&gt;</h3>\n<p>🔴 2 late</p>\n<p>+1 more cards</p>\n\
             <details open><summary>🔴 Rotate keys · 2 late</summary><ul><li>2d late · run <code>just rotate</code> &amp; check</li></ul></details>\n\
             <details><summary>⏸ Paused or done · 1 cards</summary><ul><li><b>Alerts (paused)</b><ul><li>restart `the watch</li></ul></li></ul></details>"
        );
    }

    #[test]
    fn render_stops_before_the_size_limit() {
        let group = Group {
            heading: "card".into(),
            open: false,
            entries: (0..40)
                .map(|i| Entry {
                    label: format!("todo {i} {}", "x".repeat(90)),
                    link: None,
                    lines: vec![],
                })
                .collect(),
        };
        let message = Message {
            title: "big".into(),
            groups: vec![group; 20],
            ..Message::default()
        };
        let html = render(&message, None);
        assert!(html.len() <= LIMIT, "{}", html.len());
        assert!(html.ends_with("more sections in Trame.</p>"));
    }
}
