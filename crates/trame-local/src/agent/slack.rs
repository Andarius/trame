pub(super) mod api;
#[cfg(test)]
mod e2e;
pub(crate) mod own;

#[cfg(test)]
use std::{collections::HashMap, sync::Mutex};
use std::{
    env,
    fmt::Write as _,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use tokio::fs;

use self::api::Bot;
use super::connector::{Progress, protocol::Status};

const EVENT_AGE: u64 = 24 * 60 * 60;
const STOP: &str = "trame_stop_turn";

pub(super) struct Config {
    pub(super) app_token: String,
    pub(super) bot_token: String,
    pub(super) team: String,
    pub(super) access: Access,
}

/// Who may start runs, and where.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Access {
    /// the shared @Trame app: one user, in one channel
    Channel { channel: String, user: String },
    /// a bot's own app: in any channel it is in, from these users or anyone but bots
    Anywhere {
        /// its app id, which keys its events in the ledger once known
        app: Option<String>,
        allowed: Vec<String>,
        anyone: bool,
    },
}

impl Access {
    fn admits(&self, channel: &Value, user: &Value) -> bool {
        let (Some(channel), Some(user)) = (channel.as_str(), user.as_str()) else {
            return false;
        };
        match self {
            Self::Channel {
                channel: c,
                user: u,
            } => channel == c && user == u,
            Self::Anywhere {
                allowed, anyone, ..
            } => {
                slack_id(channel, "CGD")
                    && slack_id(user, "UW")
                    && (*anyone || allowed.iter().any(|a| a == user))
            }
        }
    }
}

impl Config {
    pub(super) async fn load() -> Result<Option<Self>> {
        if env::var_os("TRAME_SLACK_APP_TOKEN_FILE").is_none()
            && env::var_os("TRAME_SLACK_BOT_TOKEN_FILE").is_none()
        {
            return Ok(None);
        }
        let team = setting("TRAME_SLACK_TEAM")?;
        let channel = setting("TRAME_SLACK_CHANNEL")?;
        let user = setting("TRAME_SLACK_USER")?;
        ensure!(
            slack_id(&team, "T"),
            "TRAME_SLACK_TEAM must be a workspace ID"
        );
        ensure!(
            slack_id(&channel, "CG"),
            "TRAME_SLACK_CHANNEL must be a channel ID"
        );
        ensure!(slack_id(&user, "UW"), "TRAME_SLACK_USER must be a user ID");

        Ok(Some(Self {
            app_token: token("TRAME_SLACK_APP_TOKEN_FILE", "xapp-").await?,
            bot_token: token("TRAME_SLACK_BOT_TOKEN_FILE", "xoxb-").await?,
            team,
            access: Access::Channel { channel, user },
        }))
    }
}

fn setting(name: &str) -> Result<String> {
    env::var(name).with_context(|| format!("{name} is required for the Slack bridge"))
}

/// The token in the private file env `name` points to; it must start with `prefix`.
#[allow(
    clippy::verbose_bit_mask,
    reason = "use the Unix group and other access bits"
)]
pub(super) async fn token(name: &str, prefix: &str) -> Result<String> {
    let path = PathBuf::from(setting(name)?);
    ensure!(path.is_absolute(), "{name} must be an absolute path");
    let metadata = fs::symlink_metadata(&path)
        .await
        .map_err(|_| anyhow::anyhow!("could not inspect {name}"))?;
    ensure!(
        metadata.is_file() && metadata.permissions().mode() & 0o077 == 0 && metadata.len() <= 4096,
        "{name} must point to a private token file"
    );
    let contents = fs::read_to_string(path)
        .await
        .map_err(|_| anyhow::anyhow!("could not read {name}"))?;
    let token = contents.trim();
    ensure!(token_shape(token, prefix), "{name} holds an invalid token");
    Ok(token.to_owned())
}

