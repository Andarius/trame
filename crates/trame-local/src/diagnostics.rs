// Process, memory, traffic and database figures behind the Diagnostics view.
#![allow(unsafe_code, reason = "libc FFI (sysconf/getloadavg)")]

use crate::routes::{Native, json_response};
use axum::response::Response;
use serde_json::{Value, json};
use std::{
    sync::{
        LazyLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};

static STARTED: LazyLock<Instant> = LazyLock::new(Instant::now);

/// Marks the backend start, so uptime counts from boot rather than the first request.
pub fn start() {
    LazyLock::force(&STARTED);
}

/// Cumulative traffic since the backend started: local HTTP, hub sync and the hub websocket.
pub struct Traffic {
    http_requests: AtomicU64,
    http_bytes_in: AtomicU64,
    http_bytes_out: AtomicU64,
    hub_requests: AtomicU64,
    hub_bytes_in: AtomicU64,
    hub_bytes_out: AtomicU64,
    ws_messages: AtomicU64,
    ws_bytes_in: AtomicU64,
}

pub static TRAFFIC: Traffic = Traffic {
    http_requests: AtomicU64::new(0),
    http_bytes_in: AtomicU64::new(0),
    http_bytes_out: AtomicU64::new(0),
    hub_requests: AtomicU64::new(0),
    hub_bytes_in: AtomicU64::new(0),
    hub_bytes_out: AtomicU64::new(0),
    ws_messages: AtomicU64::new(0),
    ws_bytes_in: AtomicU64::new(0),
};

impl Traffic {
    pub fn http(&self, bytes_in: u64, bytes_out: u64) {
        self.http_requests.fetch_add(1, Ordering::Relaxed);
        self.http_bytes_in.fetch_add(bytes_in, Ordering::Relaxed);
        self.http_bytes_out.fetch_add(bytes_out, Ordering::Relaxed);
    }
    pub fn hub(&self, bytes_out: u64, bytes_in: u64) {
        self.hub_requests.fetch_add(1, Ordering::Relaxed);
        self.hub_bytes_out.fetch_add(bytes_out, Ordering::Relaxed);
        self.hub_bytes_in.fetch_add(bytes_in, Ordering::Relaxed);
    }
    pub fn ws(&self, bytes_in: u64) {
        self.ws_messages.fetch_add(1, Ordering::Relaxed);
        self.ws_bytes_in.fetch_add(bytes_in, Ordering::Relaxed);
    }
    fn json(&self) -> Value {
        let get = |a: &AtomicU64| a.load(Ordering::Relaxed);
        json!({
            "httpRequests": get(&self.http_requests),
            "httpBytesIn": get(&self.http_bytes_in),
            "httpBytesOut": get(&self.http_bytes_out),
            "hubRequests": get(&self.hub_requests),
            "hubBytesIn": get(&self.hub_bytes_in),
            "hubBytesOut": get(&self.hub_bytes_out),
            "wsMessages": get(&self.ws_messages),
            "wsBytesIn": get(&self.ws_bytes_in),
        })
    }
}

/// One process of the app's tree, as the OS reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct Process {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
    pub args: Vec<String>,
    pub cpu_seconds: f64,
    pub rss: u64,
    pub swap: Option<u64>,
    pub threads: Option<u64>,
    pub fds: Option<u64>,
    pub sockets: Option<u64>,
}

impl Process {
    fn json(&self, terminal: bool) -> Value {
        json!({
            "pid": self.pid,
            "ppid": self.ppid,
            "name": self.name,
            "role": role(self),
            "terminal": terminal,
            "args": self.args,
            "cpuSeconds": self.cpu_seconds,
            "rss": self.rss,
            "swap": self.swap,
            "threads": self.threads,
            "fds": self.fds,
            "sockets": self.sockets,
        })
    }
}

/// What a process in the tree is for, from its name and command line.
pub fn role(process: &Process) -> &'static str {
    let name = process.name.as_str();
    let args = &process.args;
    if process.pid == std::process::id() {
        "backend"
    } else if name.starts_with("WebKitWebProcess") {
        "renderer"
    } else if name.starts_with("WebKitNetworkProcess") {
        "webkit network"
    } else if name.starts_with("WebKitGPUProcess") {
        "webkit gpu"
    } else if name == "plugin-host" {
        "plugin host"
    } else if args.first().is_some_and(|a| a == "__postgres-supervisor") {
        "postgres supervisor"
    } else if name == "postgres" {
        if args.first().is_some_and(|a| a.starts_with("-D")) {
            "postgres server"
        } else {
            "postgres worker"
        }
    } else if matches!(name, "zsh" | "bash" | "fish" | "sh" | "nu") {
        "terminal shell"
    } else {
        "process"
    }
}

