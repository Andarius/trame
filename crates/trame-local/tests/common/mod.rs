#![allow(dead_code)]
use serde_json::Value;
use std::{
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
use trame_local::db::Db;

pub(crate) struct TestDb {
    pub db: Db,
    pub root: PathBuf,
    child: Child,
}
impl TestDb {
    pub(crate) fn new() -> Self {
        Self::with_env(&[])
    }
    /// Start the server with extra environment, e.g. a predictable `SHELL`.
    pub(crate) fn with_env(env: &[(&str, &str)]) -> Self {
        let root = trame_local::workspace().join(format!(
            ".scratch/t2-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        ));
        std::fs::create_dir(&root).unwrap();
        let log = std::fs::File::create(root.join("runtime.log")).unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_trame-local"))
            .env("TRAME_LOCAL_DIR", &root)
            .env("TRAME_OFFLINE", "1")
            .env("PATH", "/usr/bin:/bin")
            .env("TRACKER_PORT", "0")
            .env("TRACKER_NODE_ID", "rust-slice2-test")
            .env("TRACKER_SETTINGS_FILE", root.join("settings.json"))
            .envs(env.iter().copied())
            .stdout(Stdio::from(log.try_clone().unwrap()))
            .stderr(Stdio::from(log))
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(90);
        while !root.join("port.json").exists() {
            assert!(
                child.try_wait().unwrap().is_none(),
                "test server exited; {}",
                root.display()
            );
            assert!(Instant::now() < deadline, "test server timed out");
            std::thread::sleep(Duration::from_millis(50));
        }
        let db = Db::connect(
            &root.join("socket"),
            "rust-slice2-test",
            Some(root.join("settings.json")),
        )
        .unwrap();
        Self { db, root, child }
    }
    pub(crate) fn base_url(&self) -> String {
        let p: Value =
            serde_json::from_slice(&std::fs::read(self.root.join("port.json")).unwrap()).unwrap();
        format!("http://127.0.0.1:{}", p["port"])
    }
    #[allow(
        clippy::needless_pass_by_value,
        reason = "callers pass json! temporaries"
    )]
    pub(crate) fn request(&mut self, method: &str, path: &str, body: Value) -> (u16, Value) {
        let (path, query) = path.split_once('?').unwrap_or((path, ""));
        trame_local::routes::handle(&mut self.db, method, path, query, &body).unwrap()
    }
}
impl Drop for TestDb {
    #[allow(
        unsafe_code,
        clippy::cast_possible_wrap,
        reason = "libc::kill on a child pid that fits i32"
    )]
    fn drop(&mut self) {
        unsafe {
            libc::kill(self.child.id() as i32, libc::SIGTERM);
        }
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
