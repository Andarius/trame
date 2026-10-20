#![allow(
    unsafe_code,
    reason = "libc FFI (flock/kill/killpg/prctl/getppid/waitpid/gethostname/fcntl/pre_exec)"
)]

use anyhow::{Context, Result, bail, ensure};
use postgres::{Client, NoTls};
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

pub const PORT: u16 = 55439;
static STOP: AtomicBool = AtomicBool::new(false);

extern "C" fn stop_signal(_: libc::c_int) {
    STOP.store(true, Ordering::Relaxed);
}

fn owned_directory(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => ensure!(
            metadata.is_dir() && metadata.uid() == unsafe { libc::geteuid() },
            "directory is not owned: {}",
            path.display()
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => fs::create_dir_all(path)?,
        Err(error) => return Err(error.into()),
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

pub fn lock_root(root: &Path) -> Result<File> {
    lock_root_within(root, Duration::ZERO)
}

/// Like [`lock_root`], but waits up to `wait` for a quitting instance to release the root.
pub fn lock_root_within(root: &Path, wait: Duration) -> Result<File> {
    owned_directory(root)?;
    let path = root.join(".owner.lock");
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)?;
    let metadata = lock.metadata()?;
    ensure!(
        metadata.is_file() && metadata.uid() == unsafe { libc::geteuid() } && metadata.nlink() == 1,
        "unsafe ownership lock"
    );
    let deadline = Instant::now() + wait;
    while unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        ensure!(
            Instant::now() < deadline,
            "root is already running or migrating: {}",
            root.display()
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    let named = fs::symlink_metadata(&path)?;
    ensure!(
        named.dev() == metadata.dev() && named.ino() == metadata.ino(),
        "ownership lock was replaced"
    );
    Ok(lock)
}

pub fn connect(root: &Path) -> Result<Client> {
    let mut config = postgres::Config::new();
    config
        .host_path(root.join("socket"))
        .port(PORT)
        .user("trame")
        .dbname("postgres")
        .connect_timeout(Duration::from_secs(1));
    let mut client = config.connect(NoTls)?;
    let data: String = client.query_one("SHOW data_directory", &[])?.get(0);
    ensure!(
        Path::new(&data).canonicalize()? == root.join("postgres").canonicalize()?,
        "connected to an unowned PostgreSQL cluster"
    );
    Ok(client)
}

pub struct Pg {
    supervisor: Child,
}

impl Pg {
    pub fn start(root: &Path, bin: &Path) -> Result<Self> {
        let lock = lock_root(root)?;
        let root = root.canonicalize()?;
        let bin = bin.canonicalize()?;
        ensure!(
            root.join(format!("socket/.s.PGSQL.{PORT}"))
                .as_os_str()
                .as_encoded_bytes()
                .len()
                <= SOCKET_PATH_MAX,
            "PostgreSQL Unix socket path exceeds the {SOCKET_PATH_MAX}-byte limit"
        );
        owned_directory(&root.join("socket"))?;
        let log = OpenOptions::new()
            .append(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(root.join("postgres.log"))?;
        let fd = lock.as_raw_fd();
        let mut command = Command::new(std::env::current_exe()?);
        command
            .arg("__postgres-supervisor")
            .arg(&root)
            .arg(&bin)
            .arg(fd.to_string())
            .arg(std::process::id().to_string())
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log);
        unsafe {
            command.pre_exec(move || {
                if libc::fcntl(fd, libc::F_SETFD, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut pg = Self {
            supervisor: command.spawn()?,
        };
        drop(lock);
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            ensure!(
                pg.is_running()?,
                "PostgreSQL supervisor failed; see {}/postgres.log",
                root.display()
            );
            if connect(&root).is_ok() && owns_postmaster(&root, pg.supervisor.id()).unwrap_or(false)
            {
                return Ok(pg);
            }
            ensure!(
                Instant::now() < deadline,
                "PostgreSQL startup timed out; see {}/postgres.log",
                root.display()
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    pub fn is_running(&mut self) -> Result<bool> {
        Ok(self.supervisor.try_wait()?.is_none())
    }
}

impl Drop for Pg {
    #[allow(
        clippy::cast_possible_wrap,
        reason = "values fit by construction (pids, small ids)"
    )]
    fn drop(&mut self) {
        if matches!(self.supervisor.try_wait(), Ok(None)) {
            unsafe {
                libc::kill(self.supervisor.id() as libc::pid_t, libc::SIGTERM);
            }
        }
        let _ = self.supervisor.wait();
    }
}

pub fn supervisor_args() -> Option<Result<()>> {
    let arguments: Vec<_> = std::env::args_os().collect();
    if arguments
        .get(1)
        .is_none_or(|arg| arg != "__postgres-supervisor")
    {
        return None;
    }
    Some((|| {
        ensure!(arguments.len() == 6, "invalid supervisor arguments");
        let fd: i32 = arguments[4].to_str().context("invalid lock fd")?.parse()?;
        let parent: u32 = arguments[5].to_str().context("invalid app pid")?.parse()?;
        supervise(
            Path::new(&arguments[2]),
            Path::new(&arguments[3]),
            fd,
            parent,
        )
    })())
}

// sun_path holds 108 bytes on Linux and 104 on macOS, NUL included
#[cfg(target_os = "macos")]
const SOCKET_PATH_MAX: usize = 103;
#[cfg(not(target_os = "macos"))]
const SOCKET_PATH_MAX: usize = 107;

fn owns_postmaster(root: &Path, supervisor: u32) -> Result<bool> {
    let pid: u32 = fs::read_to_string(root.join("postgres/postmaster.pid"))?
        .lines()
        .next()
        .context("missing postmaster pid")?
        .parse()?;
    Ok(parent_pid(pid)? == supervisor)
}

#[cfg(target_os = "linux")]
fn parent_pid(pid: u32) -> Result<u32> {
    let status = fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let fields = status.rsplit_once(')').context("invalid process status")?.1;
    Ok(fields
        .split_whitespace()
        .nth(1)
        .context("missing parent pid")?
        .parse()?)
}

#[cfg(target_os = "macos")]
#[allow(
    clippy::cast_possible_wrap,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "pid and struct size fit in i32"
)]
fn parent_pid(pid: u32) -> Result<u32> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    let read = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            std::ptr::addr_of_mut!(info).cast(),
            size,
        )
    };
    ensure!(read == size, "cannot read process {pid}");
    Ok(info.pbi_ppid)
}

fn reap_descendants() -> Result<()> {
    loop {
        let result = unsafe { libc::waitpid(-1, std::ptr::null_mut(), 0) };
        if result >= 0 {
            continue;
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::EINTR) {
            continue;
        }
        ensure!(
            error.raw_os_error() == Some(libc::ECHILD),
            "reaping PostgreSQL descendants: {error}"
        );
        return Ok(());
    }
}

#[allow(
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    reason = "values fit by construction (pids, small ids); values are non-negative by construction"
)]
fn supervise(root: &Path, bin: &Path, fd: i32, parent: u32) -> Result<()> {
    ensure!(fd >= 3, "invalid inherited lock fd");
    let lock = unsafe { File::from_raw_fd(fd) };
    let metadata = lock.metadata()?;
    let named = fs::symlink_metadata(root.join(".owner.lock"))?;
    ensure!(
        metadata.uid() == unsafe { libc::geteuid() }
            && metadata.ino() == named.ino()
            && metadata.dev() == named.dev(),
        "invalid inherited root lock"
    );
    ensure!(
        unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) } == 0,
        "root lock unavailable"
    );
    unsafe {
        libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
        // macOS has no subreaper: orphaned grandchildren go to launchd, so only direct children are reaped
        #[cfg(target_os = "linux")]
        ensure!(
            libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) == 0,
            "cannot enable process reaping"
        );
        libc::signal(
            libc::SIGTERM,
            stop_signal as *const () as libc::sighandler_t,
        );
        libc::signal(libc::SIGINT, stop_signal as *const () as libc::sighandler_t);
    }
    if unsafe { libc::getppid() } as u32 != parent || STOP.load(Ordering::Relaxed) {
        return Ok(());
    }
    let data = root.join("postgres");
    let initialize = match fs::symlink_metadata(&data) {
        Ok(_) => {
            owned_directory(&data)?;
            false
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(error) => return Err(error.into()),
    };
    if initialize {
        let mut initialize = Command::new(bin.join("initdb"));
        initialize.arg("-D").arg(&data).args([
            "--username=trame",
            "--auth-local=trust",
            "--auth-host=reject",
            "--encoding=UTF8",
            "--locale=C",
        ]);
        let supervisor = std::process::id();
        unsafe {
            initialize.pre_exec(move || {
                if libc::setpgid(0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                #[cfg(target_os = "linux")]
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::getppid() as u32 != supervisor {
                    libc::_exit(1);
                }
                Ok(())
            });
        }
        let mut initializing = initialize.spawn()?;
        let status = loop {
            if STOP.load(Ordering::Relaxed) || unsafe { libc::getppid() } as u32 != parent {
                unsafe {
                    libc::kill(-(initializing.id() as libc::pid_t), libc::SIGKILL);
                }
                let _ = initializing.wait();
                reap_descendants()?;
                if data.exists() {
                    fs::remove_dir_all(&data)?;
                }
                return Ok(());
            }
            if let Some(status) = initializing.try_wait()? {
                break status;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        if !status.success() {
            reap_descendants()?;
            if data.exists() {
                fs::remove_dir_all(&data)?;
            }
            bail!("initdb failed");
        }
    }
    owned_directory(&data)?;
    ensure!(
        fs::read_to_string(data.join("PG_VERSION"))?.trim() == "18",
        "only PostgreSQL18 clusters are supported"
    );
    if unsafe { libc::getppid() } as u32 != parent || STOP.load(Ordering::Relaxed) {
        return Ok(());
    }
    let supervisor = std::process::id();
    let mut command = Command::new(bin.join("postgres"));
    command
        .arg("-D")
        .arg(&data)
        .args([
            "-c",
            "listen_addresses=",
            "-c",
            "unix_socket_permissions=0700",
            "-k",
        ])
        .arg(root.join("socket"))
        .args(["-p", &PORT.to_string()])
        .arg("-c")
        .arg(format!(
            "dynamic_library_path={}",
            bin.join("../lib").display()
        ));
    unsafe {
        command.pre_exec(move || {
            // macOS has no PDEATHSIG: the supervisor's getppid() poll below stops the postmaster instead
            #[cfg(target_os = "linux")]
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGINT, 0, 0, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::getppid() as u32 != supervisor {
                libc::_exit(1);
            }
            Ok(())
        });
    }
    let mut postmaster = command.spawn()?;
    let mut stopping = false;
    let status = loop {
        if !stopping
            && (STOP.load(Ordering::Relaxed) || unsafe { libc::getppid() } as u32 != parent)
        {
            unsafe {
                libc::kill(postmaster.id() as libc::pid_t, libc::SIGINT);
            }
            stopping = true;
        }
        if let Some(status) = postmaster.try_wait()? {
            break status;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    // Keep the inherited flock until every adopted PostgreSQL child has exited.
    reap_descendants()?;
    ensure!(status.success(), "PostgreSQL exited with {status}");
    Ok(())
}

fn migration_script(mode: &str, source: &Path, staging: Option<&Path>) -> Result<String> {
    let helper = std::env::var_os("TRAME_MIGRATION_HELPER")
        .map(std::path::PathBuf::from)
        .unwrap_or(std::env::current_exe()?.with_file_name("trame-migrate-pglite"));
    let mut command = if helper.is_file() {
        Command::new(helper)
    } else {
        ensure!(
            cfg!(debug_assertions),
            "legacy PGlite data at {} needs migrating: run Trame v0.19.x once, then upgrade",
            source.display()
        );
        let mut command = Command::new("bun");
        command.arg(crate::workspace().join("scripts/rust-db-migrate.ts"));
        command
    };
    command
        .arg(mode)
        .arg(source)
        .env("TRAME_MIGRATION_SOURCE", source)
        .env("TRAME_MIGRATION_PARENT_PID", std::process::id().to_string());
    if let Some(staging) = staging {
        command.arg(staging).env("TRAME_MIGRATION_STAGING", staging);
    }
    let output = command.stderr(Stdio::inherit()).output()?;
    ensure!(output.status.success(), "migration {mode} failed");
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}

pub fn migrate(source: &Path, root: &Path, bin: &Path) -> Result<()> {
    let source = source.canonicalize()?;
    let target = if root.exists() {
        root.canonicalize()?
    } else {
        root.parent()
            .context("root has no parent")?
            .canonicalize()?
            .join(root.file_name().context("root has no name")?)
    };
    ensure!(
        !target.join("postgres").starts_with(&source)
            && !source.starts_with(target.join("postgres")),
        "migration source and target must be separate"
    );
    let _lock = lock_root(root)?;
    check_staging(root)?;
    let data = root.join("postgres");
    let fingerprint = migration_script("fingerprint", &source, None)?;
    if data.exists() {
        verify_migration_marker(&data, &source, &fingerprint)?;
        return Ok(());
    }
    let staging = root.join(format!(
        ".migrate-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    ));
    fs::DirBuilder::new().mode(0o700).create(&staging)?;
    let result = (|| -> Result<()> {
        migration_script("prepare", &source, Some(&staging))?;
        let pg = Pg::start(&staging, bin)?;
        let mut client = connect(&staging)?;
        client.batch_execute(
            "SET timezone='UTC'; SET datestyle='ISO, YMD'; SET extra_float_digits=3;",
        )?;
        client
            .batch_execute(include_str!("../../../db/schema.sql"))
            .context("current schema could not initialize; legacy source remains unchanged")?;
        check_export_schema(&mut client, &staging.join("export/db-export.json"))?;
        let status = Command::new(bin.join("psql"))
            .arg("-h")
            .arg(staging.join("socket"))
            .args([
                "-p",
                &PORT.to_string(),
                "-U",
                "trame",
                "-d",
                "postgres",
                "-v",
                "ON_ERROR_STOP=1",
                "-f",
            ])
            .arg(staging.join("export/db-data.sql"))
            .stdout(Stdio::null())
            .status()?;
        ensure!(
            status.success(),
            "PostgreSQL import failed; legacy source remains unchanged"
        );
        validate_export(&mut client, &staging.join("export/db-export.json"))?;
        client.batch_execute(include_str!("../../../db/schema.sql"))?;
        drop(client);
        drop(pg);
        ensure!(
            migration_script("fingerprint", &source, None)? == fingerprint,
            "source changed during migration"
        );
        fs::rename(
            staging.join("backup"),
            staging.join("postgres/pglite-backup"),
        )?;
        fs::copy(
            staging.join("source.json"),
            staging.join("postgres/.trame-migration.json"),
        )?;
        fs::rename(staging.join("postgres"), &data)?;
        Ok(())
    })();
    fs::remove_dir_all(&staging)?;
    result
}

fn verify_migration_marker(data: &Path, source: &Path, fingerprint: &str) -> Result<()> {
    let marker: Value = serde_json::from_slice(
        &fs::read(data.join(".trame-migration.json"))
            .context("refusing migration over an existing PostgreSQL cluster")?,
    )?;
    ensure!(
        marker["source"] == source.to_string_lossy().as_ref() && marker["sha256"] == fingerprint,
        "existing cluster was migrated from another source or source changed"
    );
    Ok(())
}

pub fn check_staging(root: &Path) -> Result<()> {
    if !root.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_name().to_string_lossy().starts_with(".migrate-") {
            bail!(
                "interrupted migration staging remains at {}; inspect and preserve it before retrying",
                entry.path().display()
            );
        }
    }
    Ok(())
}

fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn schema_columns(client: &mut Client, table: &str) -> Result<Vec<Value>> {
    let metadata: String = client.query_one(
        "SELECT coalesce(json_agg(c ORDER BY c.name),'[]')::text FROM (SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type, NOT a.attnotnull AS nullable, pg_get_expr(d.adbin,d.adrelid) AS default, a.attidentity AS identity, a.attgenerated AS generated FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE c.relnamespace='public'::regnamespace AND c.relname=$1 AND a.attnum>0 AND NOT a.attisdropped) c", &[&table])?.get(0);
    Ok(serde_json::from_str(&metadata)?)
}

fn check_columns(name: &str, source: &[Value], target: &[Value]) -> Result<()> {
    let source_names: BTreeSet<&str> = source
        .iter()
        .map(|c| c["name"].as_str().context("invalid source column name"))
        .collect::<Result<_>>()?;
    let target_names: BTreeSet<&str> = target
        .iter()
        .map(|c| c["name"].as_str().context("invalid target column name"))
        .collect::<Result<_>>()?;
    ensure!(
        source_names == target_names,
        "migration schema incompatible: columns differ in {name}; legacy source remains unchanged"
    );
    for source_col in source {
        let col_name = source_col["name"]
            .as_str()
            .context("invalid source column name")?;
        let target_col = target
            .iter()
            .find(|c| c["name"] == col_name)
            .context("missing target column")?;
        for key in ["type", "default", "identity", "generated"] {
            ensure!(
                source_col[key] == target_col[key],
                "migration schema incompatible: {name}.{col_name} {key} differs; legacy source remains unchanged"
            );
        }
        ensure!(
            source_col["nullable"].is_boolean() && target_col["nullable"].is_boolean(),
            "invalid column nullability in {name}.{col_name}"
        );
        ensure!(
            source_col["nullable"] != true || target_col["nullable"] != false,
            "migration schema incompatible: {name}.{col_name} allows NULL in source but target requires NOT NULL; legacy source remains unchanged"
        );
    }
    Ok(())
}

fn check_export_schema(client: &mut Client, path: &Path) -> Result<()> {
    let export: Value = serde_json::from_slice(&fs::read(path)?)?;
    let tables = export["tables"]
        .as_array()
        .context("invalid table export")?;
    let source: BTreeSet<String> = tables
        .iter()
        .map(|t| {
            t["name"]
                .as_str()
                .map(str::to_owned)
                .context("invalid source table name")
        })
        .collect::<Result<_>>()?;
    let target: BTreeSet<String> = client
        .query(
            "select tablename from pg_tables where schemaname='public'",
            &[],
        )?
        .iter()
        .map(|r| r.get::<_, String>(0))
        .collect();
    ensure!(
        source == target,
        "migration schema incompatible: source and target table sets differ; legacy source remains unchanged"
    );
    for table in tables {
        let name = table["name"]
            .as_str()
            .context("invalid source table name")?;
        let source_columns = table["columns"]
            .as_array()
            .context("invalid source columns")?;
        let target_columns = schema_columns(client, name)?;
        check_columns(name, source_columns, &target_columns)?;
    }
    Ok(())
}

fn validate_export(client: &mut Client, path: &Path) -> Result<()> {
    let export: Value = serde_json::from_slice(&fs::read(path)?)?;
    for table in export["tables"]
        .as_array()
        .context("invalid table export")?
    {
        let name = table["name"].as_str().context("invalid table name")?;
        let columns = table["columns"]
            .as_array()
            .context("invalid column export")?;
        let expressions = columns
            .iter()
            .map(|column| {
                column["name"]
                    .as_str()
                    .map(|name| format!("{}::text", quote(name)))
                    .context("invalid column name")
            })
            .collect::<Result<Vec<_>>>()?;
        let sql = format!(
            "SELECT json_build_array({})::text FROM {}",
            expressions.join(","),
            quote(name)
        );
        let mut actual = client
            .query(&sql, &[])?
            .into_iter()
            .map(|row| {
                serde_json::from_str::<Value>(row.get::<_, &str>(0)).map(|value| value.to_string())
            })
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut expected: Vec<_> = table["rows"]
            .as_array()
            .context("invalid row export")?
            .iter()
            .map(Value::to_string)
            .collect();
        actual.sort();
        expected.sort();
        ensure!(actual == expected, "migration data mismatch: {name}");
        let mut actual: Vec<String> = schema_columns(client, name)?
            .iter()
            .map(Value::to_string)
            .collect();
        let mut expected: Vec<String> = columns.iter().map(Value::to_string).collect();
        actual.sort();
        expected.sort();
        ensure!(
            actual == expected,
            "migration column metadata mismatch: {name}"
        );
    }
    for sequence in export["sequences"]
        .as_array()
        .context("invalid sequence export")?
    {
        let name = sequence["name"].as_str().context("invalid sequence name")?;
        let row = client.query_one(
            &format!("SELECT last_value::text,is_called FROM {}", quote(name)),
            &[],
        )?;
        ensure!(
            sequence["value"] == row.get::<_, String>(0)
                && sequence["called"] == row.get::<_, bool>(1),
            "migration sequence mismatch: {name}"
        );
    }
    for constraint in client.query("SELECT c.relname, con.conname, pg_get_constraintdef(con.oid) FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid WHERE con.contype='f' AND c.relnamespace='public'::regnamespace", &[])? {
        let table: &str = constraint.get(0); let name: &str = constraint.get(1); let definition: &str = constraint.get(2);
        let mut transaction = client.transaction()?;
        transaction.batch_execute(&format!("ALTER TABLE {} DROP CONSTRAINT {}; ALTER TABLE {} ADD CONSTRAINT {} {} NOT VALID; ALTER TABLE {} VALIDATE CONSTRAINT {};", quote(table), quote(name), quote(table), quote(name), definition, quote(table), quote(name)))?;
        transaction.rollback()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_lock_refuses_concurrent_owners_and_symlink_locks() -> Result<()> {
        let scratch = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .canonicalize()?;
        let root = scratch.join(format!("pg-lock-test-{}", uuid::Uuid::new_v4()));
        let result = (|| {
            let lock = lock_root(&root)?;
            assert!(lock_root(&root).is_err());
            let release = std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(300));
                drop(lock);
            });
            drop(lock_root_within(&root, Duration::from_secs(5))?);
            release.join().unwrap();
            // a parallel test's fork can hold the just-closed fd until its exec
            drop(lock_root_within(&root, Duration::from_secs(5))?);
            fs::remove_file(root.join(".owner.lock"))?;
            fs::write(root.join("other"), "preserve")?;
            std::os::unix::fs::symlink(root.join("other"), root.join(".owner.lock"))?;
            assert!(lock_root(&root).is_err());
            assert_eq!(fs::read_to_string(root.join("other"))?, "preserve");
            Ok(())
        })();
        fs::remove_dir_all(root)?;
        result
    }

    #[test]
    fn interrupted_stage_is_preserved_and_blocks_restart() -> Result<()> {
        let root = crate::scratch_root(
            &crate::workspace().join(format!(".scratch/stage-guard-{}", uuid::Uuid::new_v4())),
        )?;
        let stage = root.join(".migrate-12345678");
        fs::DirBuilder::new().mode(0o700).create(&stage)?;
        fs::write(stage.join("backup-marker"), "keep")?;
        ensure!(check_staging(&root).is_err(), "stale stage was ignored");
        ensure!(
            fs::read_to_string(stage.join("backup-marker"))? == "keep",
            "stale stage was changed"
        );
        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn schema_preflight_refuses_loss_and_constraint_weakening() -> Result<()> {
        let column = |nullable| serde_json::json!({"name":"value","type":"text","nullable":nullable,"default":null,"identity":"","generated":""});
        check_columns("fixture", &[column(false)], &[column(true)])?;
        ensure!(
            check_columns("fixture", &[column(true)], &[column(false)]).is_err(),
            "nullable source accepted by a stricter target"
        );
        ensure!(
            check_columns(
                "fixture",
                &[column(false), serde_json::json!({"name":"extra"})],
                &[column(false)]
            )
            .is_err(),
            "unknown column accepted"
        );
        Ok(())
    }

    #[test]
    fn migration_marker_refuses_legacy_divergence() -> Result<()> {
        let root = crate::scratch_root(
            &crate::workspace().join(format!(".scratch/marker-guard-{}", uuid::Uuid::new_v4())),
        )?;
        let result = (|| -> Result<()> {
            let data = root.join("postgres");
            fs::create_dir(&data)?;
            let source = root.join("pglite");
            fs::create_dir(&source)?;
            fs::write(
                data.join(".trame-migration.json"),
                serde_json::json!({"source":source,"sha256":"original"}).to_string(),
            )?;
            verify_migration_marker(&data, &source, "original")?;
            ensure!(
                verify_migration_marker(&data, &source, "changed").is_err(),
                "changed legacy source was accepted"
            );
            ensure!(
                verify_migration_marker(&data, &root.join("other"), "original").is_err(),
                "another legacy source was accepted"
            );
            Ok(())
        })();
        fs::remove_dir_all(root)?;
        result
    }
}
