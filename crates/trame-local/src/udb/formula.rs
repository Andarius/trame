use crate::db::Db;
use anyhow::{Context, Result, bail};
use postgres::{Client, NoTls};
use serde_json::{Value, json};
use std::{collections::HashMap, path::Path, time::Duration};

const SQL_WORDS: &[&str] = &[
    "case",
    "when",
    "then",
    "else",
    "end",
    "and",
    "or",
    "not",
    "null",
    "true",
    "false",
    "is",
    "in",
    "like",
    "ilike",
    "between",
    "symmetric",
    "distinct",
    "as",
    "from",
    "interval",
    "epoch",
    "year",
    "month",
    "day",
    "dow",
    "doy",
    "hour",
    "minute",
    "second",
    "week",
    "quarter",
    "numeric",
    "int",
    "integer",
    "bigint",
    "float",
    "text",
    "boolean",
    "date",
    "timestamptz",
    "timestamp",
];

fn prop_sql(prop: &Value) -> String {
    let id = prop["id"].as_str().unwrap_or("");
    match prop["type"].as_str().unwrap_or("") {
        "number" => format!("(r.vals->>'{id}')::numeric"),
        "checkbox" => format!("coalesce((r.vals->>'{id}')::boolean, false)"),
        "date" => format!("(r.vals#>>'{{{id},start}}')::timestamptz"),
        _ => format!("(r.vals->>'{id}')"),
    }
}

pub fn rewrite(expr: &str, props: &[Value]) -> Result<String> {
    if expr.trim().is_empty() {
        bail!("empty formula");
    }
    let mut names = HashMap::new();
    for prop in props {
        if !["formula", "rollup", "relation"].contains(&prop["type"].as_str().unwrap_or("")) {
            names.insert(prop["name"].as_str().unwrap_or("").to_lowercase(), prop);
        }
    }
    let bytes = expr.as_bytes();
    let mut result = String::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b';' => bail!("';' is not allowed in a formula"),
            b'\'' => {
                let start = i;
                i += 1;
                let mut closed = false;
                while i < bytes.len() {
                    if bytes[i] == b'\'' {
                        i += 1;
                        if i < bytes.len() && bytes[i] == b'\'' {
                            i += 1;
                        } else {
                            closed = true;
                            break;
                        }
                    } else {
                        i += 1;
                    }
                }
                if !closed {
                    bail!("unterminated string literal");
                }
                result.push_str(&expr[start..i]);
            }
            b'"' => {
                let end = expr[i + 1..]
                    .find('"')
                    .map(|offset| i + 1 + offset)
                    .context("unterminated \" in formula")?;
                let name = &expr[i + 1..end];
                let prop = names.get(&name.to_lowercase()).with_context(|| format!("unknown property \"{name}\" (formulas may reference stored properties only)"))?;
                result.push_str(&prop_sql(prop));
                i = end + 1;
            }
            c if c.is_ascii_alphabetic() || c == b'_' => {
                let start = i;
                i += 1;
                while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                    i += 1;
                }
                let word = &expr[start..i];
                let lower = word.to_lowercase();
                let function = expr[i..].trim_start().starts_with('(');
                if function || SQL_WORDS.contains(&lower.as_str()) {
                    result.push_str(word);
                } else if let Some(prop) = names
                    .get(&lower)
                    .or_else(|| names.get(&lower.replace('_', " ")))
                {
                    result.push_str(&prop_sql(prop));
                } else {
                    bail!("unknown identifier \"{word}\" — not a property or SQL keyword");
                }
            }
            _ => {
                let ch = expr[i..].chars().next().context("invalid formula text")?;
                result.push(ch);
                i += ch.len_utf8();
            }
        }
    }
    Ok(result)
}

fn error(error: postgres::Error) -> anyhow::Error {
    anyhow::anyhow!(
        error
            .as_db_error()
            .map(|e| e.message().to_owned())
            .unwrap_or_else(|| error.to_string())
    )
}

pub(crate) fn ensure_role(db: &mut Db) -> Result<()> {
    db.client
        .batch_execute(
            r#"
        do $$ begin
          if not exists (select from pg_roles where rolname='trame_formula') then
            create role trame_formula login;
          end if;
        end $$;
        alter role trame_formula nosuperuser nocreatedb nocreaterole noinherit
          noreplication nobypassrls login connection limit 4;
        do $$ declare name text; begin
          for name in select r.rolname from pg_auth_members m
            join pg_roles r on r.oid=m.roleid
            where m.member=(select oid from pg_roles where rolname='trame_formula') loop
            execute format('revoke %I from trame_formula', name);
          end loop;
        end $$;
        revoke all on all tables in schema public from trame_formula;
        grant usage on schema public to trame_formula;
        grant select on udb_rows to trame_formula;
        alter role trame_formula set statement_timeout='2s';
        alter role trame_formula set default_transaction_read_only=on;
        do $$ declare f regprocedure; begin
          for f in select oid::regprocedure from pg_proc where proname = any(array[
            'pg_logical_emit_message','pg_advisory_lock','pg_advisory_lock_shared',
            'pg_try_advisory_lock','pg_try_advisory_lock_shared']) loop
            execute format('revoke execute on function %s from public', f);
          end loop;
        end $$;
    "#,
        )
        .map_err(error)?;
    Ok(())
}

