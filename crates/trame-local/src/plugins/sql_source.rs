// SQL source: fill a user database from a read-only query on an external Postgres.
// Connection strings stay in the device-local settings slice; only the rows sync.
use crate::{db::Db, routes::Native, settings, udb};
use anyhow::{Context, Result, bail};
use postgres::{NoTls, config::SslMode, types::Type};
use serde_json::{Map, Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    str::FromStr,
    sync::Mutex,
    time::{Duration, Instant},
};

pub const ID: &str = "sql-source";
pub const MAX_ROWS: usize = 10_000;
const TIMEOUT_MS: u64 = 30_000;
const PREVIEW_ROWS: usize = 50;
/// rows a dry run's table preview lists
const DRY_ROWS: usize = 200;
const MIN_INTERVAL_MIN: u32 = 5;
const MAX_INTERVAL_MIN: u32 = 43_200; // 30 days
const WRITABLE: [&str; 6] = ["title", "text", "url", "number", "checkbox", "date"];

static RUNNING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// What a refresh needs from the app: its database socket, node id and settings file.
#[derive(Clone)]
pub struct Env {
    pub root: PathBuf,
    pub origin: String,
    pub settings: PathBuf,
}

impl Env {
    pub fn of(state: &Native) -> Self {
        Self {
            root: state.root.clone(),
            origin: state.origin.clone(),
            settings: state.settings.clone(),
        }
    }
    fn db(&self) -> Result<Db> {
        Db::connect(
            &self.root.join("socket"),
            &self.origin,
            Some(self.settings.clone()),
        )
    }
    fn slice(&self) -> Value {
        settings::plugin(&self.settings, ID)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Source {
    pub id: String,
    pub name: String,
    pub connection_id: String,
    pub query: String,
    pub db_id: String,
    pub key_column: String,
    /// query column → database column name (`None` skips it); unlisted columns keep their name
    pub columns: Vec<(String, Option<String>)>,
    pub interval_min: u32,
    pub delete_missing: bool,
    pub paused: bool,
}

/// A failure meant for the user (bad query, bad key…), as opposed to an internal error.
#[derive(Debug)]
pub struct SourceError(pub String);
impl std::fmt::Display for SourceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for SourceError {}

fn refuse<T>(message: impl Into<String>) -> Result<T> {
    Err(SourceError(message.into()).into())
}

fn text(v: &Value) -> String {
    v.as_str().map(str::trim).unwrap_or("").to_owned()
}

fn is_uuid(s: &str) -> bool {
    uuid::Uuid::parse_str(s).is_ok()
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "clamped to 0..=MAX_INTERVAL_MIN first"
)]
fn parse_source(v: &Value) -> Option<Source> {
    let id = text(&v["id"]);
    if id.is_empty() {
        return None;
    }
    let db_id = text(&v["db_id"]);
    Some(Source {
        id,
        name: text(&v["name"]),
        connection_id: text(&v["connection_id"]),
        query: v["query"].as_str().unwrap_or("").to_owned(),
        db_id: if is_uuid(&db_id) {
            db_id
        } else {
            String::new()
        },
        key_column: text(&v["key_column"]),
        columns: v["columns"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|c| {
                let from = text(&c["from"]);
                let to = text(&c["to"]);
                (!from.is_empty()).then(|| (from, (!to.is_empty()).then_some(to)))
            })
            .collect(),
        interval_min: v["interval_min"].as_f64().map_or(0, |n| {
            // anything scheduled runs at most every MIN_INTERVAL_MIN
            match n.round().clamp(0.0, f64::from(MAX_INTERVAL_MIN)) as u32 {
                0 => 0,
                m => m.max(MIN_INTERVAL_MIN),
            }
        }),
        delete_missing: v["delete_missing"] == true,
        paused: v["paused"] == true,
    })
}

fn source_json(s: &Source) -> Value {
    let columns: Vec<_> = s
        .columns
        .iter()
        .map(|(from, to)| json!({"from": from, "to": to}))
        .collect();
    json!({"id":s.id,"name":s.name,"connection_id":s.connection_id,"query":s.query,"db_id":s.db_id,"key_column":s.key_column,"columns":columns,"interval_min":s.interval_min,"delete_missing":s.delete_missing,"paused":s.paused})
}

pub fn sources(slice: &Value) -> Vec<Source> {
    slice["sources"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(parse_source)
        .collect()
}

/// `{id, name, dsn}` entries; the dsn never leaves this module except into a connection.
fn connections(slice: &Value) -> Vec<Value> {
    slice["connections"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| !text(&c["id"]).is_empty())
        .map(|c| json!({"id":text(&c["id"]),"name":text(&c["name"]),"dsn":text(&c["dsn"])}))
        .collect()
}

fn dsn_of(slice: &Value, connection_id: &str) -> Option<String> {
    connections(slice)
        .into_iter()
        .find(|c| c["id"] == connection_id)
        .map(|c| text(&c["dsn"]))
        .filter(|d| !d.is_empty())
}

/// The slice as the UI sees it: connections answer `hasDsn`, never the string.
pub fn settings_view(slice: &Value) -> Value {
    let connections: Vec<_> = connections(slice)
        .into_iter()
        .map(|c| json!({"id":c["id"],"name":c["name"],"host":host_of(c["dsn"].as_str().unwrap_or("")),"hasDsn":!text(&c["dsn"]).is_empty()}))
        .collect();
    json!({
        "enabled": slice["enabled"] == true,
        "connections": connections,
        "sources": sources(slice).iter().map(source_json).collect::<Vec<_>>(),
    })
}

/// `host:port` or the socket dir, for the connection picker; never credentials.
fn host_of(dsn: &str) -> String {
    let Ok(config) = postgres::Config::from_str(dsn) else {
        return String::new();
    };
    let host = config.get_hosts().first().map(|h| match h {
        postgres::config::Host::Tcp(h) => h.clone(),
        postgres::config::Host::Unix(p) => p.display().to_string(),
    });
    match (host, config.get_ports().first()) {
        (Some(h), Some(p)) => format!("{h}:{p}"),
        (Some(h), None) => h,
        _ => String::new(),
    }
}

/// Settings POST from the plugins manager: renames, removals and new DSNs; an empty dsn keeps the stored one.
pub fn sanitize(raw: &Value, current: &Value) -> Value {
    let mut patch = json!({});
    if let Some(list) = raw["connections"].as_array() {
        let before = connections(current);
        let kept: Vec<_> = list
            .iter()
            .filter_map(|c| {
                let id = text(&c["id"]);
                let id = if id.is_empty() {
                    uuid::Uuid::new_v4().to_string()
                } else {
                    id
                };
                let dsn = Some(text(&c["dsn"]))
                    .filter(|d| !d.is_empty())
                    .or_else(|| {
                        before
                            .iter()
                            .find(|b| b["id"] == id.as_str())
                            .map(|b| text(&b["dsn"]))
                    })?;
                Some(json!({"id":id,"name":text(&c["name"]),"dsn":dsn}))
            })
            .collect();
        patch["connections"] = json!(kept);
    }
    if let Some(list) = raw["sources"].as_array() {
        let kept: Vec<_> = list
            .iter()
            .filter_map(parse_source)
            .map(|s| source_json(&s))
            .collect();
        patch["sources"] = json!(kept);
    }
    patch
}

fn scrub(message: &str, dsn: &str) -> String {
    let mut out = if dsn.is_empty() {
        message.to_owned()
    } else {
        message.replace(dsn, "<connection string>")
    };
    if let Ok(config) = postgres::Config::from_str(dsn) {
        if let Some(password) = config
            .get_password()
            .and_then(|p| std::str::from_utf8(p).ok())
        {
            if !password.is_empty() {
                out = out.replace(password, "***");
            }
        }
    }
    out
}

// Query

pub struct SourceResult {
    pub columns: Vec<(String, String)>, // (name, udb type it maps to)
    pub rows: Vec<Map<String, Value>>,
}

fn type_for(ty: &Type) -> &'static str {
    match *ty {
        Type::BOOL => "checkbox",
        Type::INT2
        | Type::INT4
        | Type::INT8
        | Type::OID
        | Type::FLOAT4
        | Type::FLOAT8
        | Type::NUMERIC => "number",
        Type::DATE | Type::TIMESTAMP | Type::TIMESTAMPTZ => "date",
        _ => "text",
    }
}

fn connect(dsn: &str) -> Result<postgres::Client> {
    let Ok(mut config) = postgres::Config::from_str(dsn) else {
        return refuse("the connection string is not a valid postgres:// URL");
    };
    if matches!(config.get_ssl_mode(), SslMode::Require) {
        return refuse(
            "TLS connections are not supported yet (sslmode=require) — use a local or tailnet database",
        );
    }
    if config.get_connect_timeout().is_none() {
        config.connect_timeout(Duration::from_secs(10));
    }
    config
        .application_name("trame sql-source")
        .options(&format!(
            "-c default_transaction_read_only=on -c statement_timeout={TIMEOUT_MS}"
        ));
    config
        .connect(NoTls)
        // Display hides the cause ("error connecting to server"); the source holds it
        .or_else(|e| {
            let cause = std::error::Error::source(&e)
                .map_or_else(|| e.to_string(), |c| format!("{e}: {c}"));
            refuse(scrub(&cause, dsn))
        })
}

/// Run `query` read-only and return at most `max_rows` rows; refuses (never truncates) past it.
pub fn run_query(dsn: &str, query: &str, max_rows: usize) -> Result<SourceResult> {
    let body = query.trim().trim_end_matches(';').trim_end();
    if body.is_empty() {
        return refuse("the query is empty");
    }
    let mut client = connect(dsn)?;
    let fail = |e: postgres::Error| -> anyhow::Error {
        let message = e
            .as_db_error()
            .map_or_else(|| e.to_string(), |d| d.message().to_owned());
        SourceError(scrub(&message, dsn)).into()
    };
    let mut tx = client
        .build_transaction()
        .read_only(true)
        .start()
        .map_err(fail)?;
    // extended protocol: one statement only, so nothing can COMMIT out of the read-only transaction
    let shape = tx
        .prepare(&format!("select * from (\n{body}\n) as sql_source limit 0"))
        .map_err(fail)?;
    let mut columns = Vec::new();
    for c in shape.columns() {
        if columns.iter().any(|(name, _)| name == c.name()) {
            return refuse(format!(
                "column \"{}\" appears twice — alias one of them",
                c.name()
            ));
        }
        columns.push((c.name().to_owned(), type_for(c.type_()).to_owned()));
    }
    let rows = tx
        .query(
            &format!(
                "select row_to_json(sql_source)::text from (\n{body}\n) as sql_source limit {}",
                max_rows + 1
            ),
            &[],
        )
        .map_err(fail)?;
    if rows.len() > max_rows {
        return refuse(format!(
            "the query returns more than {max_rows} rows — narrow it"
        ));
    }
    let rows = rows
        .iter()
        .map(
            |r| match serde_json::from_str::<Value>(r.get::<_, &str>(0))? {
                Value::Object(m) => Ok(m),
                _ => bail!("unexpected row shape"),
            },
        )
        .collect::<Result<Vec<_>>>()?;
    Ok(SourceResult { columns, rows })
}

/// A source value in the cell shape of a `kind` column; null clears the cell.
pub fn cell_value(kind: &str, v: &Value) -> Value {
    match (kind, v) {
        (_, Value::Null) => Value::Null,
        ("number", Value::Number(_)) => v.clone(),
        ("number", Value::String(s)) => s
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite())
            .map_or(Value::Null, |n| json!(n)),
        ("number", _) => Value::Null,
        ("checkbox", Value::Bool(b)) => json!(b),
        ("checkbox", other) => {
            json!(matches!(other.as_str(), Some("t" | "true")) || other.as_i64() == Some(1))
        }
        ("date", Value::String(s))
            if s.len() >= 10 && s.as_bytes()[4] == b'-' && s.as_bytes()[7] == b'-' =>
        {
            json!({"start": &s[..10]})
        }
        ("date", _) => Value::Null,
        (_, Value::String(s)) => json!(s),
        (_, Value::Number(n)) => json!(n.to_string()),
        (_, Value::Bool(b)) => json!(b.to_string()),
        (_, other) => json!(crate::json::stringify(other)),
    }
}

