//! A bot's own Slack app (a real `@name` in Slack): its tokens in `agent_bot_slack`, its manifest,
//! its routes, and the registry holding one Socket Mode listener per connected bot.

use std::{
    collections::HashMap,
    fmt::Write as _,
    sync::{Arc, OnceLock},
};

use anyhow::Result;
use axum::{http::Method, response::Response};
use serde_json::{Value, json};
use tokio::{sync::Mutex, task::JoinHandle};

use super::{
    Access, Config, Ledger,
    api::{self, Api, Identity},
    slack_id, token_shape,
};
use crate::agent::{
    bots::{self, Bot},
    connector::{Connector, Own, hold_slack},
    db_failed, with_db,
};
use crate::{db::Db, routes::Native, routes::json_response};

/// Who may ask a bot app, at most.
const MAX_ALLOWED: usize = 50;
const COLUMNS: &str = "b.id::text as bot, b.name, b.slack, s.team_id, s.team_name, s.app_id,
    s.bot_user_id, s.bot_user_name, s.bot_id_slack, s.app_token, s.bot_token, s.allowed, s.anyone";

/// A connected bot app as stored, with its bot's name and Slack switch.
#[derive(Clone, PartialEq, Eq)]
pub(in crate::agent) struct Stored {
    pub bot: String,
    pub name: String,
    pub slack: bool,
    pub team: String,
    pub team_name: String,
    pub app: Option<String>,
    pub bot_user: String,
    pub bot_name: String,
    pub bot_slack: String,
    pub app_token: String,
    pub bot_token: String,
    pub allowed: Vec<String>,
    pub anyone: bool,
}

impl Stored {
    fn from_row(r: &Value) -> Option<Self> {
        let text = |k: &str| r[k].as_str().map(str::to_owned);
        Some(Self {
            bot: text("bot")?,
            name: text("name")?,
            slack: r["slack"] == true,
            team: text("team_id")?,
            team_name: text("team_name")?,
            app: text("app_id"),
            bot_user: text("bot_user_id")?,
            bot_name: text("bot_user_name")?,
            bot_slack: text("bot_id_slack")?,
            app_token: text("app_token")?,
            bot_token: text("bot_token")?,
            allowed: r["allowed"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|u| u.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default(),
            anyone: r["anyone"] == true,
        })
    }
}

fn all(db: &mut Db) -> Result<Vec<Stored>> {
    let rows = db.query(
        &format!("select {COLUMNS} from agent_bot_slack s join agent_bots b on b.id = s.bot_id"),
        &[],
    )?;
    Ok(rows.iter().filter_map(Stored::from_row).collect())
}

fn get(db: &mut Db, bot: &str) -> Result<Option<Stored>> {
    if !bots::valid_id(bot) {
        return Ok(None);
    }
    let rows = db.query(
        &format!(
            "select {COLUMNS} from agent_bot_slack s join agent_bots b on b.id = s.bot_id
              where s.bot_id = $1::uuid"
        ),
        &[json!(bot)],
    )?;
    Ok(rows.first().and_then(Stored::from_row))
}

/// The bot already holding Slack bot user `user`, other than `bot`.
fn holder(db: &mut Db, bot: &str, user: &str) -> Result<Option<String>> {
    let rows = db.query(
        "select b.name from agent_bot_slack s join agent_bots b on b.id = s.bot_id
          where s.bot_user_id = $1 and s.bot_id <> $2::uuid",
        &[json!(user), json!(bot)],
    )?;
    Ok(rows
        .first()
        .and_then(|r| r["name"].as_str())
        .map(str::to_owned))
}

fn save(
    db: &mut Db,
    bot: &str,
    identity: &Identity,
    (app_token, bot_token): (&str, &str),
    (allowed, anyone): &(Vec<String>, bool),
) -> Result<()> {
    db.query(
        "insert into agent_bot_slack (bot_id, team_id, team_name, app_id, bot_user_id, bot_id_slack,
                                      app_token, bot_token, allowed, anyone, bot_user_name)
         values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
         on conflict (bot_id) do update set team_id = excluded.team_id,
           team_name = excluded.team_name, app_id = excluded.app_id,
           bot_user_id = excluded.bot_user_id, bot_user_name = excluded.bot_user_name,
           bot_id_slack = excluded.bot_id_slack,
           app_token = excluded.app_token, bot_token = excluded.bot_token,
           allowed = excluded.allowed, anyone = excluded.anyone",
        &[
            json!(bot),
            json!(identity.team),
            json!(identity.team_name),
            json!(app_id(app_token)),
            json!(identity.user),
            json!(identity.bot),
            json!(app_token),
            json!(bot_token),
            json!(json!(allowed).to_string()),
            json!(anyone),
            json!(identity.user_name),
        ],
    )?;
    Ok(())
}

