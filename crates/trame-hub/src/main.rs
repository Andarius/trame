mod auth;
mod tls;

use anyhow::{Result, bail};
use axum::{Json, Router, routing::get};
use postgres::{Config, NoTls};
use serde_json::json;
use std::{
    env,
    io::{self, Write as _},
};

fn main() -> Result<()> {
    let config: Config = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://tracker@trame-db:5432/tracker".into())
        .parse()?;
    let args: Vec<_> = env::args().skip(1).collect();
    let mut client = config.connect(NoTls)?;
    auth::ensure_schema(&mut client)?;
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["token", "mint", node, rest @ ..] if !node.is_empty() && rest.len() <= 1 => {
            writeln!(
                io::stdout().lock(),
                "{}",
                auth::mint(&mut client, node, rest.first().copied())?
            )?;
            Ok(())
        }
        [] | ["serve"] => {
            drop(client);
            let router = Router::new().route(
                "/health",
                get(async || {
                    Json(json!({"ok": true, "protocol": trame_protocol::registry().version}))
                }),
            );
            tokio::runtime::Runtime::new()?.block_on(tls::serve(router))
        }
        _ => bail!("usage: trame-hub [serve | token mint <node-id> [user-id]]"),
    }
}
