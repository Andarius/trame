use anyhow::{Result, bail};
use bytes::BytesMut;
use postgres::{
    Client,
    types::{Format, IsNull, ToSql, Type, to_sql_checked},
};
use serde_json::{Map, Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
};

type OperationGate = Arc<Mutex<()>>;
fn operation_gate(root: &Path) -> Result<OperationGate> {
    static GATES: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();
    let mut gates = GATES
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| anyhow::anyhow!("database gate unavailable"))?;
    let key = root.canonicalize()?;
    if let Some(gate) = gates.get(&key).and_then(Weak::upgrade) {
        return Ok(gate);
    }
    gates.retain(|_, gate| gate.strong_count() > 0);
    let gate = Arc::new(Mutex::new(()));
    gates.insert(key, Arc::downgrade(&gate));
    Ok(gate)
}

pub struct Db {
    pub client: Client,
    pub origin: String,
    settings: Option<PathBuf>,
    gate: OperationGate,
    in_operation: bool,
}

#[derive(Debug)]
struct Param<'a>(&'a Value);
impl ToSql for Param<'_> {
    fn to_sql(
        &self,
        ty: &Type,
        out: &mut BytesMut,
    ) -> Result<IsNull, Box<dyn std::error::Error + Sync + Send>> {
        if self.0.is_null() {
            return Ok(IsNull::Yes);
        }
        let text = if *ty == Type::BOOL {
            if self.0 == &Value::Bool(true) {
                "t".into()
            } else {
                "f".into()
            }
        } else if matches!(*ty, Type::JSON | Type::JSONB) {
            self.0
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| crate::json::stringify(self.0))
        } else if matches!(ty.kind(), postgres::types::Kind::Array(_)) {
            let items = self.0.as_array().ok_or("array parameter expected")?;
            format!(
                "{{{}}}",
                items
                    .iter()
                    .map(|v| format!(
                        "\"{}\"",
                        trame_core::js_string(v)
                            .replace('\\', "\\\\")
                            .replace('"', "\\\"")
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        } else if self.0.is_number() {
            crate::json::stringify(self.0)
        } else {
            trame_core::js_string(self.0)
        };
        out.extend_from_slice(text.as_bytes());
        Ok(IsNull::No)
    }
    fn accepts(_: &Type) -> bool {
        true
    }
    fn encode_format(&self, _: &Type) -> Format {
        Format::Text
    }
    to_sql_checked!();
}

impl Db {
    pub fn settings_path(&self) -> Result<&Path> {
        self.settings
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("settings path unavailable"))
    }
    pub fn connect(socket: &Path, origin: &str, settings: Option<PathBuf>) -> Result<Self> {
        let root = socket
            .parent()
            .ok_or_else(|| anyhow::anyhow!("socket parent missing"))?;
        if crate::isolated_mode() {
            crate::scratch_path(root)?;
        }
        Ok(Self {
            client: crate::pg::connect(root)?,
            origin: origin.into(),
            settings,
            gate: operation_gate(root)?,
            in_operation: false,
        })
    }
    /// Keep multi-query local operations and sync scans from interleaving.
    pub fn exclusive<T>(&mut self, work: impl FnOnce(&mut Self) -> Result<T>) -> Result<T> {
        if self.in_operation {
            return work(self);
        }
        let gate = self.gate.clone();
        let _guard = gate
            .lock()
            .map_err(|_| anyhow::anyhow!("database operation panicked"))?;
        self.in_operation = true;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| work(self)));
        self.in_operation = false;
        match result {
            Ok(result) => result,
            Err(panic) => std::panic::resume_unwind(panic),
        }
    }
    pub fn batch_execute(&mut self, sql: &str) -> Result<()> {
        self.exclusive(|db| db.client.batch_execute(sql).map_err(db_error))
    }
    pub fn query(&mut self, sql: &str, params: &[Value]) -> Result<Vec<Value>> {
        self.exclusive(|db| db.query_inner(sql, params))
    }
    fn query_inner(&mut self, sql: &str, params: &[Value]) -> Result<Vec<Value>> {
        let values: Vec<_> = params.iter().map(Param).collect();
        let refs: Vec<&(dyn ToSql + Sync)> = values.iter().map(|p| p as _).collect();
        let types: Vec<_> = params.iter().map(inferred_type).collect();
        let statement = self.client.prepare_typed(sql, &types).map_err(db_error)?;
        self.client
            .query(&statement, &refs)
            .map_err(db_error)?
            .iter()
            .map(|row| {
                let mut object = Map::new();
                for (i, col) in row.columns().iter().enumerate() {
                    let value = match *col.type_() {
                        Type::NUMERIC => json!(row.try_get::<_, Option<Numeric>>(i)?.map(|n| n.0)),
                        Type::BOOL => json!(row.try_get::<_, Option<bool>>(i)?),
                        Type::INT2 => json!(row.try_get::<_, Option<i16>>(i)?),
                        Type::INT4 => json!(row.try_get::<_, Option<i32>>(i)?),
                        Type::INT8 => json!(row.try_get::<_, Option<i64>>(i)?),
                        Type::FLOAT4 => json!(row.try_get::<_, Option<f32>>(i)?),
                        Type::FLOAT8 => json!(row.try_get::<_, Option<f64>>(i)?),
                        Type::JSON | Type::JSONB => {
                            row.try_get::<_, Option<Value>>(i)?.unwrap_or(Value::Null)
                        }
                        Type::UUID => json!(
                            row.try_get::<_, Option<uuid::Uuid>>(i)?
                                .map(|v| v.to_string())
                        ),
                        Type::TIMESTAMPTZ => json!(
                            row.try_get::<_, Option<chrono::DateTime<chrono::Utc>>>(i)?
                                .map(|v| v.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
                        ),
                        Type::TEXT_ARRAY | Type::VARCHAR_ARRAY => {
                            json!(row.try_get::<_, Option<Vec<String>>>(i)?)
                        }
                        Type::UUID_ARRAY => json!(
                            row.try_get::<_, Option<Vec<uuid::Uuid>>>(i)?
                                .map(|v| v.iter().map(ToString::to_string).collect::<Vec<_>>())
                        ),
                        Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME | Type::UNKNOWN => {
                            json!(row.try_get::<_, Option<String>>(i)?)
                        }
                        ref ty => bail!("unsupported result type {}", ty.name()),
                    };
                    object.insert(col.name().into(), value);
                }
                Ok(Value::Object(object))
            })
            .collect()
    }
    pub fn identity(&mut self) -> Result<Value> {
        let origin = self.origin.clone();
        let rows = self.query("select u.id,u.name,u.avatar from devices d join users u on u.id=d.user_id and not u.deleted where d.node_id=$1 and not d.deleted limit 1", &[json!(origin)])?;
        let user = rows.first().cloned().unwrap_or(Value::Null);
        let settings: Value = self
            .settings
            .as_ref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or(Value::Null);
        let name = [
            settings["authorName"].as_str().unwrap_or(""),
            user["name"].as_str().unwrap_or(""),
            &origin,
        ]
        .into_iter()
        .map(trame_core::trim)
        .find(|s| !s.is_empty())
        .unwrap_or("");
        let avatar = [
            settings["authorAvatar"].as_str().unwrap_or(""),
            user["avatar"].as_str().unwrap_or(""),
        ]
        .into_iter()
        .map(trame_core::trim)
        .find(|s| !s.is_empty())
        .unwrap_or("");
        Ok(json!({"userId":user["id"],"name":name,"avatar":avatar}))
    }
}
fn db_error(e: postgres::Error) -> anyhow::Error {
    let message = e
        .as_db_error()
        .map(|e| e.message().to_owned())
        .unwrap_or_else(|| e.to_string());
    anyhow::Error::new(e).context(message)
}