/// The app id an app-level token names (`xapp-1-A0123…-…`), when it does.
fn app_id(token: &str) -> Option<&str> {
    token.split('-').nth(2).filter(|a| slack_id(a, "A"))
}

/// Who may ask, from `{allowed?, anyone?}` over the `current` answer: Slack member ids, or anyone.
fn who(body: &Value, current: Option<(&[String], bool)>) -> Result<(Vec<String>, bool), String> {
    let anyone = match body.get("anyone") {
        None | Some(Value::Null) => current.is_some_and(|(_, a)| a),
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err("anyone is true or false".into()),
    };
    let mut allowed: Vec<String> = match body.get("allowed") {
        None | Some(Value::Null) => current.map(|(a, _)| a.to_vec()).unwrap_or_default(),
        Some(Value::Array(list)) => list
            .iter()
            .map(|u| {
                u.as_str()
                    .map(str::trim)
                    .filter(|u| slack_id(u, "UW"))
                    .map(str::to_owned)
                    .ok_or_else(|| {
                        format!(
                            "{} is not a Slack member ID (U…)",
                            u.as_str().unwrap_or("a value")
                        )
                    })
            })
            .collect::<Result<_, _>>()?,
        Some(_) => return Err("allowed is a list of Slack member IDs".into()),
    };
    allowed.sort_unstable();
    allowed.dedup();
    if allowed.len() > MAX_ALLOWED {
        return Err(format!("at most {MAX_ALLOWED} members may be listed"));
    }
    if allowed.is_empty() && !anyone {
        return Err("say who may ask: Slack member IDs, or anyone in the workspace".into());
    }
    Ok((allowed, anyone))
}

/// `#rrggbb` of the avatar's hue, dark enough for Slack's white text.
fn color(hue: i64) -> String {
    // hsl(hue 55% 40%)
    let (sat, light) = (0.55_f64, 0.40_f64);
    #[allow(clippy::cast_precision_loss, reason = "a hue is 0-359")]
    let sector = hue.rem_euclid(360) as f64 / 30.0;
    let chroma = sat * light.min(1.0 - light);
    let channel = |offset: f64| {
        let at = (offset + sector) % 12.0;
        let value = light - chroma * (at - 3.0).min(9.0 - at).clamp(-1.0, 1.0);
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "0-255"
        )]
        let byte = (value * 255.0).round() as u8;
        byte
    };
    format!(
        "#{:02x}{:02x}{:02x}",
        channel(0.0),
        channel(8.0),
        channel(4.0)
    )
}

/// The Slack app manifest that makes `bot` its own Slack app.
pub(in crate::agent) fn manifest(bot: &Bot) -> String {
    let hue = bot.hue.unwrap_or_else(|| bots::name_hue(&bot.name));
    let role = bot.role.as_deref().unwrap_or("A Trame bot");
    // a JSON string is a valid YAML double-quoted scalar
    let quote = |s: &str| Value::from(s).to_string();
    format!(
        "display_information:
  name: {name}
  description: {role}
  background_color: \"{color}\"
features:
  bot_user:
    display_name: {name}
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
settings:
  socket_mode_enabled: true
  interactivity:
    is_enabled: true
  event_subscriptions:
    bot_events:
      - app_mention
",
        name = quote(&bot.name),
        role = quote(role),
        color = color(hue),
    )
}

/// The page that creates a Slack app from `yaml`.
pub(in crate::agent) fn manifest_url(yaml: &str) -> String {
    let mut url = String::from("https://api.slack.com/apps?new_app=1&manifest_yaml=");
    for byte in yaml.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
            url.push(char::from(byte));
        } else {
            let _ = write!(url, "%{byte:02X}");
        }
    }
    url
}

