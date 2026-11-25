pub mod telegram;

use anyhow::{Context, Result, bail};
use reqwest::Client;
use std::{
    collections::BTreeMap,
    env, fs,
    future::Future,
    io::{BufRead, IsTerminal, Write},
    os::unix::fs::OpenOptionsExt,
    path::PathBuf,
    pin::Pin,
    process::{Command, Stdio},
    time::Duration,
};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Channel-neutral rich text: connectors render it in their own markup.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Message {
    pub title: String,
    pub body: Option<String>,
    pub groups: Vec<Group>,
    /// a banner image (PNG) shown above the title, where the connector can
    pub image: Option<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Group {
    pub heading: String,
    /// shown expanded where the connector folds groups
    pub open: bool,
    pub entries: Vec<Entry>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub label: String,
    pub link: Option<String>,
    pub lines: Vec<String>,
}

/// One value `connector setup` asks for, stored as `key` in the connectors env file.
pub struct Field {
    pub key: &'static str,
    pub prompt: &'static str,
    pub secret: bool,
    /// `setup` may fill it itself (e.g. Telegram's chat id from `getUpdates`).
    pub auto: bool,
}

pub type Values = BTreeMap<String, String>;

pub trait Connector: Send + Sync {
    fn name(&self) -> &'static str;
    fn send<'a>(&'a self, client: &'a Client, message: &'a Message) -> BoxFuture<'a, Result<()>>;
}

/// A connector kind: what setup asks, how it completes and checks the values, how it is built.
pub struct Spec {
    pub name: &'static str,
    pub summary: &'static str,
    pub fields: &'static [Field],
    pub complete: for<'a> fn(&'a Client, &'a mut Values) -> BoxFuture<'a, Result<()>>,
    pub build: fn(&Values) -> Option<Box<dyn Connector>>,
}

pub const REGISTRY: &[Spec] = &[telegram::SPEC];

pub fn spec(name: &str) -> Result<&'static Spec> {
    REGISTRY.iter().find(|s| s.name == name).ok_or_else(|| {
        anyhow::anyhow!(
            "unknown connector: {name} (known: {})",
            REGISTRY
                .iter()
                .map(|s| s.name)
                .collect::<Vec<_>>()
                .join(", ")
        )
    })
}

pub fn client() -> Result<Client> {
    Ok(Client::builder().timeout(Duration::from_secs(15)).build()?)
}

// Env file

pub fn env_path() -> PathBuf {
    if let Some(path) = env::var_os("TRAME_CONNECTORS_ENV") {
        return PathBuf::from(path);
    }
    let base = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env::var_os("HOME").unwrap_or_default()).join(".config"));
    base.join("trame").join("connectors.env")
}

pub fn parse_env(text: &str) -> Values {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
        .collect()
}

/// The env file, overridden by the process environment (systemd or a shell export).
pub fn load_values() -> Values {
    let mut values = fs::read_to_string(env_path())
        .map(|t| parse_env(&t))
        .unwrap_or_default();
    for spec in REGISTRY {
        for field in spec.fields {
            if let Ok(v) = env::var(field.key) {
                if !v.trim().is_empty() {
                    values.insert(field.key.into(), v.trim().into());
                }
            }
        }
    }
    values
}

