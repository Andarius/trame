use crate::{
    db::Db,
    pages::{attach_udb, mid_key},
};
use anyhow::{Context, Result, bail};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};

pub(crate) mod formula;

fn first(db: &mut Db, sql: &str, params: &[Value]) -> Result<Value> {
    Ok(db
        .query(sql, params)?
        .into_iter()
        .next()
        .unwrap_or(Value::Null))
}

fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

fn js(value: &Value) -> String {
    trame_core::js_string(value)
}

fn next_key(db: &mut Db, table: &str, id: Option<&str>) -> Result<String> {
    let sql = match (table, id.is_some()) {
        ("udb_databases", false) => {
            "select max(sort_key) as k from udb_databases where not deleted"
        }
        ("udb_properties", true) => {
            "select max(sort_key) as k from udb_properties where db_id=$1 and not deleted"
        }
        ("udb_rows", true) => {
            "select max(sort_key) as k from udb_rows where db_id=$1 and not deleted"
        }
        _ => bail!("invalid sort-key scope"),
    };
    let params = id.map(|id| vec![json!(id)]).unwrap_or_default();
    Ok(mid_key(
        first(db, sql, &params)?["k"].as_str().unwrap_or(""),
        "",
    ))
}

fn props(db: &mut Db, id: &str) -> Result<Vec<Value>> {
    db.query("select id, db_id, name, type, config, sort_key, width from udb_properties where db_id=$1 and not deleted order by sort_key, name", &[json!(id)])
}

fn create_db(db: &mut Db, body: &Value) -> Result<Value> {
    let name = body
        .get("name")
        .filter(|v| !v.is_null())
        .map(js)
        .unwrap_or_else(|| "Untitled".into());
    let key = next_key(db, "udb_databases", None)?;
    let origin = db.origin.clone();
    let id = first(
        db,
        "insert into udb_databases (name, sort_key, origin) values ($1,$2,$3) returning id",
        &[json!(name), json!(key), json!(origin)],
    )?["id"]
        .clone();
    db.query("insert into udb_properties (db_id, name, type, sort_key, origin) values ($1,'Name','title',$2,$3)", &[id.clone(),json!(mid_key("", "")),json!(origin)])?;
    Ok(json!({"id":id}))
}

fn update_db(db: &mut Db, id: &str, body: &Value) -> Result<Value> {
    if let Some(page_id) = body.get("page_id") {
        attach_udb(db, id, page_id)?;
    }
    let origin = db.origin.clone();
    db.query("update udb_databases set name = coalesce($2, name), icon = case when $4 then $3 else icon end, views = case when $6 then $7::jsonb else views end, origin=$5, updated_at=now() where id=$1", &[
        json!(id),field(body,"name").clone(),field(body,"icon").clone(),json!(body.get("icon").is_some()),json!(origin),json!(body.get("views").is_some()),json!(crate::json::stringify(body.get("views").filter(|v| !v.is_null()).unwrap_or(&json!([]))))
    ])?;
    Ok(json!({"ok":true}))
}

fn delete_db(db: &mut Db, id: &str) -> Result<Value> {
    let p = [json!(id), json!(db.origin)];
    db.query("update udb_links set deleted=true, origin=$2, updated_at=now() where not deleted and (prop_id in (select id from udb_properties where db_id=$1) or to_row in (select id from udb_rows where db_id=$1) or from_row in (select id from udb_rows where db_id=$1))", &p)?;
    db.query("update udb_properties set deleted=true, origin=$2, updated_at=now() where not deleted and (db_id=$1 or (type='relation' and config->>'target_db' = $1::text))", &p)?;
    db.query("update udb_rows set deleted=true, origin=$2, updated_at=now() where db_id=$1 and not deleted", &p)?;
    db.query(
        "update udb_databases set deleted=true, origin=$2, updated_at=now() where id=$1",
        &p,
    )?;
    Ok(json!({"ok":true}))
}

