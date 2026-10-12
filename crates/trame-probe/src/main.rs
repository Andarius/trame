use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{path::Path, sync::Arc, time::Duration};
use tokio_tungstenite::{Connector, connect_async_tls_with_config, tungstenite::Message};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    hub_api: String,
    hub_api_token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncResponse {
    acknowledgements: Vec<String>,
    rejected_mutations: Vec<Value>,
    changes: Vec<Value>,
    next_cursor: u64,
    has_more: bool,
}

// An immutable empty array prevents the probe from ever accepting mutations.
fn pull_request() -> Value {
    json!({"cursor": 0, "mutations": [], "limit": 1})
}

async fn probe(settings_path: &Path, ca_path: &Path) -> Result<Value> {
    let settings: Settings = serde_json::from_slice(&std::fs::read(settings_path)?)?;
    let mut url = reqwest::Url::parse(settings.hub_api.trim_end_matches('/'))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || settings.hub_api_token.is_empty()
    {
        return Err("expected HTTPS hub URL and a nonempty token".into());
    }
    let ca = std::fs::read(ca_path)?;
    let mut roots = rustls::RootCertStore::empty();
    for cert in rustls_pemfile::certs(&mut ca.as_slice()) {
        roots.add(cert?)?;
    }
    let tls = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let client = reqwest::Client::builder()
        .use_preconfigured_tls(tls.clone())
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()?;
    let protocol = include_str!("../../../protocol/entities.ts")
        .lines()
        .find_map(|line| line.strip_prefix("export const PROTOCOL_VERSION = "))
        .ok_or("protocol version missing")?
        .trim_end_matches(';');
    let response = client
        .post(format!("{}/sync", url.as_str().trim_end_matches('/')))
        .bearer_auth(&settings.hub_api_token)
        .header("x-trame-protocol", protocol)
        .json(&pull_request())
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("sync HTTP status {status}").into());
    }
    let sync: SyncResponse = response.json().await?;
    if !sync.acknowledgements.is_empty() || !sync.rejected_mutations.is_empty() {
        return Err("unexpected mutation results in pull response".into());
    }
    url.set_scheme("wss").map_err(|_| "invalid WSS URL")?;
    url.set_path(&format!("{}/ws", url.path().trim_end_matches('/')));
    url.query_pairs_mut()
        .append_pair("token", &settings.hub_api_token);
    let (mut ws, handshake) = tokio::time::timeout(
        Duration::from_secs(20),
        connect_async_tls_with_config(
            url.as_str(),
            None,
            false,
            Some(Connector::Rustls(Arc::new(tls))),
        ),
    )
    .await??;
    ws.send(Message::Text(
        json!({"type":"hello", "cursor":null}).to_string().into(),
    ))
    .await?;
    let rev = tokio::time::timeout(Duration::from_secs(20), async {
        while let Some(message) = ws.next().await {
            let message = message?;
            if let Message::Text(text) = message {
                let value: Value = serde_json::from_str(&text)?;
                if value["type"] == "changed" {
                    return value["rev"]
                        .as_u64()
                        .ok_or_else(|| "invalid nudge revision".into());
                }
            }
        }
        Err::<u64, Box<dyn std::error::Error>>("socket closed before nudge".into())
    })
    .await??;
    ws.close(None).await?;
    Ok(json!({
        "gate": "c", "pass": true, "https_status": status.as_u16(),
        "mutations_sent": 0, "changes_received": sync.changes.len(),
        "next_cursor": sync.next_cursor, "has_more": sync.has_more,
        "wss_status": handshake.status().as_u16(), "nudge_type": "changed", "nudge_rev": rev,
        "tls": "rustls custom CA only; hostname validation; no client certificate",
        "nudge_source": "hello catch-up (no synthetic hub write)"
    }))
}

#[tokio::main]
async fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|arg| arg == "build-only") {
        let _ = trame_probe::router();
        #[cfg(feature = "desktop-bench")]
        let _ = tauri::Builder::default();
        println!("build probe only; no listener or window opened");
        return;
    }
    if args.len() != 4 || args[1] != "hub" {
        eprintln!("usage: trame-probe hub SETTINGS_JSON CA_PEM | build-only");
        std::process::exit(2);
    }
    match probe(Path::new(&args[2]), Path::new(&args[3])).await {
        Ok(evidence) => println!("{evidence}"),
        // TLS and websocket errors may contain the credential-bearing URL.
        Err(_) => {
            eprintln!("hub probe failed; credential-bearing error details suppressed");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn pull_has_no_mutations() {
        assert_eq!(
            super::pull_request(),
            serde_json::json!({"cursor":0,"mutations":[],"limit":1})
        );
    }
}