/// Values as one comparable key: numbers by value (41 == 41.0), empty → none.
fn canon(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) if s.is_empty() => None,
        Value::Number(n) => n.as_f64().map(|f| format!("{f}")),
        other => Some(crate::json::stringify(other)),
    }
}

fn same(a: &Value, b: &Value) -> bool {
    canon(a) == canon(b)
}

// Apply

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Counts {
    pub rows: usize,
    pub created: usize,
    pub updated: usize,
    pub deleted: usize,
    pub new_columns: Vec<(String, String)>,
    pub claimed_columns: Vec<String>,
    pub released_columns: Vec<String>,
    /// the database as the write leaves it, row by row; dry runs only
    pub preview: Option<Value>,
}

impl Counts {
    fn json(&self) -> Value {
        json!({
            "rows": self.rows, "created": self.created, "updated": self.updated, "deleted": self.deleted,
            "new_columns": self.new_columns.iter().map(|(n, t)| json!({"name": n, "type": t})).collect::<Vec<_>>(),
            "claimed_columns": self.claimed_columns,
            "released_columns": self.released_columns,
        })
    }
}

struct Plan {
    prop_id: Option<String>,
    column: String,
    target: String,
    kind: String,
    claim: bool,
}

/// Write `result` into the source's database inside one transaction; `dry_run` rolls it back.
/// Columns match by the mapping, else by the result column they were made for, then by name;
/// rows match by key.
pub fn apply(db: &mut Db, source: &Source, result: &SourceResult, dry_run: bool) -> Result<Counts> {
    db.exclusive(|db| {
        db.batch_execute("begin")?;
        let outcome = apply_inner(db, source, result, dry_run);
        db.batch_execute(if dry_run || outcome.is_err() {
            "rollback"
        } else {
            "commit"
        })?;
        outcome
    })
}

