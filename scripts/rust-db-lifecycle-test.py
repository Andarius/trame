# DESCRIPTION: Verify Linux PostgreSQL supervisor shutdown, crash recovery, and import refusal.
# USAGE: python3 scripts/rust-db-lifecycle-test.py
import fcntl
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time


WORKSPACE = Path(__file__).resolve().parent.parent
BINARY = WORKSPACE / "target/debug/trame-local"
BIN = Path(os.environ.get("TRAME_PG_BIN", str(WORKSPACE / ".scratch/package/pg/usr/lib/postgresql/18/bin")))


def wait_until(check, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.05)
    raise RuntimeError("lifecycle condition timed out")


def lock_available(root):
    with (root / ".owner.lock").open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            return False


def parent(root):
    root.mkdir(mode=0o700, exist_ok=True)
    (root / "socket").mkdir(mode=0o700, exist_ok=True)
    lock = (root / ".owner.lock").open("a+")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    with (root / "test.log").open("a") as log:
        child = subprocess.Popen(
            [BINARY, "__postgres-supervisor", root, BIN, str(lock.fileno()), str(os.getpid())],
            pass_fds=(lock.fileno(),), stdout=log, stderr=log,
        )
        signal.signal(signal.SIGTERM, lambda *_: child.send_signal(signal.SIGTERM))
        child.wait()


def launch(root):
    return subprocess.Popen([sys.executable, __file__, "--parent", root])


def query(root, sql):
    return subprocess.run(
        [BIN / "psql", "-h", root / "socket", "-p", "55439", "-U", "trame", "-d", "postgres", "-At", "-c", sql],
        capture_output=True, text=True,
    )


def main():
    scratch = WORKSPACE / ".scratch"
    scratch.mkdir(exist_ok=True)
    root = Path(tempfile.mkdtemp(dir=scratch, prefix="pg-lifecycle-"))
    (root / "unused-pglite").mkdir(mode=0o700)
    (root / "unused-pglite/PG_VERSION").write_text("18\n")
    app = None
    try:
        app = launch(root)
        wait_until(lambda: query(root, "SELECT 1").returncode == 0)
        assert not lock_available(root), "running database released root lock"
        assert query(root, "CREATE TABLE lifecycle(value text); INSERT INTO lifecycle VALUES ('preserved')").returncode == 0
        refused = subprocess.run(
            [BINARY, "migrate", root / "unused-pglite"],
            env={**os.environ, "TRAME_LOCAL_DIR": str(root)}, capture_output=True, text=True,
        )
        assert refused.returncode != 0 and "already running or migrating" in refused.stderr
        app.kill()
        app.wait()
        wait_until(lambda: lock_available(root))
        assert query(root, "SELECT 1").returncode != 0, "database survived parent SIGKILL"
        app = launch(root)
        wait_until(lambda: query(root, "SELECT value FROM lifecycle").stdout.strip() == "preserved")
        postmaster = int((root / "postgres/postmaster.pid").read_text().splitlines()[0])
        os.kill(postmaster, signal.SIGQUIT)
        app.wait(timeout=20)
        wait_until(lambda: lock_available(root))
        app = launch(root)
        wait_until(lambda: query(root, "SELECT value FROM lifecycle").stdout.strip() == "preserved")
        assert "automatic recovery in progress" in (root / "test.log").read_text(), "WAL recovery was not exercised"
        app.terminate()
        app.wait(timeout=20)
        assert lock_available(root)
        refused = subprocess.run(
            [BINARY, "migrate", root / "unused-pglite"],
            env={**os.environ, "TRAME_LOCAL_DIR": str(root)}, capture_output=True, text=True,
        )
        assert refused.returncode != 0 and "existing PostgreSQL cluster" in refused.stderr
        assert (root / "postgres/PG_VERSION").exists(), "refusal destroyed existing data"
        (root / "postgres/PG_VERSION").write_text("17\n")
        app = launch(root)
        app.wait(timeout=20)
        assert query(root, "SELECT 1").returncode != 0, "unsupported PostgreSQL version accepted"
        assert lock_available(root)
        (root / "postgres/PG_VERSION").write_text("18\n")
        shutil.rmtree(root / "postgres")
        app = launch(root)
        wait_until(lambda: (root / "postgres").exists())
        app.kill()
        app.wait()
        wait_until(lambda: lock_available(root))
        app = launch(root)
        wait_until(lambda: query(root, "SELECT 1").returncode == 0)
        app.terminate()
        app.wait(timeout=20)
        print("PASS: concurrent-owner refusal, parent SIGKILL, preserved restart, SIGQUIT/WAL recovery, graceful shutdown, existing-cluster refusal, wrong-version refusal, startup death/restart")
    finally:
        if app is not None and app.poll() is None:
            app.terminate()
            app.wait(timeout=20)
        wait_until(lambda: lock_available(root))
        shutil.rmtree(root)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--parent":
        parent(Path(sys.argv[2]))
    else:
        main()