/// Pids of the terminal shells in `tree` and everything they run (agents, builds), not the app's own.
pub fn in_terminals(tree: &[Process]) -> std::collections::HashSet<u32> {
    let mut out = std::collections::HashSet::new();
    for p in tree {
        if role(p) == "terminal shell" || out.contains(&p.ppid) {
            out.insert(p.pid);
        }
    }
    out
}

/// The app's process and everything it spawned, parents before children.
pub fn tree(all: &[Process], root: u32) -> Vec<Process> {
    let mut out: Vec<Process> = all.iter().filter(|p| p.pid == root).cloned().collect();
    let mut index = 0;
    while index < out.len() {
        let parent = out[index].pid;
        let mut children: Vec<Process> = all
            .iter()
            .filter(|p| p.ppid == parent && p.pid != parent)
            .cloned()
            .collect();
        children.sort_by_key(|p| p.pid);
        out.extend(children);
        index += 1;
    }
    out
}

#[cfg(target_os = "linux")]
pub fn processes() -> Vec<Process> {
    use std::fs;
    #[allow(
        clippy::cast_precision_loss,
        reason = "clock ticks per second are small"
    )]
    let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) }.max(1) as f64;
    let Ok(entries) = fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let pid: u32 = entry.file_name().to_str()?.parse().ok()?;
            let stat = fs::read_to_string(entry.path().join("stat")).ok()?;
            let (head, tail) = stat.rsplit_once(')')?;
            // /proc truncates comm to 15 bytes (`WebKitWebProces`): prefer the command line's executable
            let cmdline = fs::read(entry.path().join("cmdline"))
                .map(|raw| String::from_utf8_lossy(&raw).into_owned())
                .unwrap_or_default();
            let name = command_name(&cmdline)
                .unwrap_or_else(|| head.split_once('(').map_or(head, |(_, n)| n).to_owned());
            let fields: Vec<&str> = tail.split_whitespace().collect();
            let field = |i: usize| fields.get(i).and_then(|f| f.parse::<u64>().ok());
            let ppid = u32::try_from(field(1)?).ok()?;
            #[allow(
                clippy::cast_precision_loss,
                reason = "cpu ticks fit f64 for any realistic uptime"
            )]
            let cpu_seconds = (field(11)? + field(12)?) as f64 / ticks;
            let status = fs::read_to_string(entry.path().join("status")).unwrap_or_default();
            let kb = |key: &str| {
                status
                    .lines()
                    .find_map(|l| l.strip_prefix(key))
                    .and_then(|v| v.trim().trim_end_matches("kB").trim().parse::<u64>().ok())
                    .map(|v| v * 1024)
            };
            let mut fds = 0;
            let mut sockets = 0;
            let fd_dir = fs::read_dir(entry.path().join("fd")).ok();
            for fd in fd_dir.into_iter().flatten().flatten() {
                fds += 1;
                if fs::read_link(fd.path())
                    .is_ok_and(|t| t.to_string_lossy().starts_with("socket:"))
                {
                    sockets += 1;
                }
            }
            let args = command_args(&cmdline);
            Some(Process {
                pid,
                ppid,
                name,
                args,
                cpu_seconds,
                rss: kb("VmRSS:").unwrap_or(0),
                swap: kb("VmSwap:"),
                threads: field(17),
                fds: Some(fds),
                sockets: Some(sockets),
            })
        })
        .collect()
}

/// The executable's base name from a NUL-separated command line (`postgres:` titles lose the colon).
#[cfg(any(target_os = "linux", test))]
fn command_name(cmdline: &str) -> Option<String> {
    let first = cmdline.split('\0').flat_map(str::split_whitespace).next()?;
    let base = first
        .rsplit('/')
        .next()
        .unwrap_or(first)
        .trim_end_matches(':');
    (!base.is_empty()).then(|| base.to_owned())
}