/// `xoxb-…1234`: enough to tell two tokens apart.
fn mask(token: &str) -> String {
    let prefix = token.get(..5).unwrap_or_default();
    let tail = token
        .get(token.len().saturating_sub(4)..)
        .unwrap_or_default();
    format!("{prefix}…{tail}")
}

/// What the app shows of `bot`'s own Slack app; never its tokens.
async fn status(bot: &Bot, stored: Option<&Stored>) -> Value {
    let manifest_url = manifest_url(&manifest(bot));
    let Some(s) = stored else {
        return json!({"connected":false,"manifestUrl":manifest_url,"listening":false,"error":null});
    };
    let state = match APPS.get() {
        Some(apps) => apps.state(&s.bot).await,
        None => None,
    };
    json!({
        "connected":true,"team":s.team,"teamName":s.team_name,"botUser":s.bot_user,"botName":s.bot_name,"appId":s.app,
        "allowed":s.allowed,"anyone":s.anyone,
        "appToken":mask(&s.app_token),"botToken":mask(&s.bot_token),
        "listening":state == Some(Ok(())),"error":state.and_then(Result::err),
        "manifestUrl":manifest_url,
    })
}

/// `/api/agent/bots/:id/slack` (app token only): GET its status, PUT `{appToken, botToken,
/// allowed?, anyone?}` connects it once Slack accepts both tokens, PATCH `{allowed?, anyone?}`,
/// DELETE forgets it.
pub(in crate::agent) async fn route(
    native: &Native,
    method: &Method,
    id: &str,
    body: &Value,
) -> Response {
    let owned = id.to_owned();
    let found = with_db(native, move |db| {
        Ok((bots::get(db, &owned)?, get(db, &owned)?))
    })
    .await;
    let Ok((bot, stored)) = found else {
        return db_failed();
    };
    let Some(bot) = bot else {
        return json_response(404, json!({"error":"no such bot"}));
    };
    let bad = |e: String| json_response(400, json!({"error":e}));
    let current = stored.as_ref().map(|s| (s.allowed.as_slice(), s.anyone));
    match *method {
        Method::GET => json_response(200, status(&bot, stored.as_ref()).await),
        Method::PUT => {
            let field = |k: &str| body[k].as_str().map(str::trim).unwrap_or_default();
            let (app_token, bot_token) = (field("appToken"), field("botToken"));
            if !token_shape(app_token, "xapp-") {
                return bad("the app-level token starts with xapp-".into());
            }
            if !token_shape(bot_token, "xoxb-") {
                return bad("the bot token starts with xoxb-".into());
            }
            let who = match who(body, current) {
                Ok(who) => who,
                Err(e) => return bad(e),
            };
            let identity = match api::verify(app_token, bot_token).await {
                Ok(identity) => identity,
                Err(e) => return bad(e),
            };
            let (owned, tokens) = (bot.id.clone(), (app_token.to_owned(), bot_token.to_owned()));
            let saved = with_db(native, move |db| {
                if let Some(other) = holder(db, &owned, &identity.user)? {
                    return Ok(Err(other));
                }
                save(db, &owned, &identity, (&tokens.0, &tokens.1), &who)?;
                // connecting is asking for Slack: the bot's switch turns on with it
                db.query(
                    "update agent_bots set slack = true where id = $1::uuid",
                    &[json!(owned)],
                )?;
                Ok(Ok(get(db, &owned)?))
            })
            .await;
            match saved {
                Ok(Ok(stored)) => {
                    reconcile().await;
                    json_response(200, status(&bot, stored.as_ref()).await)
                }
                Ok(Err(other)) => json_response(
                    409,
                    json!({"error":format!("this Slack app is already {other}'s")}),
                ),
                Err(_) => db_failed(),
            }
        }
        Method::PATCH => {
            if stored.is_none() {
                return json_response(404, json!({"error":"this bot has no Slack app"}));
            }
            let (allowed, anyone) = match who(body, current) {
                Ok(who) => who,
                Err(e) => return bad(e),
            };
            let owned = bot.id.clone();
            let saved = with_db(native, move |db| {
                db.query(
                    "update agent_bot_slack set allowed = $2::jsonb, anyone = $3 where bot_id = $1::uuid",
                    &[json!(owned), json!(json!(allowed).to_string()), json!(anyone)],
                )?;
                get(db, &owned)
            })
            .await;
            match saved {
                Ok(stored) => {
                    reconcile().await;
                    json_response(200, status(&bot, stored.as_ref()).await)
                }
                Err(_) => db_failed(),
            }
        }
        Method::DELETE => {
            let owned = bot.id.clone();
            let removed = with_db(native, move |db| {
                db.query(
                    "delete from agent_bot_slack where bot_id = $1::uuid",
                    &[json!(owned)],
                )
            })
            .await;
            if removed.is_err() {
                return db_failed();
            }
            reconcile().await;
            json_response(200, json!({"ok":true}))
        }
        _ => json_response(404, json!({"error":"not found"})),
    }
}