fn create_prop(db: &mut Db, db_id: &str, body: &Value) -> Result<Value> {
    let config = body
        .get("config")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(json!({}));
    let kind = js(field(body, "type"));
    if kind == "formula" {
        let current = props(db, db_id)?;
        let expr = config
            .get("expr")
            .filter(|v| !v.is_null())
            .map(js)
            .unwrap_or_default();
        formula::rewrite(&expr, &current)?;
        formula::validate(db, &expr, &current)?;
    }
    if kind == "rollup" {
        let rel = props(db, db_id)?
            .into_iter()
            .find(|p| p["id"] == config["relation_prop"]);
        if !rel.is_some_and(|p| p["type"] == "relation") {
            bail!("rollup: relation_prop must be a relation property of this database");
        }
        if config["agg"] != "count" && field(&config, "target_prop").is_null() {
            bail!("rollup: target_prop required");
        }
    }
    let key = next_key(db, "udb_properties", Some(db_id))?;
    let origin = db.origin.clone();
    let id = first(db,"insert into udb_properties (db_id, name, type, config, sort_key, origin) values ($1,$2,$3,$4,$5,$6) returning id",&[
        json!(db_id),field(body,"name").clone(),json!(kind),json!(crate::json::stringify(&config)),json!(key),json!(origin)
    ])?["id"].clone();
    if kind == "relation" {
        let target = config
            .get("target_db")
            .filter(|v| !v.is_null())
            .map(js)
            .unwrap_or_default();
        if target.is_empty() {
            bail!("relation: config.target_db required");
        }
        let name = first(
            db,
            "select name from udb_databases where id=$1",
            &[json!(db_id)],
        )?["name"]
            .clone();
        let reverse_name = config
            .get("reverse_name")
            .filter(|v| !v.is_null())
            .map(js)
            .unwrap_or_else(|| js(&name));
        let reverse_key = next_key(db, "udb_properties", Some(&target))?;
        let reverse = first(db,"insert into udb_properties (db_id, name, type, config, sort_key, origin) values ($1,$2,'relation',$3,$4,$5) returning id",&[
            json!(target),json!(reverse_name),json!(crate::json::stringify(&json!({"target_db":db_id,"pair":id,"owner":false}))),json!(reverse_key),json!(origin)
        ])?["id"].clone();
        db.query("update udb_properties set config = config || $2::jsonb, origin=$3, updated_at=now() where id=$1",&[
            id.clone(),json!(crate::json::stringify(&json!({"target_db":target,"pair":reverse,"owner":true}))),json!(origin)
        ])?;
    }
    Ok(json!({"id":id}))
}

fn update_prop(db: &mut Db, id: &str, body: &Value) -> Result<Value> {
    let current = first(
        db,
        "select db_id, type, config from udb_properties where id=$1 and not deleted",
        &[json!(id)],
    )?;
    if current.is_null() {
        bail!("property not found");
    }
    if current["type"] == "formula" && body["config"].get("expr").is_some() {
        let db_id = current["db_id"].as_str().context("invalid db id")?;
        let expr = body["config"]
            .get("expr")
            .filter(|v| !v.is_null())
            .map(js)
            .unwrap_or_default();
        let current_props = props(db, db_id)?;
        formula::validate(db, &expr, &current_props)?;
    }
    let config = body
        .get("config")
        .filter(|v| trame_core::truthy(v))
        .map(crate::json::stringify);
    db.query("update udb_properties set name = coalesce($2, name), config = case when $3::jsonb is null then config else config || $3::jsonb end, width = case when $6 then $4 else width end, sort_key = coalesce($5, sort_key), origin=$7, updated_at=now() where id=$1",&[
        json!(id),field(body,"name").clone(),json!(config),field(body,"width").clone(),field(body,"sort_key").clone(),json!(body.get("width").is_some()),json!(db.origin)
    ])?;
    Ok(json!({"ok":true}))
}

fn delete_prop(db: &mut Db, id: &str) -> Result<Value> {
    let current = first(
        db,
        "select type, config from udb_properties where id=$1 and not deleted",
        &[json!(id)],
    )?;
    if current.is_null() {
        return Ok(json!({"ok":true}));
    }
    let mut ids = vec![json!(id)];
    let relation = current["type"] == "relation";
    if relation && trame_core::truthy(&current["config"]["pair"]) {
        ids.push(json!(js(&current["config"]["pair"])));
    }
    if relation {
        let owner = if trame_core::truthy(&current["config"]["owner"]) {
            json!(id)
        } else {
            json!(js(&current["config"]["pair"]))
        };
        db.query("update udb_links set deleted=true, origin=$2, updated_at=now() where prop_id=$1 and not deleted",&[owner,json!(db.origin)])?;
    }
    db.query("update udb_properties set deleted=true, origin=$2, updated_at=now() where id = any($1::uuid[])",&[json!(ids),json!(db.origin)])?;
    Ok(json!({"ok":true}))
}

fn create_row(db: &mut Db, id: &str, body: &Value) -> Result<Value> {
    let key = next_key(db, "udb_rows", Some(id))?;
    let vals = body
        .get("vals")
        .filter(|v| trame_core::truthy(v))
        .cloned()
        .unwrap_or(json!({}));
    let row = first(
        db,
        "insert into udb_rows (db_id, icon, vals, sort_key, origin) values ($1,$2,$3,$4,$5) returning id",
        &[
            json!(id),
            field(body, "icon").clone(),
            json!(crate::json::stringify(&vals)),
            json!(key),
            json!(db.origin),
        ],
    )?;
    Ok(json!({"id":row["id"]}))
}

