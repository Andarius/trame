use crate::{db::Db, pages};
use anyhow::{Result, bail};
use serde_json::{Map, Value, json};
use std::collections::HashMap;

pub const BUNDLE_TAG: &str = "trame-page-bundle";

pub fn export(db: &mut Db, id: &str) -> Result<Value> {
    let pages=db.query("with recursive sub as (select * from pages where id=$1 and not deleted union all select p.* from pages p join sub on p.parent_id=sub.id where not p.deleted) select id,parent_id,kind,title,icon,brief,client_id,status,content,sort_key,color from sub",&[json!(id)])?;
    if pages.is_empty() {
        return Ok(Value::Null);
    }
    let page_ids = pages.iter().map(|p| p["id"].clone()).collect::<Vec<_>>();
    let mut db_ids = Vec::<Value>::new();
    for page in &pages {
        for block in page["content"].as_array().into_iter().flatten() {
            if block["type"] == "database"
                && block["db_id"].is_string()
                && !db_ids.contains(&block["db_id"])
            {
                db_ids.push(block["db_id"].clone());
            }
        }
    }
    for row in db.query(
        "select id from udb_databases where not deleted and page_id=any($1::uuid[])",
        &[json!(page_ids)],
    )? {
        if !db_ids.contains(&row["id"]) {
            db_ids.push(row["id"].clone());
        }
    }
    let databases = if db_ids.is_empty() {
        vec![]
    } else {
        db.query("select id,name,icon,sort_key,views,page_id from udb_databases where not deleted and id=any($1::uuid[])",&[json!(db_ids)])?
    };
    let properties = if db_ids.is_empty() {
        vec![]
    } else {
        db.query("select id,db_id,name,type,config,sort_key,width from udb_properties where not deleted and db_id=any($1::uuid[])",&[json!(db_ids)])?
    };
    let rows = if db_ids.is_empty() {
        vec![]
    } else {
        db.query("select id,db_id,icon,vals,sort_key from udb_rows where not deleted and db_id=any($1::uuid[])",&[json!(db_ids)])?
    };
    let props = properties
        .iter()
        .map(|p| p["id"].clone())
        .collect::<Vec<_>>();
    let row_ids = rows.iter().map(|r| r["id"].clone()).collect::<Vec<_>>();
    let links = if props.is_empty() || row_ids.is_empty() {
        vec![]
    } else {
        db.query("select id,prop_id,from_row,to_row from udb_links where not deleted and prop_id=any($1::uuid[]) and from_row=any($2::uuid[]) and to_row=any($2::uuid[])",&[json!(props),json!(row_ids)])?
    };
    Ok(
        json!({"trame":BUNDLE_TAG,"version":1,"exported_at":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"root":id,"pages":pages,"databases":databases,"properties":properties,"rows":rows,"links":links}),
    )
}

type IdMap = HashMap<String, String>;
fn mapped(map: &IdMap, id: &Value) -> Value {
    id.as_str()
        .and_then(|id| map.get(id))
        .map(|id| json!(id))
        .unwrap_or(Value::Null)
}
fn mapping(rows: &[Value]) -> IdMap {
    rows.iter()
        .filter_map(|r| r["id"].as_str())
        .map(|id| (id.to_owned(), uuid::Uuid::new_v4().to_string()))
        .collect()
}

fn remap_content(content: &Value, pages: &IdMap, databases: &IdMap) -> Value {
    json!(
        content
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|block| {
                let (map, key) = match block["type"].as_str() {
                    Some("subpage") => (pages, "page_id"),
                    Some("database") => (databases, "db_id"),
                    _ => return Some(block.clone()),
                };
                let id = mapped(map, &block[key]);
                if id.is_null() {
                    None
                } else {
                    let mut block = block.clone();
                    block[key] = id;
                    Some(block)
                }
            })
            .collect::<Vec<_>>()
    )
}
fn remap_views(views: &Value, props: &IdMap) -> Value {
    let Some(tabs) = views["tabs"].as_array() else {
        return if views.is_null() {
            json!([])
        } else {
            views.clone()
        };
    };
    let mut result = views.clone();
    result["tabs"] = json!(
        tabs.iter()
            .map(|tab| {
                let mut out = if tab.is_object() {
                    tab.clone()
                } else {
                    json!({})
                };
                let mut config = tab["config"].as_object().cloned().unwrap_or_default();
                for key in ["sorts", "filters"] {
                    if let Some(items) = config.get(key).and_then(Value::as_array) {
                        config.insert(
                            key.into(),
                            json!(
                                items
                                    .iter()
                                    .filter_map(|item| {
                                        let id = mapped(props, &item["propId"]);
                                        if id.is_null() {
                                            None
                                        } else {
                                            let mut item = item.clone();
                                            item["propId"] = id;
                                            Some(item)
                                        }
                                    })
                                    .collect::<Vec<_>>()
                            ),
                        );
                    }
                }
                if config.get("groupBy").is_some_and(trame_core::truthy) {
                    let id = mapped(props, &config["groupBy"]);
                    config.insert("groupBy".into(), id);
                }
                if let Some(aggs) = config.get("aggs").and_then(Value::as_object) {
                    let remap: Map<String, Value> = aggs
                        .iter()
                        .filter_map(|(key, v)| props.get(key).map(|id| (id.clone(), v.clone())))
                        .collect();
                    config.insert("aggs".into(), Value::Object(remap));
                }
                out["config"] = Value::Object(config);
                out
            })
            .collect::<Vec<_>>()
    );
    result
}
fn remap_config(prop: &Value, props: &IdMap, databases: &IdMap) -> Value {
    let mut config = prop["config"].as_object().cloned().unwrap_or_default();
    let keys: &[(&str, &IdMap)] = match prop["type"].as_str() {
        Some("relation") => &[("target_db", databases), ("pair", props)],
        Some("rollup") => &[
            ("relation_prop", props),
            ("target_prop", props),
            ("date_prop", props),
        ],
        _ => &[],
    };
    for (key, map) in keys {
        if let Some(value) = config.get(*key).filter(|v| trame_core::truthy(v)) {
            if let Some(id) = map.get(&trame_core::js_string(value)) {
                config.insert((*key).into(), json!(id));
            }
        }
    }
    Value::Object(config)
}

