use std::{sync::Arc, time::Duration};

use futures_util::{SinkExt, StreamExt};
use reqwest::{Client, Response, Url};
use serde_json::{Value, json};
use tokio::{
    sync::{Mutex, mpsc},
    time::{Instant, sleep, sleep_until, timeout},
};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use super::{Config, Input, parse_event, slack_id};

const TIMEOUT: Duration = Duration::from_secs(15);

pub(in crate::agent) struct Api {
    config: Arc<Config>,
    client: Client,
    endpoint: String,
    next_message: Mutex<Instant>,
    /// pause between two posts, under Slack's one message per second
    gap: Duration,
}

pub(in crate::agent) struct Bot {
    pub(super) user: String,
    pub(super) id: String,
}

#[derive(Clone, Copy)]
enum Failure {
    RateLimited(Duration),
    Temporary,
    Rejected,
}

impl Api {
    pub(in crate::agent) fn new(config: Arc<Config>) -> anyhow::Result<Self> {
        Ok(Self {
            config,
            client: Client::builder()
                .timeout(TIMEOUT)
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            endpoint: "https://slack.com/api/".into(),
            next_message: Mutex::new(Instant::now()),
            gap: Duration::from_millis(1250),
        })
    }

    #[cfg(test)]
    pub(in crate::agent) fn with_test_endpoint(mut self, address: std::net::SocketAddr) -> Self {
        assert!(address.ip().is_loopback());
        self.endpoint = format!("http://{address}/api/");
        self.gap = Duration::from_millis(20);
        self
    }