fn inferred_type(value: &Value) -> Type {
    match value {
        Value::Bool(_) => Type::BOOL,
        Value::Array(values) => values.first().map(inferred_type).unwrap_or(Type::UNKNOWN),
        _ => Type::UNKNOWN,
    }
}

struct Numeric(String);
impl<'a> postgres::types::FromSql<'a> for Numeric {
    fn from_sql(
        _: &Type,
        bytes: &'a [u8],
    ) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        if bytes.len() < 8 || bytes.len() % 2 != 0 {
            return Err("invalid numeric header".into());
        }
        let fields: Vec<_> = bytes
            .chunks_exact(2)
            .map(|b| u16::from_be_bytes([b[0], b[1]]))
            .collect();
        let count = usize::from(fields[0]);
        let weight = i32::from(fields[1] as i16);
        let sign = fields[2];
        let scale = usize::from(fields[3]);
        if fields.len() != count + 4 {
            return Err("invalid numeric digit count".into());
        }
        let special = match sign {
            0xc000 => Some("NaN"),
            0xd000 => Some("Infinity"),
            0xf000 => Some("-Infinity"),
            0 | 0x4000 => None,
            _ => return Err("invalid numeric sign".into()),
        };
        if let Some(special) = special {
            return Ok(Self(special.into()));
        }
        let digits = &fields[4..];
        if digits.iter().any(|d| *d >= 10000) {
            return Err("invalid numeric digit".into());
        }
        let digit = |power: i32| -> u16 {
            let index = weight - power;
            if index < 0 {
                0
            } else {
                digits.get(index as usize).copied().unwrap_or(0)
            }
        };
        let mut text = if sign == 0x4000 {
            "-".to_owned()
        } else {
            String::new()
        };
        if weight < 0 {
            text.push('0')
        } else {
            for power in (0..=weight).rev() {
                if power == weight {
                    text.push_str(&digit(power).to_string())
                } else {
                    text.push_str(&format!("{:04}", digit(power)))
                }
            }
        }
        if scale > 0 {
            text.push('.');
            let start = text.len();
            for i in 1..=scale.div_ceil(4) {
                text.push_str(&format!("{:04}", digit(-(i as i32))))
            }
            text.truncate(start + scale);
        }
        Ok(Self(text))
    }
    fn accepts(ty: &Type) -> bool {
        *ty == Type::NUMERIC
    }
}