fn patch_row(db: &mut Db, id: &str, body: &Value) -> Result<Value> {
    let vals = body
        .get("vals")
        .filter(|v| trame_core::truthy(v))
        .cloned()
        .unwrap_or(json!({}));
    db.query("update udb_rows set vals = jsonb_strip_nulls(vals || $2::jsonb), icon = case when $4 then $3 else icon end, origin=$5, updated_at=now() where id=$1",&[
        json!(id),json!(crate::json::stringify(&vals)),field(body,"icon").clone(),json!(body.get("icon").is_some()),json!(db.origin)
    ])?;
    Ok(json!({"ok":true}))
}

fn delete_row(db: &mut Db, id: &str) -> Result<Value> {
    let p = [json!(id), json!(db.origin)];
    db.query("update udb_links set deleted=true, origin=$2, updated_at=now() where not deleted and (from_row=$1 or to_row=$1)",&p)?;
    db.query(
        "update udb_rows set deleted=true, origin=$2, updated_at=now() where id=$1",
        &p,
    )?;
    Ok(json!({"ok":true}))
}

fn link(db: &mut Db, body: &Value) -> Result<Value> {
    let prop = first(
        db,
        "select type, config from udb_properties where id=$1 and not deleted",
        &[field(body, "prop_id").clone()],
    )?;
    if prop["type"] != "relation" {
        bail!("not a relation property");
    }
    let owner = trame_core::truthy(&prop["config"]["owner"]);
    let (from, to) = if owner {
        (field(body, "from_row"), field(body, "to_row"))
    } else {
        (field(body, "to_row"), field(body, "from_row"))
    };
    let prop_id = if owner {
        field(body, "prop_id").clone()
    } else {
        json!(js(&prop["config"]["pair"]))
    };
    if trame_core::truthy(field(body, "remove")) {
        db.query("update udb_links set deleted=true, origin=$4, updated_at=now() where prop_id=$1 and from_row=$2 and to_row=$3 and not deleted",&[prop_id,from.clone(),to.clone(),json!(db.origin)])?;
    } else {
        let existing = first(
            db,
            "select id from udb_links where prop_id=$1 and from_row=$2 and to_row=$3 limit 1",
            &[prop_id.clone(), from.clone(), to.clone()],
        )?;
        if existing.is_null() {
            db.query(
                "insert into udb_links (prop_id, from_row, to_row, origin) values ($1,$2,$3,$4)",
                &[prop_id, from.clone(), to.clone(), json!(db.origin)],
            )?;
        } else {
            db.query(
                "update udb_links set deleted=false, origin=$2, updated_at=now() where id=$1",
                &[existing["id"].clone(), json!(db.origin)],
            )?;
        }
    }
    Ok(json!({"ok":true}))
}

fn icons(db: &mut Db) -> Result<Value> {
    Ok(json!(db.query("select icon from (select icon, updated_at from udb_rows where icon is not null and not deleted union all select icon, updated_at from udb_databases where icon is not null and not deleted) t where icon like 'data:%' or icon like 'http%' group by icon order by max(updated_at) desc limit 60",&[])?.into_iter().map(|r| r["icon"].clone()).collect::<Vec<_>>()))
}