/// The bot apps' listeners, once this machine holds them (local connector mode).
pub(in crate::agent) static APPS: OnceLock<Arc<Apps>> = OnceLock::new();

/// Bring the listeners in line with the bots: after a bot or its app changed.
pub(in crate::agent) async fn reconcile() {
    if let Some(apps) = APPS.get() {
        apps.reconcile().await;
    }
}

/// Every connected bot app, read on each reconcile (blocking: it reads the database).
pub(in crate::agent) type Load = Arc<dyn Fn() -> Result<Vec<Stored>> + Send + Sync>;

struct Listener {
    stored: Stored,
    task: JoinHandle<()>,
    /// why Slack stopped it, once it did
    stopped: Arc<std::sync::Mutex<Option<&'static str>>>,
}

impl Drop for Listener {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// One Socket Mode listener per bot with its own app and Slack on; its mentions start that bot here.
pub(in crate::agent) struct Apps {
    connector: Arc<Connector>,
    machine: String,
    ledger: Ledger,
    load: Load,
    listeners: Mutex<HashMap<String, Listener>>,
    #[cfg(test)]
    endpoint: Option<std::net::SocketAddr>,
}

impl Apps {
    pub(in crate::agent) fn new(
        connector: Arc<Connector>,
        machine: String,
        ledger: Ledger,
        load: Load,
    ) -> Self {
        Self {
            connector,
            machine,
            ledger,
            load,
            listeners: Mutex::default(),
            #[cfg(test)]
            endpoint: None,
        }
    }

    #[cfg(test)]
    pub(in crate::agent) fn with_test_endpoint(mut self, address: std::net::SocketAddr) -> Self {
        self.endpoint = Some(address);
        self
    }

    pub(in crate::agent) fn db_loader(native: Native) -> Load {
        Arc::new(move || {
            let mut db = Db::connect(
                &native.root.join("socket"),
                &native.origin,
                Some(native.settings.clone()),
            )?;
            all(&mut db)
        })
    }

    /// Start a listener for each connected bot with Slack on and stop the others; a changed one restarts.
    pub(in crate::agent) async fn reconcile(&self) {
        let load = self.load.clone();
        let Ok(Ok(stored)) = tokio::task::spawn_blocking(move || load()).await else {
            return eprintln!("Slack bot apps could not be read");
        };
        let wanted: HashMap<String, Stored> = stored
            .into_iter()
            .filter(|s| s.slack)
            .map(|s| (s.bot.clone(), s))
            .collect();
        let mut listeners = self.listeners.lock().await;
        listeners.retain(|id, l| wanted.get(id) == Some(&l.stored));
        for (id, stored) in wanted {
            if let std::collections::hash_map::Entry::Vacant(slot) = listeners.entry(id) {
                slot.insert(self.spawn(stored));
            }
        }
    }

    /// Ok while bot `id`'s listener runs, why Slack stopped it, or None when it has none.
    pub(in crate::agent) async fn state(&self, id: &str) -> Option<Result<(), &'static str>> {
        let listeners = self.listeners.lock().await;
        let listener = listeners.get(id)?;
        Some(match *listener.stopped.lock().unwrap() {
            Some(why) => Err(why),
            None => Ok(()),
        })
    }