/// The database column a query column fills: its mapping, else its own name; `None` skips it.
fn target_of(source: &Source, column: &str) -> Option<String> {
    source
        .columns
        .iter()
        .find(|(from, _)| from == column)
        .map_or_else(|| Some(column.to_owned()), |(_, to)| to.clone())
}

#[allow(clippy::too_many_lines, reason = "one transaction, read top to bottom")]
fn apply_inner(
    db: &mut Db,
    source: &Source,
    result: &SourceResult,
    preview: bool,
) -> Result<Counts> {
    let (status, data) = udb::read(db, &source.db_id)?;
    if status != 200 {
        return refuse("the target database no longer exists");
    }
    let props = data["properties"].as_array().cloned().unwrap_or_default();
    if !result.columns.iter().any(|(n, _)| n == &source.key_column) {
        return refuse(format!(
            "key column \"{}\" is not in the query results",
            source.key_column
        ));
    }
    if target_of(source, &source.key_column).is_none() {
        return refuse("the key column can't be skipped");
    }
    let mut plans = Vec::new();
    let mut targets = HashSet::new();
    for (column, kind) in &result.columns {
        let Some(target) = target_of(source, column) else {
            continue;
        };
        if !targets.insert(target.clone()) {
            return refuse(format!(
                "two query columns fill \"{target}\" — map one elsewhere"
            ));
        }
        let by_name = || props.iter().find(|p| p["name"] == target.as_str());
        let prop = if source.columns.iter().any(|(from, _)| from == column) {
            by_name()
        } else {
            props
                .iter()
                .find(|p| {
                    p["config"]["source"] == source.id.as_str()
                        && p["config"]["source_column"] == column.as_str()
                })
                .or_else(by_name)
        };
        let Some(prop) = prop else {
            plans.push(Plan {
                prop_id: None,
                column: column.clone(),
                target,
                kind: kind.clone(),
                claim: false,
            });
            continue;
        };
        let config = &prop["config"];
        // an explicit null is a column the user detached: it is theirs now
        let theirs = config.get("source").is_some() && config["source"] != source.id.as_str();
        let prop_type = prop["type"].as_str().unwrap_or("");
        if theirs || !WRITABLE.contains(&prop_type) {
            if column == &source.key_column {
                return refuse(format!(
                    "key column \"{column}\" is not writable by this source"
                ));
            }
            continue;
        }
        plans.push(Plan {
            prop_id: prop["id"].as_str().map(str::to_owned),
            column: column.clone(),
            target,
            kind: prop_type.to_owned(),
            claim: config["source"] != source.id.as_str()
                || config["source_column"] != column.as_str(),
        });
    }

    let key_plan = plans
        .iter()
        .find(|p| p.column == source.key_column)
        .context("key plan")?;
    let mut keys = Vec::with_capacity(result.rows.len());
    let mut seen = HashSet::new();
    for row in &result.rows {
        let Some(key) = canon(&cell_value(&key_plan.kind, &row[&source.key_column])) else {
            return refuse(format!(
                "key column \"{}\" has empty values",
                source.key_column
            ));
        };
        if !seen.insert(key.clone()) {
            return refuse(format!(
                "key column \"{}\" is not unique ({key})",
                source.key_column
            ));
        }
        keys.push(key);
    }
    let mut existing: HashMap<String, &Value> = HashMap::new();
    let rows = data["rows"].as_array().cloned().unwrap_or_default();
    if let Some(key_prop) = &key_plan.prop_id {
        for row in &rows {
            if let Some(k) = canon(&row["vals"][key_prop]) {
                existing.entry(k).or_insert(row);
            }
        }
    }

    let mut counts = Counts {
        rows: result.rows.len(),
        ..Counts::default()
    };
    // columns this source filled but no longer maps go back to the user
    let kept: HashSet<&str> = plans.iter().filter_map(|p| p.prop_id.as_deref()).collect();
    for prop in &props {
        let id = prop["id"].as_str().unwrap_or("");
        if prop["config"]["source"] == source.id.as_str() && !kept.contains(id) {
            db.query(
                "update udb_properties set config = config - 'source' - 'source_column' - 'source_name', origin=$2, updated_at=now() where id=$1",
                &[json!(id), json!(db.origin)],
            )?;
            counts
                .released_columns
                .push(prop["name"].as_str().unwrap_or("").to_owned());
        }
    }
    for plan in &mut plans {
        let config =
            json!({"source": source.id, "source_column": plan.column, "source_name": source.name});
        match &plan.prop_id {
            Some(id) if plan.claim => {
                udb::update_prop(db, id, &json!({"config": config}))?;
                counts.claimed_columns.push(plan.target.clone());
            }
            Some(_) => {}
            None => {
                let created = udb::create_prop(
                    db,
                    &source.db_id,
                    &json!({"name": plan.target, "type": plan.kind, "config": config}),
                )?;
                plan.prop_id = created["id"].as_str().map(str::to_owned);
                counts
                    .new_columns
                    .push((plan.target.clone(), plan.kind.clone()));
            }
        }
    }

    // row id → (op, previous values of the cells it changes), for the preview
    let mut ops: HashMap<String, (&str, Map<String, Value>)> = HashMap::new();
    for (row, key) in result.rows.iter().zip(&keys) {
        let vals: Map<String, Value> = plans
            .iter()
            .filter_map(|p| Some((p.prop_id.clone()?, cell_value(&p.kind, &row[&p.column]))))
            .collect();
        let Some(current) = existing.get(key) else {
            let vals: Map<_, _> = vals.into_iter().filter(|(_, v)| !v.is_null()).collect();
            let created = udb::create_row(db, &source.db_id, &json!({"vals": vals}))?;
            counts.created += 1;
            if let Some(id) = created["id"].as_str() {
                ops.insert(id.to_owned(), ("new", Map::new()));
            }
            continue;
        };
        let id = current["id"].as_str().context("row id")?;
        let patch: Map<_, _> = vals
            .into_iter()
            .filter(|(prop, v)| !same(&current["vals"][prop], v))
            .collect();
        if patch.is_empty() {
            ops.insert(id.to_owned(), ("same", Map::new()));
            continue;
        }
        let old = patch
            .keys()
            .map(|prop| (prop.clone(), current["vals"][prop].clone()))
            .collect();
        udb::patch_row(db, id, &json!({"vals": patch}))?;
        counts.updated += 1;
        ops.insert(id.to_owned(), ("changed", old));
    }
    let mut removed = Vec::new();
    if source.delete_missing {
        for (key, row) in &existing {
            if !seen.contains(key) {
                udb::delete_row(db, row["id"].as_str().context("row id")?)?;
                counts.deleted += 1;
                removed.push((*row).clone());
            }
        }
    }
    if preview {
        counts.preview = Some(preview_json(db, source, &ops, &removed)?);
    }
    Ok(counts)
}

