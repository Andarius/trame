use crate::db::Db;
use anyhow::Result;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

// Each device's running agents, in memory only: the hub keeps every device's last push, a desktop the hub's answer.
const FRESH_MS: i64 = 30_000;
const MAX_AGENTS: usize = 50;
const FIELDS: [(&str, usize); 8] = [
    ("id", 80),
    ("term", 80),
    ("agent", 20),
    ("name", 120),
    ("title", 120),
    ("waiting", 300),
    ("card", 40),
    ("project", 40),
];

fn devices() -> &'static Mutex<BTreeMap<String, Value>> {
    static DEVICES: OnceLock<Mutex<BTreeMap<String, Value>>> = OnceLock::new();
    DEVICES.get_or_init(|| Mutex::new(BTreeMap::new()))
}

#[allow(clippy::cast_possible_truncation, reason = "ms epoch fits i64")]
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// One agent as pushed, reduced to known short fields.
fn agent(raw: &Value) -> Option<Value> {
    let mut out = serde_json::Map::new();
    for (key, max) in FIELDS {
        if let Some(s) = raw[key].as_str().filter(|s| !s.is_empty()) {
            out.insert(key.into(), json!(s.chars().take(max).collect::<String>()));
        }
    }
    out.get("id")?;
    for key in ["busy", "done", "asleep"] {
        out.insert(key.into(), json!(raw[key].as_bool().unwrap_or(false)));
    }
    if let Some(at) = raw["updated_at"].as_u64() {
        out.insert("updated_at".into(), json!(at));
    }
    Some(Value::Object(out))
}

/// The fresh snapshots of every device but `me`.
fn others(me: &str, at: i64) -> Value {
    let mut map = devices().lock().unwrap();
    map.retain(|_, d| at - d["at"].as_i64().unwrap_or(0) <= FRESH_MS);
    json!(
        map.iter()
            .filter(|(k, _)| *k != me)
            .map(|(_, d)| d.clone())
            .collect::<Vec<_>>()
    )
}

fn store(device: &str, body: &Value, at: i64) {
    store_into(&mut devices().lock().unwrap(), device, body, at);
}

/// The hub's answer, as this desktop's view of the other devices.
pub fn set_remote(list: &Value) {
    let at = now();
    let mut map = devices().lock().unwrap();
    map.clear();
    for d in list.as_array().into_iter().flatten() {
        if let Some(device) = d["device"].as_str() {
            store_into(&mut map, device, d, at);
        }
    }
}

fn store_into(map: &mut BTreeMap<String, Value>, device: &str, d: &Value, at: i64) {
    let label = d["label"]
        .as_str()
        .unwrap_or(device)
        .chars()
        .take(60)
        .collect::<String>();
    let agents = d["agents"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(agent)
                .take(MAX_AGENTS)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    map.insert(
        device.to_owned(),
        json!({"device":device,"label":label,"at":at,"agents":agents}),
    );
}

/// `GET /api/fleet`: the other devices' agents; `POST` (hub only): a device's push, answered with the others.
pub fn handle(db: &mut Db, method: &str, path: &str, body: &Value) -> Option<Result<(u16, Value)>> {
    if path != "/api/fleet" {
        return None;
    }
    let at = now();
    Some(Ok(match method {
        "GET" => (200, others(&db.origin, at)),
        "POST" if db.is_hub() => {
            store(&db.origin, body, at);
            (200, others(&db.origin, at))
        }
        _ => (405, json!({"error":"method not allowed"})),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_device_sees_the_others_fresh_agents_only() {
        let body = |name: &str| json!({"label":name,"agents":[{"id":"s1","agent":"claude","name":name,"busy":true,"cwd":"/home/x"},{"agent":"no id"}]});
        store("mac", &body("mac"), 1_000);
        store("linux", &body("linux"), 1_000);
        store("old", &body("old"), 1_000 - FRESH_MS - 1);
        let seen = others("linux", 1_000);
        assert_eq!(seen.as_array().unwrap().len(), 1);
        assert_eq!(seen[0]["label"], "mac");
        // unknown fields and agents without an id are dropped
        assert_eq!(
            seen[0]["agents"],
            json!([{"id":"s1","agent":"claude","name":"mac","busy":true,"done":false,"asleep":false}])
        );
    }
}