    fn spawn(&self, stored: Stored) -> Listener {
        let stopped = Arc::new(std::sync::Mutex::new(None));
        let config = Arc::new(Config {
            app_token: stored.app_token.clone(),
            bot_token: stored.bot_token.clone(),
            team: stored.team.clone(),
            access: Access::Anywhere {
                app: stored.app.clone(),
                allowed: stored.allowed.clone(),
                anyone: stored.anyone,
            },
        });
        let api = Api::new(config);
        #[cfg(test)]
        let api = match self.endpoint {
            Some(address) => api.map(|a| a.with_test_endpoint(address)),
            None => api,
        };
        let task = if let Ok(api) = api {
            let (connector, ledger, stopped) =
                (self.connector.clone(), self.ledger.clone(), stopped.clone());
            let own = Own {
                machine: self.machine.clone(),
                bot: stored.name.clone(),
            };
            tokio::spawn(async move {
                let why = hold_slack(Arc::new(api), connector, ledger, Some(own)).await;
                *stopped.lock().unwrap() = Some(why);
            })
        } else {
            *stopped.lock().unwrap() = Some("the HTTP client could not be started");
            tokio::spawn(async {})
        };
        Listener {
            stored,
            task,
            stopped,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bot(role: Option<&str>, hue: Option<i64>) -> Bot {
        Bot {
            id: uuid::Uuid::new_v4().to_string(),
            name: "ada".into(),
            provider: crate::agent::run::Provider::Claude,
            cwd: None,
            mode: None,
            model: None,
            effort: None,
            slack: true,
            hook: String::new(),
            role: role.map(str::to_owned),
            face: None,
            hue,
            has_image: false,
            slack_app: None,
        }
    }

    #[test]
    fn the_manifest_names_the_bot_and_asks_for_socket_mode_only() {
        let yaml = manifest(&bot(Some("Reviews \"PRs\": fast"), Some(0)));
        for line in [
            "  name: \"ada\"\n",
            "  description: \"Reviews \\\"PRs\\\": fast\"\n",
            "  background_color: \"#9e2e2e\"\n",
            "    display_name: \"ada\"\n",
            "      - app_mentions:read\n      - chat:write\nsettings:",
            "  socket_mode_enabled: true\n",
            "    bot_events:\n      - app_mention\n",
        ] {
            assert!(yaml.contains(line), "{line} in {yaml}");
        }
        assert!(manifest(&bot(None, Some(120))).contains("\"A Trame bot\""));
        assert!(manifest(&bot(None, Some(120))).contains("\"#2e9e2e\""));
        let url = manifest_url("a: \"b\"\n#c");
        assert_eq!(
            url,
            "https://api.slack.com/apps?new_app=1&manifest_yaml=a%3A%20%22b%22%0A%23c"
        );
    }

    #[test]
    fn who_may_ask_is_member_ids_or_anyone() {
        let some = ["U1".to_owned()];
        for (body, current, want) in [
            (
                json!({"allowed":["U2"," W3 ","U2"]}),
                None,
                Ok((vec!["U2", "W3"], false)),
            ),
            (json!({"anyone":true}), None, Ok((vec![], true))),
            (
                json!({"anyone":false}),
                Some((&some[..], true)),
                Ok((vec!["U1"], false)),
            ),
            (json!({}), None, Err("say who may ask")),
            (
                json!({"allowed":[]}),
                Some((&some[..], false)),
                Err("say who may ask"),
            ),
            (
                json!({"allowed":["@julien"]}),
                None,
                Err("is not a Slack member ID"),
            ),
            (json!({"allowed":"U1"}), None, Err("a list")),
        ] {
            match (who(&body, current), want) {
                (Ok((allowed, anyone)), Ok((want, want_anyone))) => {
                    assert_eq!(
                        (
                            allowed.iter().map(String::as_str).collect::<Vec<_>>(),
                            anyone
                        ),
                        (want, want_anyone)
                    );
                }
                (Err(e), Err(part)) => assert!(e.contains(part), "{e}"),
                (got, _) => panic!("{body}: {got:?}"),
            }
        }
    }

    #[test]
    fn tokens_are_masked_and_name_their_app() {
        assert_eq!(mask("xoxb-1234-5678-abcdefgh"), "xoxb-…efgh");
        assert_eq!(app_id("xapp-1-A0123ABC-99-ff"), Some("A0123ABC"));
        assert_eq!(app_id("xapp-whatever"), None);
    }
}