fn read(db: &mut Db, id: &str) -> Result<(u16, Value)> {
    let definition = first(
        db,
        "select id, name, icon, views from udb_databases where id=$1 and not deleted",
        &[json!(id)],
    )?;
    if definition.is_null() {
        return Ok((404, json!({"error":"not found"})));
    }
    let properties = props(db, id)?;
    let mut rows = db.query("select id, icon, vals, sort_key from udb_rows where db_id=$1 and not deleted order by sort_key, id",&[json!(id)])?;
    let relations: Vec<_> = properties
        .iter()
        .filter(|p| p["type"] == "relation")
        .collect();
    let targets: HashSet<String> = relations
        .iter()
        .map(|p| js(&p["config"]["target_db"]))
        .collect();
    let title_props = if targets.is_empty() {
        vec![]
    } else {
        db.query("select id, db_id from udb_properties where type='title' and not deleted and db_id = any($1::uuid[])",&[json!(targets.into_iter().collect::<Vec<_>>())])?
    };
    let title_of: HashMap<String, String> = title_props
        .iter()
        .map(|p| (js(&p["db_id"]), js(&p["id"])))
        .collect();
    let mut relation_values: HashMap<String, HashMap<String, Vec<Value>>> = HashMap::new();
    for prop in &relations {
        let owner = trame_core::truthy(&prop["config"]["owner"]);
        let pair = if owner {
            prop["id"].clone()
        } else {
            json!(js(&prop["config"]["pair"]))
        };
        let (row_col, target_col) = if owner {
            ("from_row", "to_row")
        } else {
            ("to_row", "from_row")
        };
        let sql = format!(
            "select l.{row_col} as row_id, t.id, t.icon, coalesce(t.vals->>$2, '') as title from (select distinct from_row, to_row from udb_links where prop_id=$1 and not deleted) l join udb_rows t on t.id = l.{target_col} and not t.deleted order by t.sort_key"
        );
        let title = title_of
            .get(&js(&prop["config"]["target_db"]))
            .cloned()
            .unwrap_or_default();
        let mut by_row: HashMap<String, Vec<Value>> = HashMap::new();
        for link in db.query(&sql, &[pair, json!(title)])? {
            by_row
                .entry(js(&link["row_id"]))
                .or_default()
                .push(json!({"id":link["id"],"title":link["title"],"icon":link["icon"]}));
        }
        relation_values.insert(js(&prop["id"]), by_row);
    }
    let mut derived: Vec<(String, HashMap<String, Value>)> = Vec::new();
    for prop in properties
        .iter()
        .filter(|p| p["type"] == "formula")
        .chain(properties.iter().filter(|p| p["type"] == "rollup"))
    {
        let result = if prop["type"] == "formula" {
            formula::values(db, prop, &properties, id)
        } else {
            formula::rollup(db, prop, &properties)
        };
        let values = match result {
            Ok(values) => values,
            Err(error) => rows
                .iter()
                .map(|r| (js(&r["id"]), json!({"error":error.to_string()})))
                .collect(),
        };
        derived.push((js(&prop["id"]), values));
    }
    for row in &mut rows {
        let row_id = js(&row["id"]);
        let relation_obj: Map<String, Value> = relations
            .iter()
            .map(|p| {
                let prop_id = js(&p["id"]);
                let values = relation_values
                    .get(&prop_id)
                    .and_then(|r| r.get(&row_id))
                    .cloned()
                    .unwrap_or_default();
                (prop_id, json!(values))
            })
            .collect();
        let derived_obj: Map<String, Value> = derived
            .iter()
            .map(|(prop, values)| {
                (
                    prop.clone(),
                    values.get(&row_id).cloned().unwrap_or(Value::Null),
                )
            })
            .collect();
        row["relations"] = Value::Object(relation_obj);
        row["derived"] = Value::Object(derived_obj);
    }
    Ok((
        200,
        json!({"db":definition,"properties":properties,"rows":rows}),
    ))
}

pub fn owns(method: &str, path: &str) -> bool {
    let p: Vec<_> = path.split('/').collect();
    match p.as_slice() {
        ["", "api", "udb"] => true,
        ["", "api", "udb", id] => !id.is_empty(),
        ["", "api", "udb", "props" | "rows", id]
        | ["", "api", "udb", "props" | "rows", id, "delete"] => method == "POST" && !id.is_empty(),
        ["", "api", "udb", id, "props" | "rows" | "delete"] => method == "POST" && !id.is_empty(),
        _ => false,
    }
}

pub fn handle(
    db: &mut Db,
    method: &str,
    path: &str,
    _query: &str,
    body: &Value,
) -> Option<Result<(u16, Value)>> {
    if !owns(method, path) {
        return None;
    }
    let p: Vec<_> = path.split('/').collect();
    let outcome = (|| -> Result<(u16, Value)> {
        let response = match p.as_slice() {
            ["","api","udb"] if method == "POST" => create_db(db,body)?,
            ["","api","udb"] => json!(db.query("select d.id, d.name, d.icon, d.page_id, d.sort_key, (select count(*)::int from udb_rows r where r.db_id = d.id and not r.deleted) as row_count from udb_databases d where not d.deleted order by d.sort_key, d.name",&[])?),
            ["","api","udb","icons"] => icons(db)?,
            ["","api","udb","links"] if method == "POST" => link(db,body)?,
            ["","api","udb","links"] => return read(db,"links"),
            ["","api","udb","props",id,"delete"] if method == "POST" => delete_prop(db,id)?,
            ["","api","udb","props",id] if method == "POST" => return Ok(match update_prop(db,id,body) { Ok(v)=>(200,v), Err(e)=>(400,json!({"error":e.to_string()})) }),
            ["","api","udb","rows",id,"delete"] if method == "POST" => delete_row(db,id)?,
            ["","api","udb","rows",id] if method == "POST" => patch_row(db,id,body)?,
            ["","api","udb",id,"delete"] if method == "POST" => delete_db(db,id)?,
            ["","api","udb",id,"props"] if method == "POST" => return Ok(match create_prop(db,id,body) { Ok(v)=>(200,v), Err(e)=>(400,json!({"error":e.to_string()})) }),
            ["","api","udb",id,"rows"] if method == "POST" => create_row(db,id,body)?,
            ["","api","udb",id] if method == "POST" => update_db(db,id,body)?,
            ["","api","udb",id] => return read(db,id),
            _ => bail!("unsupported UDB route"),
        };
        Ok((200, response))
    })();
    Some(outcome)
}