/// The database after the (uncommitted) write: columns, then rows tagged new/changed/same/kept/removed.
fn preview_json(
    db: &mut Db,
    source: &Source,
    ops: &HashMap<String, (&str, Map<String, Value>)>,
    removed: &[Value],
) -> Result<Value> {
    let (_, data) = udb::read(db, &source.db_id)?;
    let columns: Vec<_> = data["properties"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|p| {
            json!({"id": p["id"], "name": p["name"], "type": p["type"],
                   "source": p["config"]["source"] == source.id.as_str()})
        })
        .collect();
    let rows = data["rows"].as_array().cloned().unwrap_or_default();
    let mut out: Vec<Value> = rows
        .iter()
        .map(|r| {
            let (op, old) = ops
                .get(r["id"].as_str().unwrap_or(""))
                .map_or(("kept", Map::new()), |(op, old)| (*op, old.clone()));
            json!({"id": r["id"], "op": op, "vals": r["vals"], "old": old})
        })
        .collect();
    out.extend(
        removed
            .iter()
            .map(|r| json!({"id": r["id"], "op": "removed", "vals": r["vals"], "old": {}})),
    );
    let total = out.len();
    out.truncate(DRY_ROWS);
    Ok(json!({"columns": columns, "rows": out, "total": total}))
}