fn client(db: &mut Db) -> Result<Client> {
    let data: String = db
        .client
        .query_one("show data_directory", &[])
        .map_err(error)?
        .get(0);
    let root = Path::new(&data)
        .parent()
        .context("PostgreSQL root missing")?;
    if crate::isolated_mode() {
        crate::scratch_path(root)?;
    }
    let mut config = postgres::Config::new();
    config
        .host_path(root.join("socket"))
        .port(crate::pg::PORT)
        .user("trame_formula")
        .dbname("postgres")
        .connect_timeout(Duration::from_secs(1));
    config.connect(NoTls).map_err(error)
}

fn run(db: &mut Db, sql: &str, id: Option<&str>) -> Result<Vec<Value>> {
    let mut client = client(db)?;
    let mut tx = client.transaction().map_err(error)?;
    let result = if let Some(id) = id {
        let id = uuid::Uuid::parse_str(id)?;
        tx.query(sql, &[&id]).map_err(error)?
    } else {
        tx.query(sql, &[]).map_err(error)?
    };
    let mut values = Vec::with_capacity(result.len());
    for row in result {
        let mut data = serde_json::Map::new();
        for (index, col) in row.columns().iter().enumerate() {
            if col.name() == "id" {
                data.insert(
                    "id".into(),
                    json!(row.get::<_, uuid::Uuid>(index).to_string()),
                );
            } else if col.name() == "val" {
                data.insert(
                    "val".into(),
                    row.get::<_, Option<Value>>(index).unwrap_or(Value::Null),
                );
            }
        }
        if row
            .columns()
            .iter()
            .any(|column| column.name() == "value_type")
            && row.get::<_, String>("value_type") == "numeric"
            && data["val"].is_number()
        {
            data.insert("val".into(), json!(data["val"].to_string()));
        }
        values.push(Value::Object(data));
    }
    tx.rollback().map_err(error)?;
    Ok(values)
}

pub fn validate(db: &mut Db, expr: &str, props: &[Value]) -> Result<String> {
    let rewritten = rewrite(expr, props)?;
    let sql =
        format!("select to_jsonb(({rewritten})) as val from (select '{{}}'::jsonb as vals) r");
    run(db, &sql, None).map_err(|e| anyhow::anyhow!("invalid formula: {e}"))?;
    Ok(rewritten)
}

pub fn values(
    db: &mut Db,
    prop: &Value,
    props: &[Value],
    id: &str,
) -> Result<HashMap<String, Value>> {
    let expr = prop["config"]["expr"].as_str().unwrap_or("");
    let rewritten = rewrite(expr, props)?;
    let sql = format!(
        "select id, to_jsonb(val) as val, pg_typeof(val)::text as value_type from (select id, ({rewritten}) as val from udb_rows r where db_id=$1 and not deleted) q"
    );
    Ok(run(db, &sql, Some(id))?
        .into_iter()
        .map(|row| {
            (
                row["id"].as_str().unwrap_or("").to_owned(),
                row["val"].clone(),
            )
        })
        .collect())
}

fn valid_uuid(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok() && id.len() == 36
}

pub fn rollup(db: &mut Db, prop: &Value, props: &[Value]) -> Result<HashMap<String, Value>> {
    let cfg = &prop["config"];
    let rel = props
        .iter()
        .find(|p| p["id"] == cfg["relation_prop"] && p["type"] == "relation")
        .context("rollup: relation property missing")?;
    for key in ["target_prop", "date_prop"] {
        if let Some(value) = cfg.get(key) {
            if !valid_uuid(value.as_str().unwrap_or("")) {
                bail!("rollup: invalid property id");
            }
        }
    }
    let owner = rel["config"]["owner"].as_bool().unwrap_or(false);
    let owner_id = if owner {
        rel["id"].as_str().unwrap_or("")
    } else {
        rel["config"]["pair"].as_str().unwrap_or("")
    };
    let (row_col, tgt_col) = if owner {
        ("from_row", "to_row")
    } else {
        ("to_row", "from_row")
    };
    let source = format!(
        "(select distinct {row_col} as row_id, {tgt_col} as tgt from udb_links where prop_id=$1 and not deleted) l join udb_rows t on t.id = l.tgt and not t.deleted"
    );
    let agg = cfg["agg"].as_str().unwrap_or("count");
    let target = cfg["target_prop"].as_str().unwrap_or("undefined");
    let sql = match agg {
        "count" => format!("select l.row_id, count(*)::int as val from {source} group by l.row_id"),
        "latest" => {
            let date = cfg["date_prop"]
                .as_str()
                .map(|id| {
                    format!("coalesce((t.vals#>>'{{{id},start}}')::timestamptz, t.updated_at)")
                })
                .unwrap_or("t.updated_at".into());
            format!(
                "select distinct on (l.row_id) l.row_id, t.vals->>'{target}' as val from {source} order by l.row_id, {date} desc"
            )
        }
        "sum" | "avg" | "min" | "max" => format!(
            "select l.row_id, ({agg}((t.vals->>'{target}')::numeric))::text as val from {source} group by l.row_id"
        ),
        _ => bail!("rollup: unknown agg \"{agg}\""),
    };
    let rows = db.query(&sql, &[json!(owner_id)])?;
    Ok(rows
        .into_iter()
        .map(|row| {
            (
                row["row_id"].as_str().unwrap_or("").to_owned(),
                row["val"].clone(),
            )
        })
        .collect())
}