/// Writes the env file owner-only (0600), atomically.
pub fn save_values(values: &Values) -> Result<()> {
    let path = env_path();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("env.tmp");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .with_context(|| format!("writing {}", tmp.display()))?;
    let body: String = values
        .iter()
        .map(|(k, v)| {
            [
                k.as_str(),
                "=",
                v,
                "
",
            ]
            .concat()
        })
        .collect();
    file.write_all(format!("# written by `tramecli connector setup`\n{body}").as_bytes())?;
    file.sync_all()?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

/// Connectors whose required values are all present.
pub fn configured(values: &Values) -> Vec<Box<dyn Connector>> {
    REGISTRY.iter().filter_map(|s| (s.build)(values)).collect()
}

pub fn named(values: &Values, names: &[String]) -> Result<Vec<Box<dyn Connector>>> {
    names
        .iter()
        .map(|n| {
            (spec(n)?.build)(values).ok_or_else(|| {
                anyhow::anyhow!("connector {n} is not set up — run `tramecli connector setup {n}`")
            })
        })
        .collect()
}

pub fn test_message() -> Message {
    Message {
        title: "Trame test".into(),
        body: Some("This connector works.".into()),
        groups: Vec::new(),
        image: None,
    }
}

// Commands

fn mask(v: &str) -> String {
    let n = v.chars().count();
    if n <= 6 {
        "•••".into()
    } else {
        format!(
            "{}…{}",
            v.chars().take(3).collect::<String>(),
            v.chars().skip(n - 3).collect::<String>()
        )
    }
}

fn prompt(field: &Field) -> Result<String> {
    let stdin = std::io::stdin();
    let tty = stdin.is_terminal();
    if tty {
        eprint!("{}: ", field.prompt);
        std::io::stderr().flush()?;
    }
    // no echo for secrets: stty keeps this free of unsafe termios calls
    let hide = tty && field.secret;
    if hide {
        let _ = Command::new("stty")
            .arg("-echo")
            .stdin(Stdio::inherit())
            .status();
    }
    let mut line = String::new();
    let read = stdin.lock().read_line(&mut line);
    if hide {
        let _ = Command::new("stty")
            .arg("echo")
            .stdin(Stdio::inherit())
            .status();
        eprintln!();
    }
    read?;
    Ok(line.trim().to_owned())
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

async fn setup(args: &[String]) -> Result<()> {
    let Some(name) = args.first() else {
        bail!(
            "usage: tramecli connector setup <name> (known: {})",
            REGISTRY
                .iter()
                .map(|s| s.name)
                .collect::<Vec<_>>()
                .join(", ")
        );
    };
    let spec = spec(name)?;
    let mut all = fs::read_to_string(env_path())
        .map(|t| parse_env(&t))
        .unwrap_or_default();
    let mut values = Values::new();
    for field in spec.fields {
        // --chat-id style flag, from the key: TELEGRAM_CHAT_ID → --chat-id
        let flag_name = format!(
            "--{}",
            field
                .key
                .split_once('_')
                .map_or(field.key, |(_, rest)| rest)
                .to_lowercase()
                .replace('_', "-")
        );
        let value = match flag(args, &flag_name) {
            Some(v) => v,
            None if field.auto => continue,
            None => prompt(field)?,
        };
        if value.is_empty() {
            bail!("{} is required", field.prompt);
        }
        values.insert(field.key.into(), value);
    }
    let client = client()?;
    (spec.complete)(&client, &mut values).await?;
    let connector =
        (spec.build)(&values).ok_or_else(|| anyhow::anyhow!("{name}: incomplete values"))?;
    connector.send(&client, &test_message()).await?;
    all.extend(values);
    save_values(&all)?;
    println!(
        "{name}: set up, test message sent — saved to {} (mode 600)",
        env_path().display()
    );
    Ok(())
}

fn list() {
    let values = load_values();
    for spec in REGISTRY {
        let state = if (spec.build)(&values).is_some() {
            "set up"
        } else {
            "not set up"
        };
        println!("{:<10} {state:<11} {}", spec.name, spec.summary);
        for field in spec.fields {
            if let Some(v) = values.get(field.key) {
                let shown = if field.secret { mask(v) } else { v.clone() };
                println!("    {} = {shown}", field.key);
            }
        }
    }
}

async fn test(args: &[String]) -> Result<()> {
    let values = load_values();
    let connectors = if args.is_empty() {
        configured(&values)
    } else {
        named(&values, args)?
    };
    if connectors.is_empty() {
        bail!("no connector is set up — run `tramecli connector setup <name>`");
    }
    let client = client()?;
    let mut failed = false;
    for c in connectors {
        match c.send(&client, &test_message()).await {
            Ok(()) => println!("{}: test message sent", c.name()),
            Err(e) => {
                failed = true;
                eprintln!("{}: {e:#}", c.name());
            }
        }
    }
    if failed {
        bail!("a connector failed");
    }
    Ok(())
}

fn rm(args: &[String]) -> Result<()> {
    let Some(name) = args.first() else {
        bail!("usage: tramecli connector rm <name>")
    };
    let spec = spec(name)?;
    let mut all = fs::read_to_string(env_path())
        .map(|t| parse_env(&t))
        .unwrap_or_default();
    for field in spec.fields {
        all.remove(field.key);
    }
    save_values(&all)?;
    println!("{name}: removed from {}", env_path().display());
    Ok(())
}

pub async fn main(args: &[String]) -> Result<()> {
    let rest = args.get(1..).unwrap_or_default();
    match args.first().map(String::as_str) {
        Some("setup") => setup(rest).await,
        Some("list") | None => {
            list();
            Ok(())
        }
        Some("test") => test(rest).await,
        Some("rm") => rm(rest),
        Some(other) => {
            bail!("unknown connector command: {other} — see `tramecli connector --help`")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_file_parses_and_masks() {
        let v =
            parse_env("# c\nTELEGRAM_BOT_TOKEN = 123:abcdef\n\nBAD LINE\nTELEGRAM_CHAT_ID=42\n");
        assert_eq!(v.len(), 2);
        assert_eq!(v["TELEGRAM_BOT_TOKEN"], "123:abcdef");
        assert_eq!(mask("123:abcdef"), "123…def");
        assert_eq!(mask("abc"), "•••");
    }

    #[test]
    fn unknown_connector_lists_known_ones() {
        let err = spec("pigeon").err().unwrap().to_string();
        assert!(err.contains("known: telegram"), "{err}");
    }
}
