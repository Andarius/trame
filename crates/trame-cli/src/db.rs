use crate::target::Target;
use anyhow::{Result, bail};
use serde_json::{Map, Value, json};

pub fn resolve_vals(vals: &Value, properties: &Value) -> Result<Value> {
    let props = properties
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("properties must be an array"))?;
    let mut out = Map::new();
    let values = vals
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("every row needs a vals object"))?;
    for (key, value) in values {
        let property = props
            .iter()
            .find(|p| p["id"] == key.as_str())
            .or_else(|| props.iter().find(|p| p["name"] == key.as_str()));
        let Some(property) = property else {
            let have = props
                .iter()
                .filter_map(|p| p["name"].as_str())
                .collect::<Vec<_>>()
                .join(", ");
            bail!("unknown column \"{key}\" — have: {have}");
        };
        let kind = property["type"].as_str().unwrap_or("");
        if matches!(kind, "relation" | "formula" | "rollup") {
            bail!(
                "column \"{}\" is a {kind} — not writable through vals (see `tramecli db`)",
                property["name"].as_str().unwrap_or("")
            );
        }
        out.insert(property["id"].as_str().unwrap_or(key).into(), value.clone());
    }
    Ok(Value::Object(out))
}
pub async fn write_rows(target: &Target, db: &str, input: &Value) -> Result<Value> {
    let detail = target.get(&format!("/api/udb/{db}")).await?;
    let source = if let Some(array) = input.as_array() {
        array.clone()
    } else {
        vec![input.clone()]
    };
    let mut rows = Vec::new();
    for row in source {
        if !row["vals"].is_object() {
            bail!("every row needs a vals object");
        }
        let vals = resolve_vals(&row["vals"], &detail["properties"])?;
        rows.push((row, vals));
    }
    let mut out = Vec::new();
    for (row, vals) in rows {
        let mut body = json!({"vals":vals});
        if row.get("icon").is_some() {
            body["icon"] = row["icon"].clone();
        }
        if let Some(id) = row["id"].as_str().filter(|s| !s.is_empty()) {
            target.post(&format!("/api/udb/rows/{id}"), &body).await?;
            out.push(json!({"id":id,"created":false}));
        } else {
            let result = target.post(&format!("/api/udb/{db}/rows"), &body).await?;
            out.push(json!({"id":result["id"],"created":true}));
        }
    }
    Ok(json!(out))
}
pub async fn main(args: &[String], json_out: bool, target: &Target) -> Result<()> {
    if args.first().map(String::as_str) != Some("rows") || args.get(1).is_none() {
        bail!("usage: tramecli db rows <db-id> < rows.json");
    }
    let input = crate::cli::read_json_input(&[]).await?;
    let rows = write_rows(target, &args[1], &input).await?;
    if json_out {
        println!("{rows}");
    } else {
        for row in rows.as_array().into_iter().flatten() {
            println!(
                "ok: row {} {}",
                row["id"].as_str().unwrap_or(""),
                if row["created"] == true {
                    "created"
                } else {
                    "updated"
                }
            );
        }
    }
    Ok(())
}
