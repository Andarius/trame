// The hub sync wire protocol: the generated entity registry, the /sync message types and LWW SQL.
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::sync::OnceLock;

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

pub fn entity(name: &str) -> Result<&'static Entity> {
    registry()
        .entities
        .iter()
        .find(|e| e.name == name)
        .ok_or_else(|| anyhow::anyhow!("unknown entity: {name}"))
}

/// A pulled row: its new value, or `None` for a hard delete.
#[derive(Clone, Deserialize, Serialize)]
pub struct Change {
    pub rev: i64,
    pub entity: String,
    pub id: String,
    pub value: Option<Map<String, Value>>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub acknowledgements: Vec<String>,
    pub rejected_mutations: Vec<Rejected>,
    pub changes: Vec<Change>,
    pub next_cursor: i64,
    pub has_more: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rejected {
    pub mutation_id: String,
    pub reason: String,
}

/// Upsert `row` into entity `name` unless the stored row is as new or newer.
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

/// Soft-delete row `$1` of entity `name` at `$2` unless it changed since.
pub fn lww_soft_delete(name: &str) -> Result<String> {
    let e = entity(name)?;
    Ok(format!(
        "update {} set deleted=true, updated_at=$2 where id=$1 and updated_at < $2",
        e.name
    ))
}
