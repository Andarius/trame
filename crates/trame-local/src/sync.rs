use crate::{db::Db, settings};
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, OnceLock},
    time::Duration,
};

#[derive(Deserialize)]
pub struct Entity {
    pub name: String,
    pub cols: Vec<String>,
}
#[derive(Deserialize)]
pub struct Registry {
    pub version: u32,
    pub entities: Vec<Entity>,
}
pub fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        serde_json::from_str(include_str!("../../../protocol/rust-entities.json"))
            .expect("generated wire registry")
    })
}
fn entity(name: &str) -> Result<&'static Entity> {
    registry()
        .entities
        .iter()
        .find(|e| e.name == name)
        .ok_or_else(|| anyhow::anyhow!("unknown entity: {name}"))
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Change {
    pub rev: i64,
    pub entity: String,
    pub id: String,
    pub value: Option<Map<String, Value>>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    #[serde(rename = "acknowledgements")]
    _acknowledgements: Vec<String>,
    rejected_mutations: Vec<Rejected>,
    changes: Vec<Change>,
    next_cursor: i64,
    has_more: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rejected {
    #[serde(rename = "mutationId")]
    _mutation_id: String,
    #[serde(rename = "reason")]
    _reason: String,
}

pub fn lww_upsert(name: &str, row: &Map<String, Value>) -> Result<(String, Vec<Value>)> {
    let e = entity(name)?;
    let placeholders = (1..=e.cols.len())
        .map(|i| format!("${i}"))
        .collect::<Vec<_>>()
        .join(",");
    let update = e
        .cols
        .iter()
        .filter(|c| *c != "id")
        .map(|c| format!("{c}=excluded.{c}"))
        .collect::<Vec<_>>()
        .join(",");
    Ok((
        format!(
            "insert into {} ({}) values ({placeholders}) on conflict (id) do update set {update} where excluded.updated_at > {}.updated_at",
            e.name,
            e.cols.join(","),
            e.name
        ),
        e.cols
            .iter()
            .map(|c| row.get(c).cloned().unwrap_or(Value::Null))
            .collect(),
    ))
}

pub fn apply_changes(
    db: &mut Db,
    changes: Vec<Change>,
    deferred: &mut Vec<Change>,
) -> Result<usize> {
    let mut pending = std::mem::take(deferred);
    pending.extend(changes);
    pending.sort_by_key(|c| {
        registry()
            .entities
            .iter()
            .position(|e| e.name == c.entity)
            .unwrap_or(0)
    });
    let mut applied = 0;
    while !pending.is_empty() {
        let before = pending.len();
        let mut failed = Vec::new();
        for change in pending {
            let (sql, params) = match &change.value {
                Some(row) => lww_upsert(&change.entity, row)?,
                None => {
                    let e = entity(&change.entity)?;
                    (
                        format!(
                            "update {} set deleted=true, updated_at=$2 where id=$1 and updated_at < $2",
                            e.name
                        ),
                        vec![
                            json!(change.id),
                            json!(
                                chrono::Utc::now()
                                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                            ),
                        ],
                    )
                }
            };
            match db.query(&sql, &params) {
                Ok(_) => applied += 1,
                Err(e)
                    if e.downcast_ref::<postgres::Error>()
                        .and_then(|e| e.code())
                        .is_some_and(|c| c.code() == "23503") =>
                {
                    failed.push(change)
                }
                Err(e) => return Err(e),
            }
        }
        if failed.len() == before {
            deferred.extend(failed);
            break;
        }
        pending = failed;
    }
    Ok(applied)
}

pub fn assemble(db: &mut Db) -> Result<(Value, Vec<Value>, String, String)> {
    db.exclusive(assemble_inner)
}
fn assemble_inner(db: &mut Db) -> Result<(Value, Vec<Value>, String, String)> {
    let rows = db.query(
        "select api_cursor,last_pushed_at from sync_state where id=1",
        &[],
    )?;
    let st = rows
        .first()
        .ok_or_else(|| anyhow::anyhow!("sync state missing"))?;
    let original = st["last_pushed_at"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("push watermark missing"))?
        .to_owned();
    let cursor = st["api_cursor"].clone();
    let mut max = original.clone();
    let mut mutations = Vec::new();
    for e in &registry().entities {
        let rows = db.query(
            &format!(
                "select {} from {} where origin=$1 and updated_at > $2 order by updated_at",
                e.cols.join(","),
                e.name
            ),
            &[json!(db.origin), json!(original)],
        )?;
        for row in rows {
            let updated = row["updated_at"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("row timestamp missing"))?;
            if updated > max.as_str() {
                max = updated.to_owned()
            }
            mutations.push(json!({"mutationId":format!("{}:{}:{}:{}",db.origin,e.name,row["id"].as_str().unwrap_or(""),updated),"entity":e.name,"id":row["id"],"op":"upsert","value":row}));
        }
    }
    Ok((cursor, mutations, original, max))
}

#[derive(Clone)]
pub struct Sync {
    pub root: PathBuf,
    pub settings: PathBuf,
    pub origin: String,
    pub tls_dir: PathBuf,
    pub offline: bool,
    pub last: Arc<tokio::sync::Mutex<Value>>,
    pass: Arc<tokio::sync::Mutex<()>>,
    pub nudge: Arc<tokio::sync::Notify>,
    pub dirty: Arc<tokio::sync::Notify>,
    pub plugin_poll: Arc<tokio::sync::Notify>,
}
impl Sync {
    pub fn new(root: PathBuf, settings: PathBuf, origin: String, offline: bool) -> Self {
        Self {
            tls_dir: std::env::var_os("TRACKER_TLS_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| root.join("certs")),
            root,
            settings,
            origin,
            offline,
            last: Arc::new(tokio::sync::Mutex::new(Value::Null)),
            pass: Arc::new(tokio::sync::Mutex::new(())),
            nudge: Arc::new(tokio::sync::Notify::new()),
            dirty: Arc::new(tokio::sync::Notify::new()),
            plugin_poll: Arc::new(tokio::sync::Notify::new()),
        }
    }
    pub async fn db<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Db) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let config = self.clone();
        crate::blocking::spawn(move || {
            let mut db = Db::connect(
                &config.root.join("socket"),
                &config.origin,
                Some(config.settings),
            )?;
            db.exclusive(f)
        })
        .await?
    }
    pub fn client(&self) -> Result<reqwest::Client> {
        let mut builder = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .redirect(reqwest::redirect::Policy::none());
        if let Ok(pem) = std::fs::read(self.tls_dir.join("ca.crt")) {
            if let Ok(ca) = reqwest::Certificate::from_pem(&pem) {
                builder = builder.add_root_certificate(ca);
            }
        }
        Ok(builder.build()?)
    }
    async fn post(
        &self,
        client: &reqwest::Client,
        url: &str,
        token: &str,
        body: Value,
    ) -> Result<Response> {
        let res = client
            .post(format!("{url}/sync"))
            .header("x-trame-protocol", registry().version)
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .map_err(reqwest::Error::without_url)?;
        let status = res.status();
        if !status.is_success() {
            let err: Value = res.json().await.unwrap_or(Value::Null);
            bail!(
                "hub API {}: {}",
                status.as_u16(),
                err["error"].as_str().unwrap_or("sync failed")
            )
        }
        let response: Response = res.json().await.map_err(reqwest::Error::without_url)?;
        if response.next_cursor < 0 {
            bail!("invalid hub cursor")
        }
        Ok(response)
    }
    pub async fn once(&self) -> Result<Value> {
        if self.offline {
            return Ok(Value::Null);
        }
        let _guard = self.pass.lock().await;
        let Some((url, token)) = settings::hub_api(&self.settings) else {
            return Ok(Value::Null);
        };
        let client = self.client()?;
        let (cursor, mutations, original, max) = self.db(assemble).await?;
        let count = mutations.len();
        let mut response = self
            .post(
                &client,
                &url,
                &token,
                json!({"cursor":cursor,"mutations":mutations}),
            )
            .await?;
        let rejected = response.rejected_mutations.len();
        if rejected > count {
            bail!("invalid rejected mutation count")
        }
        if rejected > 0 {
            eprintln!("sync: hub rejected {rejected} mutations; push watermark retained");
        }
        let mut deferred = Vec::new();
        let mut pulled = 0;
        loop {
            let changes = response.changes;
            (pulled, deferred) = self
                .db(move |db| {
                    let mut deferred = deferred;
                    let n = apply_changes(db, changes, &mut deferred)?;
                    Ok((pulled + n, deferred))
                })
                .await?;
            if !response.has_more {
                break;
            }
            let previous = response.next_cursor;
            response = self
                .post(
                    &client,
                    &url,
                    &token,
                    json!({"cursor":previous,"mutations":[]}),
                )
                .await?;
            if response.next_cursor <= previous {
                bail!("hub cursor did not advance")
            }
        }
        if !deferred.is_empty() {
            bail!(
                "{} pulled row(s) still miss their parent row",
                deferred.len()
            )
        }
        let cursor = response.next_cursor;
        self.db(move|db|{
            db.query("update pages set kind='story', origin=$1, updated_at=now() where kind='page' and not deleted and id in (select page_id from sessions where not deleted and page_id is not null)",&[json!(db.origin)])?;
            db.query("update sync_state set api_cursor=$1,last_pushed_at=$2 where id=1",&[json!(cursor),json!(if rejected>0{original}else{max})])?;
            Ok(())
        }).await?;
        *self.last.lock().await = json!({"at":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"pulled":pulled,"pushed":count-rejected});
        Ok(json!({"pulled":pulled,"pushed":count-rejected}))
    }
    pub async fn test_hub(&self, url: &str, token: &str) -> Value {
        if self.offline {
            return json!({"ok":false,"error":"offline mode"});
        }
        match self.probe(url, token).await {
            Ok(tls) => json!({"ok":true,"tls":tls}),
            Err(e) => json!({"ok":false,"error":e.to_string()}),
        }
    }
    async fn probe(&self, url: &str, token: &str) -> Result<bool> {
        let client = self.client()?;
        let res = client
            .get(format!("{url}/health"))
            .send()
            .await
            .map_err(reqwest::Error::without_url)?;
        if !res.status().is_success() {
            bail!("hub answered {}", res.status().as_u16())
        }
        let health: Value = res.json().await.unwrap_or(Value::Null);
        if health["protocol"].as_u64() != Some(registry().version as u64) {
            bail!(
                "protocol mismatch: hub speaks {}, this app {}",
                health
                    .get("protocol")
                    .map(trame_core::js_string)
                    .unwrap_or_else(|| "undefined".into()),
                registry().version
            )
        }
        self.post(
            &client,
            url,
            token,
            json!({"cursor":0,"mutations":[],"limit":1}),
        )
        .await?;
        Ok(url.starts_with("https:"))
    }
    pub async fn background(self) {
        if self.offline {
            return;
        }
        loop {
            if self.once().await.is_err() {
                eprintln!("sync: pass failed; cursors retained for retry");
            }
            tokio::select! {
                _=tokio::time::sleep(Duration::from_millis(std::env::var("TRACKER_SYNC_MS").ok().and_then(|v|v.parse::<u64>().ok()).unwrap_or(15000).max(1)))=>{},
                _=self.nudge.notified()=>{},
                _=self.dirty.notified()=>{loop{tokio::select!{
                    _=tokio::time::sleep(Duration::from_millis(1500))=>break,
                    _=self.nudge.notified()=>break,
                    _=self.dirty.notified()=>{},
                }}},
            }
        }
    }

    pub async fn realtime(self) {
        if self.offline {
            return;
        }
        let mut attempt = 0u32;
        loop {
            let Some((url, token)) = settings::hub_api(&self.settings) else {
                tokio::time::sleep(Duration::from_secs(30)).await;
                continue;
            };
            let _ = self.socket(&url, &token, &mut attempt).await;
            let cap = 1000u64
                .saturating_mul(1u64.checked_shl(attempt).unwrap_or(u64::MAX))
                .min(60_000);
            attempt = attempt.saturating_add(1);
            let jitter =
                0.75 + (uuid::Uuid::new_v4().as_u128() as u16 as f64 / u16::MAX as f64) * 0.5;
            tokio::time::sleep(Duration::from_millis((cap as f64 * jitter) as u64)).await;
        }
    }

    fn ws_connector(&self) -> Option<tokio_tungstenite::Connector> {
        let pem = std::fs::read(self.tls_dir.join("ca.crt")).ok()?;
        let mut roots = rustls::RootCertStore::empty();
        let mut found = false;
        for certificate in rustls_pemfile::certs(&mut pem.as_slice()) {
            roots.add(certificate.ok()?).ok()?;
            found = true;
        }
        if !found {
            return None;
        }
        let _ = rustls::crypto::ring::default_provider().install_default();
        Some(tokio_tungstenite::Connector::Rustls(Arc::new(
            rustls::ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        )))
    }

    async fn socket(&self, base: &str, token: &str, attempt: &mut u32) -> Result<()> {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::{connect_async_tls_with_config, tungstenite::Message};
        let mut url = reqwest::Url::parse(base)?;
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        url.set_scheme(scheme)
            .map_err(|_| anyhow::anyhow!("invalid websocket URL"))?;
        url.set_path(&format!("{}/ws", url.path().trim_end_matches('/')));
        url.query_pairs_mut().append_pair("token", token);
        let connector = self.ws_connector();
        let (mut ws, _) = tokio::time::timeout(
            Duration::from_secs(20),
            connect_async_tls_with_config(url.as_str(), None, false, connector),
        )
        .await?
        .map_err(|_| anyhow::anyhow!("websocket connection failed"))?;
        *attempt = 0;
        let cursor = self
            .db(|db| {
                Ok(db
                    .query("select api_cursor from sync_state where id=1", &[])?
                    .first()
                    .map(|r| r["api_cursor"].clone())
                    .unwrap_or(Value::Null))
            })
            .await
            .unwrap_or(Value::Null);
        ws.send(Message::Text(
            json!({"type":"hello","cursor":cursor}).to_string().into(),
        ))
        .await?;
        let mut heartbeat = tokio::time::interval(Duration::from_secs(25));
        heartbeat.tick().await;
        loop {
            tokio::select! {
                _=heartbeat.tick()=>ws.send(Message::Text("{\"type\":\"ping\"}".into())).await?,
                message=ws.next()=>match message {
                    Some(Ok(Message::Text(text)))=>{if serde_json::from_str::<Value>(&text).is_ok_and(|v|v["type"]=="changed"){self.nudge.notify_one();}},
                    Some(Ok(Message::Ping(bytes)))=>ws.send(Message::Pong(bytes)).await?,
                    Some(Ok(Message::Close(_)))|None=>return Ok(()),
                    Some(Err(_))=>bail!("websocket disconnected"),
                    _=>{},
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Sync;

    #[test]
    fn malformed_private_ca_falls_back_to_public_roots() {
        let root = crate::scratch_root(
            &crate::workspace().join(format!(".scratch/sync-ca-{}", uuid::Uuid::new_v4())),
        )
        .unwrap();
        std::fs::write(root.join("ca.crt"), b"not a certificate").unwrap();
        let mut sync = Sync::new(
            root.clone(),
            root.join("settings.json"),
            "fixture".into(),
            true,
        );
        sync.tls_dir = root.clone();
        assert!(sync.client().is_ok());
        assert!(sync.ws_connector().is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}