/// Whether `token` looks like a Slack token starting with `prefix`.
pub(super) fn token_shape(token: &str, prefix: &str) -> bool {
    token.len() <= 512
        && token.strip_prefix(prefix).is_some_and(|suffix| {
            !suffix.is_empty()
                && suffix
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        })
}

pub(super) fn slack_id(id: &str, prefixes: &str) -> bool {
    id.len() > 1
        && id.len() <= 32
        && id.starts_with(|c| prefixes.contains(c))
        && id
            .bytes()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

pub(super) fn timestamp(ts: &str) -> bool {
    ts.split_once('.').is_some_and(|(seconds, fraction)| {
        !seconds.is_empty()
            && seconds.len() <= 12
            && fraction.len() == 6
            && seconds
                .bytes()
                .chain(fraction.bytes())
                .all(|c| c.is_ascii_digit())
    })
}

pub(super) struct Mention {
    /// the ledger key: the event id, after its app id for a bot's own app
    pub(super) event_id: String,
    pub(super) channel: String,
    pub(super) user: String,
    pub(super) event_time: u64,
    pub(super) thread: String,
    pub(super) text: String,
}

pub(super) struct Stop {
    pub(super) button: String,
    pub(super) channel: String,
    pub(super) message: String,
}

pub(super) enum Input {
    Mention(Mention),
    Stop(Stop),
}

fn parse_event(config: &Config, bot: &Bot, frame: &Value) -> Option<Input> {
    let payload = &frame["payload"];
    match frame["type"].as_str()? {
        "events_api" => {
            let event = &payload["event"];
            if payload["type"] != "event_callback"
                || payload["team_id"] != config.team
                || event["type"] != "app_mention"
                || !config.access.admits(&event["channel"], &event["user"])
                || !event["bot_id"].is_null()
                || !event["subtype"].is_null()
            {
                return None;
            }
            let event_id = payload["event_id"].as_str()?;
            let suffix = event_id.strip_prefix("Ev")?;
            if suffix.is_empty()
                || suffix.len() > 32
                || !suffix
                    .bytes()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
            {
                return None;
            }
            let event_id = match &config.access {
                Access::Channel { .. } => event_id.to_owned(),
                // event ids are per app: key them by the app's
                Access::Anywhere { app, .. } => {
                    let sent = payload["api_app_id"]
                        .as_str()
                        .filter(|a| slack_id(a, "A"))?;
                    if app.as_deref().is_some_and(|a| a != sent) {
                        return None;
                    }
                    format!("{sent}:{event_id}")
                }
            };
            let thread = event["thread_ts"]
                .as_str()
                .or_else(|| event["ts"].as_str())?;
            if !timestamp(thread) {
                return None;
            }
            let text = event["text"].as_str()?;
            let mention = format!("<@{}>", bot.user);
            if text.len() > 64 * 1024 || !text.contains(&mention) {
                return None;
            }
            let text = text.replacen(&mention, "", 1);
            let text = text.trim();
            let (channel, user) = (event["channel"].as_str()?, event["user"].as_str()?);
            (!text.is_empty()).then(|| {
                Input::Mention(Mention {
                    event_id,
                    channel: channel.to_owned(),
                    user: user.to_owned(),
                    event_time: payload["event_time"].as_u64().unwrap_or_default(),
                    thread: thread.to_owned(),
                    text: text
                        .replace("&lt;", "<")
                        .replace("&gt;", ">")
                        .replace("&amp;", "&"),
                })
            })
        }
        "interactive" => {
            let container = &payload["container"];
            let actions = payload["actions"].as_array()?;
            let [action] = actions.as_slice() else {
                return None;
            };
            if payload["type"] != "block_actions"
                || payload["team"]["id"] != config.team
                || !config
                    .access
                    .admits(&payload["channel"]["id"], &payload["user"]["id"])
                || !matches!(
                    container["type"].as_str(),
                    Some("message" | "message_attachment")
                )
                || container["is_ephemeral"] == true
                || container["is_app_unfurl"] == true
                || container["channel_id"] != payload["channel"]["id"]
                || payload["message"]["bot_id"] != bot.id
                || payload["message"]["ts"] != container["message_ts"]
                || action["type"] != "button"
                || action["action_id"] != STOP
            {
                return None;
            }
            let button = action["value"].as_str()?;
            let message = container["message_ts"].as_str()?;
            let channel = container["channel_id"].as_str()?;
            (button.len() == 32
                && timestamp(message)
                && button.bytes().all(|c| c.is_ascii_hexdigit()))
            .then(|| {
                Input::Stop(Stop {
                    button: button.to_owned(),
                    channel: channel.to_owned(),
                    message: message.to_owned(),
                })
            })
        }
        _ => None,
    }
}

/// Claims `(event_id, event_time, oldest kept)`: true for the first claim of an event; blocking.
type Claims = Arc<dyn Fn(&str, u64, u64) -> Result<bool> + Send + Sync>;

/// The Slack events this machine already acted on, in its `slack_events` table.
#[derive(Clone)]
pub(super) struct Ledger {
    claims: Claims,
}

impl Ledger {
    pub(super) fn db(native: &crate::routes::Native) -> Self {
        let native = native.clone();
        Self {
            claims: Arc::new(move |event, time, oldest| {
                let mut db = crate::db::Db::connect(
                    &native.root.join("socket"),
                    &native.origin,
                    Some(native.settings.clone()),
                )?;
                db.query(
                    "delete from slack_events where event_time < $1",
                    &[json!(oldest)],
                )?;
                let claimed = db.query(
                    "insert into slack_events (event_id, event_time) values ($1, $2)
                     on conflict (event_id) do nothing returning event_id",
                    &[json!(event), json!(time)],
                )?;
                Ok(!claimed.is_empty())
            }),
        }
    }

    #[cfg(test)]
    pub(super) fn memory() -> Self {
        let seen = Mutex::new(HashMap::<String, u64>::new());
        Self {
            claims: Arc::new(move |event, time, oldest| {
                let mut seen = seen.lock().unwrap();
                seen.retain(|_, t| *t >= oldest);
                Ok(seen.insert(event.to_owned(), time).is_none())
            }),
        }
    }

    /// Record the claim before launching so an accepted retry never starts a second run.
    pub(super) async fn claim(&self, mention: &Mention) -> Result<bool> {
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        let oldest = now.saturating_sub(EVENT_AGE);
        if !(oldest..=now.saturating_add(60)).contains(&mention.event_time) {
            return Ok(false);
        }
        let (claims, event, time) = (
            self.claims.clone(),
            mention.event_id.clone(),
            mention.event_time,
        );
        tokio::task::spawn_blocking(move || claims(&event, time, oldest)).await?
    }
}

/// The thread card in `mention`'s thread for `bot`'s run on `progress.machine`; `message` edits a
/// posted one.
pub(super) fn status_card(
    mention: &Mention,
    bot: &str,
    progress: &Progress,
    button: &str,
    message: Option<&str>,
) -> Value {
    let host = progress
        .machine
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let summary = if progress.waiting {
        format!("{bot} is waiting for {}", progress.machine)
    } else {
        progress.status.summary(bot)
    };
    let mut context = format!("Asked by <@{}> · {bot} on {host}", mention.user);
    if let Some(link) = &progress.link {
        let _ = write!(context, " · <{link}|Open in Trame>");
    }
    let mut blocks = vec![
        json!({"type":"section","text":{"type":"plain_text","text":summary}}),
        json!({"type":"context","elements":[{"type":"mrkdwn","text":context}]}),
    ];
    if !progress.waiting && matches!(progress.status, Status::Working | Status::NeedsUser) {
        blocks.push(json!({"type":"actions","elements":[{
            "type":"button","text":{"type":"plain_text","text":"Stop"},
            "action_id":STOP,"value":button,
        }]}));
    }
    let mut body = json!({"channel":mention.channel,"text":summary,"blocks":blocks});
    if let Some(ts) = message {
        body["ts"] = json!(ts);
    } else {
        body["thread_ts"] = json!(mention.thread);
        body["unfurl_links"] = json!(false);
        body["unfurl_media"] = json!(false);
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    const THREAD: &str = "1750000000.001230";
    const MESSAGE: &str = "1750000001.000320";
    const BUTTON: &str = "f98544ccc0334e168f6c22bebb0d5ef4";

    fn config() -> Config {
        Config {
            app_token: String::new(),
            bot_token: String::new(),
            team: "T1".into(),
            access: Access::Channel {
                channel: "C1".into(),
                user: "U1".into(),
            },
        }
    }

    fn bot() -> Bot {
        Bot {
            user: "U2".into(),
            id: "B1".into(),
        }
    }

    #[test]
    fn mentions_require_the_configured_origin_and_bot() {
        let config = config();
        let bot = bot();
        let frame = json!({
            "type":"events_api",
            "payload":{
                "type":"event_callback","team_id":"T1","event_id":"Ev1","event_time":1_750_000_002,
                "event":{"type":"app_mention","channel":"C1","user":"U1","bot_id":null,"text":"<@U2> Read &lt;this&gt;",
                    "ts":MESSAGE,"thread_ts":THREAD,"cwd":"/untrusted"},
            },
        });
        let Some(Input::Mention(mention)) = parse_event(&config, &bot, &frame) else {
            panic!("authorized mention was rejected");
        };
        assert_eq!(mention.thread, THREAD);
        assert_eq!(mention.event_id, "Ev1");
        assert_eq!(mention.text, "Read <this>");
        for (path, value) in [
            ("/payload/team_id", json!("T3")),
            ("/payload/event/user", json!("U3")),
            ("/payload/event/channel", json!("C3")),
            ("/payload/event/bot_id", json!("B2")),
            ("/payload/event/text", json!("<@U3> Read")),
            ("/payload/event/text", json!("<@U2>")),
        ] {
            let mut frame = frame.clone();
            *frame.pointer_mut(path).unwrap_or_else(|| panic!("{path}")) = value;
            assert!(parse_event(&config, &bot, &frame).is_none(), "{path}");
        }
    }

    #[test]
    fn a_bots_own_app_hears_its_people_in_any_channel() {
        let bot = bot();
        let frame = |user: &str, channel: &str, bot_id: Value| {
            json!({"type":"events_api","payload":{
                "type":"event_callback","team_id":"T1","api_app_id":"A1","event_id":"Ev1","event_time":1,
                "event":{"type":"app_mention","channel":channel,"user":user,"bot_id":bot_id,
                    "text":"<@U2> with codex: go","ts":MESSAGE},
            }})
        };
        let own = |allowed: &[&str], anyone, app: Option<&str>| Config {
            access: Access::Anywhere {
                app: app.map(str::to_owned),
                allowed: allowed.iter().map(|u| (*u).to_owned()).collect(),
                anyone,
            },
            ..config()
        };
        for (config, user, channel, bot_id, heard) in [
            (own(&["U1"], false, None), "U1", "C9", Value::Null, true),
            (
                own(&["U1"], false, Some("A1")),
                "U1",
                "G9",
                Value::Null,
                true,
            ),
            (own(&["U1"], false, None), "U3", "C1", Value::Null, false),
            (own(&[], true, None), "U3", "C9", Value::Null, true),
            (own(&[], true, None), "U3", "C9", json!("B7"), false),
            (
                own(&["U1"], false, Some("A2")),
                "U1",
                "C1",
                Value::Null,
                false,
            ),
        ] {
            let parsed = parse_event(&config, &bot, &frame(user, channel, bot_id));
            assert_eq!(parsed.is_some(), heard, "{user} in {channel}");
            if let Some(Input::Mention(m)) = parsed {
                assert_eq!(
                    (m.event_id.as_str(), m.channel.as_str()),
                    ("A1:Ev1", channel)
                );
                assert_eq!(m.text, "with codex: go");
            }
        }
    }

    #[test]
    fn stop_requires_the_posting_bot_and_the_configured_origin() {
        let config = config();
        let bot = bot();
        let frame = json!({
            "type":"interactive",
            "payload":{
                "type":"block_actions","team":{"id":"T1"},"user":{"id":"U1"},
                "channel":{"id":"C1"},
                "container":{"type":"message","channel_id":"C1","message_ts":MESSAGE,"is_ephemeral":false},
                "message":{"ts":MESSAGE,"bot_id":"B1"},
                "actions":[{"action_id":STOP,"type":"button","value":BUTTON}],
            },
        });
        let Some(Input::Stop(stop)) = parse_event(&config, &bot, &frame) else {
            panic!("authorized action was rejected");
        };
        assert_eq!(stop.button, BUTTON);
        assert_eq!(stop.message, MESSAGE);
        for (path, value) in [
            ("/payload/team/id", json!("T2")),
            ("/payload/user/id", json!("U3")),
            ("/payload/channel/id", json!("C2")),
            ("/payload/container/channel_id", json!("C2")),
            ("/payload/container/message_ts", json!(THREAD)),
            ("/payload/container/is_ephemeral", json!(true)),
            ("/payload/message/bot_id", json!("B2")),
            ("/payload/actions/0/action_id", json!("another_button")),
            ("/payload/actions/0/value", json!("wrong_opaque_value")),
        ] {
            let mut frame = frame.clone();
            *frame.pointer_mut(path).unwrap_or_else(|| panic!("{path}")) = value;
            assert!(parse_event(&config, &bot, &frame).is_none(), "{path}");
        }
    }

    #[tokio::test]
    async fn an_event_is_claimed_once_and_only_while_recent() -> Result<()> {
        let ledger = Ledger::memory();
        let event_time = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        let mut mention = Mention {
            event_id: "Ev1".into(),
            channel: "C1".into(),
            user: "U1".into(),
            event_time,
            thread: THREAD.into(),
            text: "synthetic".into(),
        };
        assert!(ledger.claim(&mention).await?);
        assert!(!ledger.claim(&mention).await?);
        "Ev2".clone_into(&mut mention.event_id);
        mention.event_time = event_time - EVENT_AGE - 1;
        assert!(!ledger.claim(&mention).await?);
        Ok(())
    }

    #[test]
    fn the_card_offers_stop_only_while_a_turn_runs() {
        let mention = Mention {
            event_id: "Ev1".into(),
            channel: "C1".into(),
            user: "U1".into(),
            event_time: 0,
            thread: THREAD.into(),
            text: "synthetic".into(),
        };
        let progress = |waiting, status| Progress {
            machine: "m1".into(),
            waiting,
            status,
            run: None,
            epoch: None,
            link: Some("http://127.0.0.1:1354/open-agent/fixture".into()),
        };
        for (waiting, status, text, blocks) in [
            (true, Status::Starting, "fixture-bot is waiting for m1", 2),
            (false, Status::NeedsUser, "fixture-bot needs your input", 3),
            (false, Status::Completed, "fixture-bot finished", 2),
            (false, Status::Failed, "fixture-bot failed", 2),
        ] {
            let card = status_card(
                &mention,
                "fixture-bot",
                &progress(waiting, status),
                BUTTON,
                None,
            );
            assert_eq!(card["thread_ts"], THREAD);
            assert_eq!(card["text"], text);
            assert_eq!(card["blocks"].as_array().map(Vec::len), Some(blocks));
            assert!(card.to_string().contains("fixture-bot on m1"));
        }
    }
}