    async fn call(&self, method: &str, token: &str, body: &Value) -> Result<Value, Failure> {
        let response = self
            .client
            .post(format!("{}{method}", self.endpoint))
            .bearer_auth(token)
            .json(body)
            .send()
            .await
            .map_err(|_| Failure::Temporary)?;
        if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(Failure::RateLimited(retry_after(&response)));
        }
        if !response.status().is_success() {
            return Err(if response.status().is_server_error() {
                Failure::Temporary
            } else {
                Failure::Rejected
            });
        }
        let body: Value = response.json().await.map_err(|_| Failure::Temporary)?;
        match (body["ok"].as_bool(), body["error"].as_str()) {
            (Some(true), _) => Ok(body),
            (_, Some("ratelimited" | "rate_limited")) => {
                Err(Failure::RateLimited(Duration::from_secs(60)))
            }
            (
                _,
                Some("internal_error" | "fatal_error" | "service_unavailable" | "request_timeout"),
            ) => Err(Failure::Temporary),
            _ => Err(Failure::Rejected),
        }
    }

    async fn authenticate(&self) -> Result<Bot, Failure> {
        let body = self
            .call("auth.test", &self.config.bot_token, &json!({}))
            .await?;
        if body["team_id"] != self.config.team {
            return Err(Failure::Rejected);
        }
        let (Some(user), Some(id)) = (body["user_id"].as_str(), body["bot_id"].as_str()) else {
            return Err(Failure::Rejected);
        };
        if !slack_id(user, "UW") || !slack_id(id, "B") {
            return Err(Failure::Rejected);
        }
        Ok(Bot {
            user: user.to_owned(),
            id: id.to_owned(),
        })
    }

    pub(in crate::agent) async fn message(&self, body: &Value, update: bool) -> Option<Value> {
        let method = if update {
            "chat.update"
        } else {
            "chat.postMessage"
        };
        for attempt in 0..4 {
            let response = {
                let mut next = self.next_message.lock().await;
                sleep_until(*next).await;
                let response = self.call(method, &self.config.bot_token, body).await;
                let wait = match response {
                    Err(Failure::RateLimited(wait)) => wait,
                    _ => self.gap,
                };
                *next = Instant::now() + wait;
                response
            };
            match response {
                Ok(response) => return Some(response),
                Err(Failure::RateLimited(_)) => {}
                Err(Failure::Temporary) if update => sleep(backoff(attempt)).await,
                _ => break,
            }
        }
        eprintln!("Slack {method} failed");
        None
    }

    pub(in crate::agent) async fn listen(&self, input: &mpsc::Sender<Input>) {
        let mut attempt = 0;
        let bot = loop {
            let wait = match self.authenticate().await {
                Ok(bot) => break bot,
                Err(Failure::Rejected) => {
                    eprintln!("Slack auth.test failed");
                    return;
                }
                Err(Failure::Temporary) => backoff(attempt),
                Err(Failure::RateLimited(wait)) => wait,
            };
            attempt = attempt.saturating_add(1);
            sleep(wait).await;
        };
        let mut attempt = 0;
        loop {
            let opened_at = Instant::now();
            let wait = match self.socket(input, &bot).await {
                Ok(()) | Err(Failure::Temporary) => backoff(attempt),
                Err(Failure::RateLimited(wait)) => wait,
                Err(Failure::Rejected) => {
                    eprintln!("Slack apps.connections.open failed");
                    return;
                }
            };
            attempt = if opened_at.elapsed() >= Duration::from_secs(60) {
                0
            } else {
                attempt.saturating_add(1)
            };
            sleep(wait).await;
        }
    }

    async fn socket(&self, input: &mpsc::Sender<Input>, bot: &Bot) -> Result<(), Failure> {
        let response = self
            .call("apps.connections.open", &self.config.app_token, &json!({}))
            .await?;
        let url = response["url"]
            .as_str()
            .and_then(|url| {
                #[cfg(test)]
                if self.endpoint.starts_with("http://") {
                    let url = Url::parse(url).ok()?;
                    let mut origin = Url::parse(&self.endpoint).ok()?;
                    origin.set_scheme("ws").ok()?;
                    return (url.origin() == origin.origin()
                        && url.username().is_empty()
                        && url.password().is_none())
                    .then_some(url);
                }
                socket_url(url)
            })
            .ok_or(Failure::Rejected)?;
        let (mut ws, _) = timeout(TIMEOUT, connect_async(url.as_str()))
            .await
            .map_err(|_| Failure::Temporary)?
            .map_err(|_| Failure::Temporary)?;
        loop {
            let frame = timeout(Duration::from_secs(90), ws.next())
                .await
                .map_err(|_| Failure::Temporary)?;
            let Some(frame) = frame else { return Ok(()) };
            let frame = frame.map_err(|_| Failure::Temporary)?;
            let reply = match frame {
                Message::Text(text) => {
                    let Ok(frame) = serde_json::from_str::<Value>(&text) else {
                        continue;
                    };
                    if frame["type"] == "disconnect" {
                        return Ok(());
                    }
                    let Some(id) = frame["envelope_id"].as_str().filter(|s| s.len() <= 128) else {
                        continue;
                    };
                    if let Some(event) = parse_event(&self.config, bot, &frame)
                        && input.try_send(event).is_err()
                    {
                        continue;
                    }
                    Message::Text(json!({"envelope_id":id}).to_string().into())
                }
                Message::Ping(bytes) => Message::Pong(bytes),
                Message::Close(_) => return Ok(()),
                _ => continue,
            };
            timeout(Duration::from_secs(2), ws.send(reply))
                .await
                .map_err(|_| Failure::Temporary)?
                .map_err(|_| Failure::Temporary)?;
        }
    }
}

fn backoff(attempt: u32) -> Duration {
    let cap = 1000u64 << attempt.min(5);
    let random = u64::from(uuid::Uuid::new_v4().as_bytes()[0]);
    Duration::from_millis(cap * (192 + random / 2) / 256)
}

fn retry_after(response: &Response) -> Duration {
    Duration::from_secs(
        response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|seconds| (1..=86_400).contains(seconds))
            .unwrap_or(60),
    )
}

fn socket_url(url: &str) -> Option<Url> {
    let url = Url::parse(url).ok()?;
    let host = url.host_str()?;
    (url.scheme() == "wss"
        && host.ends_with(".slack.com")
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none())
    .then_some(url)
}

#[cfg(test)]
mod tests {
    use super::socket_url;

    #[test]
    fn socket_only_connects_to_slack_over_tls() {
        for (url, supported) in [
            ("wss://wss-primary.slack.com/link/?ticket=fixture", true),
            ("ws://wss-primary.slack.com/link/", false),
            ("wss://slack.com.example.org/", false),
            ("wss://user@wss.slack.com/", false),
            ("wss://wss.slack.com:8443/", false),
        ] {
            assert_eq!(socket_url(url).is_some(), supported, "{url}");
        }
    }
}