// Refresh and status

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn error_text(e: &anyhow::Error) -> String {
    e.downcast_ref::<SourceError>()
        .map_or_else(|| format!("{e:#}"), ToString::to_string)
}

fn run_and_apply(env: &Env, source: &Source, dsn: Option<&str>, dry_run: bool) -> Result<Counts> {
    if source.db_id.is_empty() {
        return refuse("no target database");
    }
    if source.key_column.is_empty() {
        return refuse("no key column");
    }
    let slice = env.slice();
    let dsn = dsn
        .map(str::to_owned)
        .or_else(|| dsn_of(&slice, &source.connection_id));
    let Some(dsn) = dsn else {
        return refuse("no connection — pick or add one");
    };
    let result = run_query(&dsn, &source.query, MAX_ROWS)?;
    let mut db = env.db()?;
    apply(&mut db, source, &result, dry_run)
}

/// Refresh one saved source now and record its status; a second caller while it runs gets `None`.
pub fn refresh(env: &Env, id: &str) -> Result<Option<Value>> {
    let Some(source) = sources(&env.slice()).into_iter().find(|s| s.id == id) else {
        return refuse("unknown source");
    };
    {
        let mut running = RUNNING
            .lock()
            .map_err(|_| anyhow::anyhow!("refresh state poisoned"))?;
        if !running
            .get_or_insert_with(HashSet::new)
            .insert(id.to_owned())
        {
            return Ok(None);
        }
    }
    let outcome = run_and_apply(env, &source, None, false);
    if let Ok(mut running) = RUNNING.lock() {
        running.get_or_insert_with(HashSet::new).remove(id);
    }
    let mut status = match &outcome {
        Ok(counts) => counts.json(),
        Err(e) => json!({"rows":0,"created":0,"updated":0,"deleted":0,"error":error_text(e)}),
    };
    status["refreshed_at"] = json!(now());
    if status.get("error").is_none() {
        status["error"] = Value::Null;
    }
    settings::update(&env.settings, |s| {
        s["plugins"][ID]["status"][id] = status.clone();
        Ok(())
    })?;
    Ok(Some(status))
}