/// The first few arguments of a NUL-separated command line; a rewritten process title
/// (`postgres: checkpointer `) is one chunk, so it is split on spaces too.
#[cfg(any(target_os = "linux", test))]
fn command_args(cmdline: &str) -> Vec<String> {
    cmdline
        .split('\0')
        .flat_map(str::split_whitespace)
        .skip(1)
        .take(4)
        .map(str::to_owned)
        .collect()
}

#[cfg(target_os = "macos")]
pub fn processes() -> Vec<Process> {
    let Ok(output) = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid=,rss=,time=,command="])
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse().ok()?;
            let ppid = fields.next()?.parse().ok()?;
            let rss = fields.next()?.parse::<u64>().ok()? * 1024;
            let cpu_seconds = cpu_time(fields.next()?)?;
            let exe = fields.next()?;
            let name = exe.rsplit('/').next().unwrap_or(exe).to_owned();
            let args = fields.take(4).map(str::to_owned).collect();
            Some(Process {
                pid,
                ppid,
                name,
                args,
                cpu_seconds,
                rss,
                swap: None,
                threads: None,
                fds: None,
                sockets: None,
            })
        })
        .collect()
}

/// Seconds in a `ps` TIME column: `[[dd-]hh:]mm:ss[.cc]`.
#[cfg(any(target_os = "macos", test))]
fn cpu_time(value: &str) -> Option<f64> {
    let (days, clock) = value
        .split_once('-')
        .map_or((0.0, value), |(d, rest)| (d.parse().unwrap_or(0.0), rest));
    let mut seconds = 0.0;
    for part in clock.split(':') {
        seconds = seconds * 60.0 + part.parse::<f64>().ok()?;
    }
    Some(days * 86_400.0 + seconds)
}

fn system() -> Value {
    #[allow(clippy::cast_sign_loss, reason = "sysconf returns -1 only on error")]
    let total = unsafe {
        let pages = libc::sysconf(libc::_SC_PHYS_PAGES);
        let size = libc::sysconf(libc::_SC_PAGESIZE);
        if pages > 0 && size > 0 {
            Some(pages as u64 * size as u64)
        } else {
            None
        }
    };
    let mut load = [0f64; 3];
    let load = if unsafe { libc::getloadavg(load.as_mut_ptr(), 3) } == 3 {
        json!(load)
    } else {
        Value::Null
    };
    json!({
        "memTotal": total,
        "memAvailable": available_memory(),
        "load": load,
        "cpus": std::thread::available_parallelism().map(usize::from).ok(),
    })
}

#[cfg(target_os = "linux")]
fn available_memory() -> Option<u64> {
    std::fs::read_to_string("/proc/meminfo")
        .ok()?
        .lines()
        .find_map(|l| l.strip_prefix("MemAvailable:"))
        .and_then(|v| v.trim().trim_end_matches("kB").trim().parse::<u64>().ok())
        .map(|kb| kb * 1024)
}

#[cfg(not(target_os = "linux"))]
fn available_memory() -> Option<u64> {
    None
}

fn database(state: &Native) -> Option<Value> {
    let mut db = crate::db::Db::connect(
        &state.root.join("socket"),
        &state.origin,
        Some(state.settings.clone()),
    )
    .ok()?;
    let rows = db
        .query(
            "select pg_database_size(current_database())::int8 as size, (select count(*)::int from pg_stat_activity where datname=current_database()) as connections",
            &[],
        )
        .ok()?;
    let row = rows.first()?;
    Some(json!({"size": row["size"], "connections": row["connections"]}))
}

pub fn owns(method: &str, path: &str) -> bool {
    method == "GET" && path == "/api/diagnostics"
}

