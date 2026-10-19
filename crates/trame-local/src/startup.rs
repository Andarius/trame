#![allow(
    unsafe_code,
    reason = "libc FFI (flock/kill/killpg/prctl/getppid/waitpid/gethostname/fcntl/pre_exec)"
)]

use crate::db::Db;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::{fd::AsRawFd, unix::fs::OpenOptionsExt},
    path::Path,
};

pub fn node_id() -> Result<String> {
    if let Ok(value) = std::env::var("TRACKER_NODE_ID") {
        return Ok(value);
    }
    let mut name = [0u8; 256];
    ensure!(
        unsafe { libc::gethostname(name.as_mut_ptr().cast(), name.len()) } == 0,
        "hostname unavailable"
    );
    Ok(
        String::from_utf8_lossy(&name[..name.iter().position(|v| *v == 0).unwrap_or(name.len())])
            .into_owned(),
    )
}
pub fn initialize(root: &Path, origin: &str, settings: &Path) -> Result<()> {
    let mut db = Db::connect(&root.join("socket"), origin, Some(settings.to_owned()))?;
    db.client
        .batch_execute(include_str!("../../../db/schema.sql"))?;
    crate::udb::formula::ensure_role(&mut db)?;
    crate::local::claim_device(&mut db)?;
    let outbox =
        crate::demo::env_path("TRACKER_OUTBOX").unwrap_or_else(|| root.join("outbox.jsonl"));
    if crate::isolated_mode() {
        crate::scratch_path(&outbox)?;
    }
    drain_outbox(&mut db, &outbox)?;
    Ok(())
}
pub fn drain_outbox(db: &mut Db, path: &Path) -> Result<usize> {
    let parent = path.parent().context("outbox parent")?;
    fs::create_dir_all(parent)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(format!("{}.lock", path.display()))?;
    ensure!(
        unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } == 0,
        "outbox lock unavailable"
    );
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e.into()),
    };
    let mut stamped = false;
    let lines: Vec<String> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let Ok(Value::Object(mut object)) = serde_json::from_str::<Value>(line) else {
                return line.to_owned();
            };
            if object.contains_key("_trame_outbox_id") {
                return line.to_owned();
            }
            object.insert(
                "_trame_outbox_id".into(),
                json!(uuid::Uuid::new_v4().to_string()),
            );
            stamped = true;
            Value::Object(object).to_string()
        })
        .collect();
    if stamped {
        write_outbox(path, &lines)?;
    }
    let (pending, count) = db.exclusive(|db| {
        db.batch_execute("create schema if not exists trame_local; create table if not exists trame_local.outbox_receipts(id uuid primary key)")?;
        let mut pending = Vec::new();
        let mut count = 0;
        for line in &lines {
            let Ok(Value::Object(mut object)) = serde_json::from_str::<Value>(line) else {
                pending.push(line.clone());
                continue;
            };
            let Some(id) = object
                .remove("_trame_outbox_id")
                .and_then(|value| value.as_str().and_then(|id| uuid::Uuid::parse_str(id).ok()))
            else {
                pending.push(line.clone());
                continue;
            };
            db.batch_execute("begin")?;
            let result = (|| -> Result<bool> {
                let inserted = !db
                    .query(
                        "insert into trame_local.outbox_receipts(id) values($1::uuid) on conflict do nothing returning id",
                        &[json!(id.to_string())],
                    )?
                    .is_empty();
                if inserted {
                    crate::sessions::upsert(db, &Value::Object(object), None)?;
                }
                Ok(inserted)
            })();
            if let Ok(inserted) = result {
                db.batch_execute("commit")?;
                count += usize::from(inserted);
            } else {
                db.batch_execute("rollback")?;
                pending.push(line.clone());
            }
        }
        Ok((pending, count))
    })?;
    if pending.is_empty() {
        fs::remove_file(path)?;
        fs::File::open(parent)?.sync_all()?;
    } else {
        write_outbox(path, &pending)?;
    }
    Ok(count)
}

fn write_outbox(path: &Path, lines: &[String]) -> Result<()> {
    let parent = path.parent().context("outbox parent")?;
    let tmp = parent.join(format!(".outbox-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        writeln!(file, "{}", lines.join("\n"))?;
        file.sync_all()?;
        fs::rename(&tmp, path)?;
        fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}