pub fn import(db: &mut Db, bundle: &Value, parent: &Value) -> Result<Value> {
    if bundle["trame"] != BUNDLE_TAG
        || !bundle["root"].is_string()
        || !["pages", "databases", "properties", "rows", "links"]
            .iter()
            .all(|key| bundle[*key].is_array())
    {
        bail!("not a Trame page bundle")
    }
    let pages = bundle["pages"].as_array().unwrap();
    let databases = bundle["databases"].as_array().unwrap();
    let rows = bundle["rows"].as_array().unwrap();
    let page_map = mapping(pages);
    let db_map = mapping(databases);
    let kept = bundle["properties"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| {
            p["type"] != "relation"
                || db_map.contains_key(&trame_core::js_string(&p["config"]["target_db"]))
        })
        .cloned()
        .collect::<Vec<_>>();
    let props = kept
        .iter()
        .filter(|p| {
            p["type"] != "rollup"
                || ["relation_prop", "target_prop", "date_prop"]
                    .iter()
                    .all(|key| {
                        !trame_core::truthy(&p["config"][*key])
                            || kept.iter().any(|k| k["id"] == p["config"][*key])
                    })
        })
        .cloned()
        .collect::<Vec<_>>();
    let prop_map = mapping(&props);
    let row_map = mapping(rows);
    let last=db.query("select max(sort_key) as k from pages where parent_id is not distinct from $1 and not deleted",&[parent.clone()])?;
    let root_key = pages::mid_key(last[0]["k"].as_str().unwrap_or(""), "");
    let owner = db.identity()?["userId"].clone();
    db.batch_execute("begin")?;
    let result = (|| -> Result<()> {
        for p in pages {
            let root = p["id"] == bundle["root"];
            db.query("insert into pages(id,parent_id,kind,title,icon,brief,client_id,status,content,sort_key,color,owner_id,origin) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",&[mapped(&page_map,&p["id"]),if root{parent.clone()}else{mapped(&page_map,&p["parent_id"])},p["kind"].clone(),p["title"].clone(),p["icon"].clone(),p["brief"].clone(),mapped(&page_map,&p["client_id"]),p["status"].clone(),json!(crate::json::stringify(&remap_content(&p["content"],&page_map,&db_map))),if root{json!(root_key)}else{p["sort_key"].clone()},p["color"].clone(),owner.clone(),json!(db.origin)])?;
        }
        for d in databases {
            db.query("insert into udb_databases(id,name,icon,sort_key,views,page_id,origin) values($1,$2,$3,$4,$5,$6,$7)",&[mapped(&db_map,&d["id"]),d["name"].clone(),d["icon"].clone(),d["sort_key"].clone(),json!(crate::json::stringify(&remap_views(&d["views"],&prop_map))),mapped(&page_map,&d["page_id"]),json!(db.origin)])?;
        }
        for p in &props {
            db.query("insert into udb_properties(id,db_id,name,type,config,sort_key,width,origin) values($1,$2,$3,$4,$5,$6,$7,$8)",&[mapped(&prop_map,&p["id"]),mapped(&db_map,&p["db_id"]),p["name"].clone(),p["type"].clone(),json!(crate::json::stringify(&remap_config(p,&prop_map,&db_map))),p["sort_key"].clone(),p["width"].clone(),json!(db.origin)])?;
        }
        for r in rows {
            let vals: Map<String, Value> = r["vals"]
                .as_object()
                .into_iter()
                .flatten()
                .filter_map(|(key, v)| prop_map.get(key).map(|id| (id.clone(), v.clone())))
                .collect();
            db.query("insert into udb_rows(id,db_id,icon,vals,sort_key,origin) values($1,$2,$3,$4,$5,$6)",&[mapped(&row_map,&r["id"]),mapped(&db_map,&r["db_id"]),r["icon"].clone(),json!(crate::json::stringify(&Value::Object(vals))),r["sort_key"].clone(),json!(db.origin)])?;
        }
        for link in bundle["links"].as_array().unwrap() {
            let prop = mapped(&prop_map, &link["prop_id"]);
            let from = mapped(&row_map, &link["from_row"]);
            let to = mapped(&row_map, &link["to_row"]);
            if prop.is_null() || from.is_null() || to.is_null() {
                continue;
            }
            db.query(
                "insert into udb_links(id,prop_id,from_row,to_row,origin) values($1,$2,$3,$4,$5)",
                &[
                    json!(uuid::Uuid::new_v4().to_string()),
                    prop,
                    from,
                    to,
                    json!(db.origin),
                ],
            )?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => db.batch_execute("commit")?,
        Err(e) => {
            let _ = db.batch_execute("rollback");
            return Err(e);
        }
    }
    Ok(mapped(&page_map, &bundle["root"]))
}