fn is_running(id: &str) -> bool {
    RUNNING
        .lock()
        .ok()
        .is_some_and(|r| r.as_ref().is_some_and(|r| r.contains(id)))
}

fn next_at(source: &Source, last: &Value) -> Value {
    if source.interval_min == 0 || source.paused {
        return Value::Null;
    }
    let base = last["refreshed_at"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map_or_else(chrono::Utc::now, |d| d.with_timezone(&chrono::Utc));
    json!(
        (base + chrono::Duration::minutes(i64::from(source.interval_min)))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    )
}

fn due(source: &Source, last: &Value, at: chrono::DateTime<chrono::Utc>) -> bool {
    if source.paused || source.interval_min == 0 {
        return false;
    }
    next_at(source, last)
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .is_none_or(|next| last["refreshed_at"].is_null() || next <= at)
}

fn status(slice: &Value) -> Value {
    let list: Vec<_> = sources(slice)
        .iter()
        .map(|s| {
            let last = &slice["status"][&s.id];
            let connection = connections(slice).into_iter().find(|c| c["id"] == s.connection_id.as_str());
            json!({
                "id": s.id, "name": s.name, "db_id": s.db_id, "interval_min": s.interval_min, "paused": s.paused,
                "connection": connection.map(|c| c["name"].clone()),
                "running": is_running(&s.id),
                "last": if last.is_object() { last.clone() } else { Value::Null },
                "next_at": next_at(s, last),
            })
        })
        .collect();
    json!({"enabled": slice["enabled"] == true, "sources": list})
}

// Routes

/// A new connection from a draft `{name, dsn}`, or the saved one `connection_id` names.
fn draft_connection(env: &Env, body: &Value) -> Result<(String, String)> {
    let slice = env.slice();
    let dsn = text(&body["dsn"]);
    if !dsn.is_empty() {
        return Ok((String::new(), dsn));
    }
    let id = text(&body["connection_id"]);
    match dsn_of(&slice, &id) {
        Some(dsn) => Ok((id, dsn)),
        None => refuse("no connection — pick or add one"),
    }
}

fn draft_source(body: &Value) -> Source {
    let mut v = body.clone();
    if text(&v["id"]).is_empty() {
        v["id"] = json!(uuid::Uuid::new_v4().to_string());
    }
    parse_source(&v).unwrap_or_else(|| unreachable!("id was just set"))
}

fn save_source(
    env: &Env,
    source: &Source,
    dsn: Option<&str>,
    connection_name: &str,
) -> Result<Source> {
    let mut source = source.clone();
    settings::update(&env.settings, |s| {
        if !s["plugins"][ID].is_object() {
            s["plugins"][ID] = json!({});
        }
        let slice = &mut s["plugins"][ID];
        if let Some(dsn) = dsn {
            let id = uuid::Uuid::new_v4().to_string();
            let name = if connection_name.is_empty() {
                host_of(dsn)
            } else {
                connection_name.to_owned()
            };
            let mut list = slice["connections"].as_array().cloned().unwrap_or_default();
            list.push(json!({"id": id, "name": name, "dsn": dsn}));
            slice["connections"] = json!(list);
            source.connection_id = id;
        }
        let mut list: Vec<Value> = slice["sources"].as_array().cloned().unwrap_or_default();
        list.retain(|v| v["id"] != source.id.as_str());
        list.push(source_json(&source));
        slice["sources"] = json!(list);
        Ok(())
    })?;
    Ok(source)
}

fn disconnect(env: &Env, id: &str) -> Result<Value> {
    let mut db = env.db()?;
    // columns go back to the user: drop the marker entirely so a later source may claim them again
    db.query(
        "update udb_properties set config = config - 'source' - 'source_column' - 'source_name', origin=$2, updated_at=now() where not deleted and config->>'source' = $1",
        &[json!(id), json!(db.origin)],
    )?;
    settings::update(&env.settings, |s| {
        let slice = &mut s["plugins"][ID];
        if let Some(list) = slice["sources"].as_array_mut() {
            list.retain(|v| v["id"] != id);
        }
        if let Some(status) = slice["status"].as_object_mut() {
            status.remove(id);
        }
        Ok(())
    })?;
    Ok(json!({"ok": true}))
}

fn set_paused(env: &Env, id: &str, paused: bool) -> Result<Value> {
    settings::update(&env.settings, |s| {
        if let Some(list) = s["plugins"][ID]["sources"].as_array_mut() {
            for v in list.iter_mut().filter(|v| v["id"] == id) {
                v["paused"] = json!(paused);
            }
        }
        Ok(())
    })?;
    Ok(json!({"ok": true, "paused": paused}))
}

fn preview(env: &Env, body: &Value) -> Result<Value> {
    let (_, dsn) = draft_connection(env, body)?;
    let started = Instant::now();
    let result = run_query(&dsn, body["query"].as_str().unwrap_or(""), MAX_ROWS)?;
    Ok(json!({
        "ok": true,
        "columns": result.columns.iter().map(|(n, t)| json!({"name": n, "type": t})).collect::<Vec<_>>(),
        "rows": result.rows.iter().take(PREVIEW_ROWS).collect::<Vec<_>>(),
        "count": result.rows.len(),
        "ms": started.elapsed().as_millis(),
    }))
}

fn user_error(e: &anyhow::Error) -> Option<Value> {
    e.downcast_ref::<SourceError>()
        .map(|e| json!({"ok": false, "error": e.0}))
}

/// `/api/plugins/sql-source/<sub>`; runs on a blocking thread (it may wait on the external database).
pub fn handle(env: &Env, method: &str, sub: &str, body: &Value) -> Result<(u16, Value)> {
    let slice = env.slice();
    match (sub, method) {
        ("/settings", "POST") => {
            settings::save_plugin(&env.settings, ID, &sanitize(body, &slice))?;
            return Ok((200, settings_view(&env.slice())));
        }
        ("/settings", _) => return Ok((200, settings_view(&slice))),
        ("/enable", "POST") => {
            let enabled = body["enabled"] == true;
            settings::save_plugin(&env.settings, ID, &json!({"enabled": enabled}))?;
            return Ok((200, json!({"enabled": enabled})));
        }
        _ => {}
    }
    if slice["enabled"] != true {
        return Ok((403, json!({"error": "plugin disabled"})));
    }
    let outcome = (|| -> Result<(u16, Value)> {
        let parts: Vec<_> = sub.split('/').collect();
        Ok(match (parts.as_slice(), method) {
            (["", "status"], _) => (200, status(&slice)),
            (["", "preview"], "POST") => (200, preview(env, body)?),
            (["", "sources"], "POST") => {
                let (connection_id, dsn) = draft_connection(env, body)?;
                let mut source = draft_source(body);
                source.connection_id = connection_id;
                let fresh = text(&body["dsn"]);
                if body["dry_run"] == true {
                    let counts = run_and_apply(env, &source, Some(&dsn), true)?;
                    let mut dry = counts.json();
                    dry["preview"] = counts.preview.unwrap_or(Value::Null);
                    return Ok((200, json!({"ok": true, "dry_run": dry})));
                }
                let saved = save_source(
                    env,
                    &source,
                    (!fresh.is_empty()).then_some(fresh.as_str()),
                    &text(&body["connection_name"]),
                )?;
                let status = refresh(env, &saved.id)?;
                (
                    200,
                    json!({"ok": true, "source": source_json(&saved), "status": status}),
                )
            }
            (["", "sources", id, "delete"], "POST") => (200, disconnect(env, id)?),
            (["", "sources", id, "pause"], "POST") => {
                (200, set_paused(env, id, body["paused"] != false)?)
            }
            (["", "refresh", id], "POST") => match refresh(env, id)? {
                Some(status) => (
                    200,
                    json!({"ok": status["error"].is_null(), "status": status}),
                ),
                None => (409, json!({"ok": false, "error": "already refreshing"})),
            },
            _ => (404, json!({"error": "not found"})),
        })
    })();
    match outcome {
        Err(e) => user_error(&e).map_or(Err(e), |v| Ok((400, v))),
        ok => ok,
    }
}

pub fn manifest(settings_path: &Path) -> Value {
    let slice = settings::plugin(settings_path, ID);
    let failing = sources(&slice)
        .iter()
        .filter(|s| {
            !slice["status"][&s.id]["error"].is_null() && slice["status"][&s.id].is_object()
        })
        .count();
    json!({"id": ID, "label": "SQL sources", "glyph": "⇣", "description": "Fill databases from a read-only query on a Postgres you choose.", "enabled": slice["enabled"] == true, "badge": if failing == 0 { Value::Null } else { json!(failing) }})
}

/// Refreshes due sources once a minute while the plugin is enabled.
pub fn start(state: &Native) -> tokio::task::JoinHandle<()> {
    let env = Env::of(state);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_mins(1)).await;
            let slice = env.slice();
            if slice["enabled"] != true {
                continue;
            }
            let at = chrono::Utc::now();
            for source in sources(&slice)
                .into_iter()
                .filter(|s| due(s, &slice["status"][&s.id], at))
            {
                let env = env.clone();
                let _ = crate::blocking::spawn(move || refresh(&env, &source.id)).await;
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intervals_are_manual_or_between_five_minutes_and_thirty_days() {
        for (given, kept) in [
            (json!(0), 0),
            (json!(1), 5),
            (json!(90), 90),
            (json!(1e9), 43_200),
            (json!(-3), 0),
        ] {
            let source = parse_source(&json!({"id": "s", "interval_min": given})).unwrap();
            assert_eq!(source.interval_min, kept, "{given}");
        }
    }

    #[test]
    fn cell_values_take_the_column_shape() {
        for (kind, raw, want) in [
            ("number", json!(41), json!(41)),
            ("number", json!("63.40"), json!(63.4)),
            ("number", json!("n/a"), Value::Null),
            ("checkbox", json!(true), json!(true)),
            ("checkbox", json!("t"), json!(true)),
            (
                "date",
                json!("2026-10-14T08:00:00+02:00"),
                json!({"start": "2026-10-14"}),
            ),
            ("date", json!("soon"), Value::Null),
            ("text", json!(12.5), json!("12.5")),
            ("text", json!({"a": 1}), json!("{\"a\":1}")),
            ("title", Value::Null, Value::Null),
        ] {
            assert_eq!(cell_value(kind, &raw), want, "{kind} {raw}");
        }
    }

    #[test]
    fn numbers_compare_by_value_and_empty_is_no_key() {
        for (a, b, want) in [
            (json!(41), json!(41.0), true),
            (json!("a"), json!("a"), true),
            (Value::Null, json!(""), true),
            (json!(1), json!("1"), false),
        ] {
            assert_eq!(same(&a, &b), want, "{a} {b}");
        }
    }

    #[test]
    fn settings_view_never_returns_the_dsn() {
        let slice = json!({"connections":[{"id":"c1","name":"sample","dsn":"postgres://u:hunter2@db.local:5433/x"}],"sources":[]});
        let view = crate::json::stringify(&settings_view(&slice));
        assert!(!view.contains("hunter2"), "{view}");
        assert!(
            view.contains("\"hasDsn\":true") && view.contains("db.local:5433"),
            "{view}"
        );
    }

    #[test]
    fn sanitize_keeps_a_stored_dsn_when_the_field_is_blank() {
        let current = json!({"connections":[{"id":"c1","name":"a","dsn":"postgres://x@h/db"}]});
        for (raw, want) in [
            (
                json!({"connections":[{"id":"c1","name":"renamed"}]}),
                Some("postgres://x@h/db"),
            ),
            (
                json!({"connections":[{"id":"c1","dsn":"postgres://y@h/db"}]}),
                Some("postgres://y@h/db"),
            ),
            (json!({"connections":[]}), None),
            (json!({"connections":[{"name":"no dsn"}]}), None),
        ] {
            let patch = sanitize(&raw, &current);
            assert_eq!(patch["connections"][0]["dsn"].as_str(), want, "{raw}");
        }
    }

    #[test]
    fn errors_mask_the_password() {
        let dsn = "postgres://u:hunter2@h/db";
        assert_eq!(scrub("auth failed for hunter2", dsn), "auth failed for ***");
        assert_eq!(scrub(&format!("bad {dsn}"), dsn), "bad <connection string>");
    }

    #[test]
    fn tls_dsns_are_refused_up_front() {
        let error = connect("postgres://u@127.0.0.1:1/db?sslmode=require")
            .err()
            .unwrap();
        assert!(error.to_string().contains("TLS"), "{error}");
    }
}
