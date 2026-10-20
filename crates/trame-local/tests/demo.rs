use serde_json::{Value, json};
use std::{
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn get(base: &str, path: &str) -> Value {
    let out = Command::new("curl")
        .args(["-sf", "-m", "5", &format!("{base}{path}")])
        .output()
        .unwrap();
    serde_json::from_slice(&out.stdout).unwrap_or(Value::Null)
}

#[test]
#[allow(
    unsafe_code,
    clippy::cast_possible_wrap,
    reason = "libc::kill on a child pid that fits i32"
)]
fn demo_root_replays_its_bundle_with_new_ids_and_shifted_dates() {
    let root = trame_local::workspace().join(format!(
        ".scratch/t2-demo-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    ));
    std::fs::create_dir(&root).unwrap();
    let (db, prop) = (
        "a0000000-0000-4000-8000-000000000001",
        "a0000000-0000-4000-8000-000000000002",
    );
    let bundle = json!({
        "format": trame_local::demo::FORMAT,
        "recorded_on": "2026-01-01",
        "ops": [
            {"method": "POST", "path": "/api/udb", "body": {"name": "Runs"}, "ids": {"/id": db}},
            {"method": "POST", "path": format!("/api/udb/{db}/props"), "body": {"name": "Date", "type": "date", "config": {}}, "ids": {"/id": prop}},
            {"method": "POST", "path": format!("/api/udb/{db}/rows"), "body": {"vals": {prop: {"start": "2026-01-10"}}}, "ids": {}},
        ],
    });
    let demo = root.join("demo");
    std::fs::create_dir(&demo).unwrap();
    std::fs::write(demo.join("bundle.json"), bundle.to_string()).unwrap();
    // the user's transcripts (via TRACKER_CLAUDE_DIR) vs the demo's own
    let (real, own) = (
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
    );
    for (dir, id) in [
        (root.join("claude"), real),
        (demo.join("claude-projects"), own),
    ] {
        let project = dir.join("-repo-alpha");
        std::fs::create_dir_all(&project).unwrap();
        let line = json!({"cwd": "/repo/alpha", "timestamp": chrono::Utc::now().to_rfc3339()});
        let prompt = json!({"type": "user", "message": {"role": "user", "content": "hello"}});
        std::fs::write(
            project.join(format!("{id}.jsonl")),
            format!("{line}\n{prompt}\n"),
        )
        .unwrap();
    }
    let log = std::fs::File::create(root.join("runtime.log")).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_trame-local"))
        .env("TRAME_LOCAL_DIR", &root)
        .env("TRAME_DEMO", "1")
        .env("PATH", "/usr/bin:/bin")
        .env("TRACKER_PORT", "0")
        .env("TRACKER_NODE_ID", "rust-demo-test")
        .env("TRACKER_CLAUDE_DIR", root.join("claude"))
        .stdout(Stdio::from(log.try_clone().unwrap()))
        .stderr(Stdio::from(log))
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(90);
    let base = loop {
        assert!(
            child.try_wait().unwrap().is_none(),
            "server exited; {}",
            root.display()
        );
        assert!(Instant::now() < deadline, "demo seed timed out");
        if let Ok(bytes) = std::fs::read(demo.join("port.json")) {
            let port: Value = serde_json::from_slice(&bytes).unwrap();
            let base = format!("http://127.0.0.1:{}", port["port"]);
            match get(&base, "/api/demo")["phase"].as_str() {
                Some("ready") => break base,
                Some("failed") => panic!("seed failed: {}", get(&base, "/api/demo")["error"]),
                _ => {}
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    };

    assert_eq!(get(&base, "/api/status")["demo"], true);
    let list = get(&base, "/api/udb");
    let live = list
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["name"] == "Runs")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(live, db);
    let table = get(&base, &format!("/api/udb/{live}"));
    let date = table["properties"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == "Date")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let expected = (chrono::Local::now().date_naive() + chrono::Days::new(9))
        .format("%Y-%m-%d")
        .to_string();
    assert_eq!(table["rows"][0]["vals"][&date]["start"], expected);
    assert!(demo.join("seeded").exists());
    let scan = get(&base, "/api/import/claude?days=30").to_string();
    assert!(scan.contains(own), "demo lists its own transcripts: {scan}");
    assert!(
        !scan.contains(real),
        "demo must not list the user's transcripts"
    );
    assert!(
        !root.join("postgres").exists(),
        "the real root stays untouched"
    );

    unsafe {
        libc::kill(child.id() as i32, libc::SIGTERM);
    }
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&root);
}