pub async fn serve(state: Native) -> Response {
    let last_sync = state.sync.last.lock().await.clone();
    let snapshot = crate::blocking::spawn(move || {
        let processes = tree(&processes(), std::process::id());
        let terminals = in_terminals(&processes);
        let db = database(&state);
        json!({
            "sampledAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "uptimeSeconds": STARTED.elapsed().as_secs_f64(),
            "version": crate::runtime::version(),
            "pid": std::process::id(),
            "processes": processes.iter().map(|p| p.json(terminals.contains(&p.pid))).collect::<Vec<_>>(),
            "system": system(),
            "traffic": TRAFFIC.json(),
            "lastSync": last_sync,
            "db": db,
        })
    })
    .await;
    match snapshot {
        Ok(value) => json_response(200, value),
        Err(_) => json_response(500, json!({"error":"diagnostics unavailable"})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process(pid: u32, ppid: u32, name: &str, args: &[&str]) -> Process {
        Process {
            pid,
            ppid,
            name: name.into(),
            args: args.iter().map(|a| (*a).to_owned()).collect(),
            cpu_seconds: 0.0,
            rss: 0,
            swap: None,
            threads: None,
            fds: None,
            sockets: None,
        }
    }

    #[test]
    fn tree_keeps_descendants_parents_first_and_drops_strangers() {
        let all = [
            process(1, 0, "init", &[]),
            process(10, 1, "trame", &[]),
            process(30, 10, "plugin-host", &[]),
            process(20, 10, "WebKitWebProcess", &[]),
            process(40, 30, "zsh", &[]),
            process(50, 1, "other", &[]),
        ];
        let pids: Vec<u32> = tree(&all, 10).iter().map(|p| p.pid).collect();
        assert_eq!(pids, vec![10, 20, 30, 40]);
        assert!(tree(&all, 999).is_empty());
    }

    #[test]
    fn terminal_shells_and_what_they_run_are_set_apart() {
        let all = [
            process(10, 1, "trame", &[]),
            process(20, 10, "zsh", &[]),
            process(30, 20, "claude", &[]),
            process(40, 30, "cargo", &[]),
            process(50, 10, "postgres", &["-D", "/data"]),
        ];
        let mut pids: Vec<_> = in_terminals(&all).into_iter().collect();
        pids.sort_unstable();
        assert_eq!(pids, vec![20, 30, 40]);
    }

    #[test]
    fn roles_follow_name_and_command_line() {
        for (name, args, wanted) in [
            ("WebKitWebProcess", vec!["4", "35"], "renderer"),
            ("WebKitNetworkProcess", vec![], "webkit network"),
            ("plugin-host", vec![], "plugin host"),
            (
                "trame",
                vec!["__postgres-supervisor", "/root"],
                "postgres supervisor",
            ),
            ("postgres", vec!["-D", "/data"], "postgres server"),
            ("postgres", vec![], "postgres worker"),
            ("zsh", vec![], "terminal shell"),
            ("node", vec![], "process"),
        ] {
            assert_eq!(role(&process(2, 1, name, &args)), wanted, "{name}");
        }
    }

    #[test]
    fn command_name_is_the_executable_base_name() {
        for (cmdline, wanted) in [
            (
                "././/lib/webkit2gtk-4.1/WebKitWebProcess\x004\x0035\x00",
                Some("WebKitWebProcess"),
            ),
            ("postgres: checkpointer \x00", Some("postgres")),
            ("trame\x00", Some("trame")),
            ("", None),
        ] {
            assert_eq!(command_name(cmdline).as_deref(), wanted, "{cmdline:?}");
        }
    }

    #[test]
    fn command_line_args_handle_rewritten_titles() {
        assert_eq!(
            command_args("postgres: checkpointer \x00"),
            vec!["checkpointer"]
        );
        assert_eq!(
            command_args("/usr/bin/postgres\x00-D\x00/data\x00-c\x00a=b\x00-p\x00"),
            vec!["-D", "/data", "-c", "a=b"]
        );
        assert!(command_args("").is_empty());
    }

    #[test]
    fn ps_time_column_parses_all_shapes() {
        for (value, wanted) in [
            ("0:01.23", Some(1.23)),
            ("1:02:03", Some(3723.0)),
            ("2-00:00:01", Some(172_801.0)),
            ("nope", None),
        ] {
            assert_eq!(cpu_time(value), wanted, "{value}");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn own_process_is_reported() {
        let me = std::process::id();
        let all = processes();
        let own = all.iter().find(|p| p.pid == me).expect("self in /proc");
        assert!(own.rss > 0);
        assert!(own.threads.is_some_and(|t| t >= 1));
        assert!(own.fds.is_some_and(|f| f >= 3));
        assert_eq!(role(own), "backend");
        assert_eq!(tree(&all, me)[0].pid, me);
    }
}
