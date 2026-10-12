# DESCRIPTION Measure the Stage 0 workspace without launching a listener or window.
# USAGE python3 scripts/rust-build-times.py
import json
import os
from pathlib import Path
import subprocess
import time


root = Path(__file__).resolve().parents[1]
output = root / ".scratch/stage0/build-times.json"
env = os.environ | {"CARGO_HOME": str(root / ".scratch/cargo-home"), "CARGO_BUILD_JOBS": "4"}
results = []


def measure(label, target, release=False):
    command = ["cargo", "build", "-p", "trame-probe", "--features", "desktop-bench", "--locked"]
    if release:
        command.append("--release")
    started = time.monotonic()
    with (output.parent / f"build-{label}.log").open("w") as log:
        run = subprocess.run(command, cwd=root, env=env | {"CARGO_TARGET_DIR": str(target)}, stdout=log, stderr=log)
    result = {"case": label, "seconds": round(time.monotonic() - started, 3), "exit_code": run.returncode}
    results.append(result)
    output.write_text(json.dumps(results, indent=2) + "\n")
    print(json.dumps(result), flush=True)
    if run.returncode:
        raise RuntimeError(f"{label} failed; see build log")


def edited(label, target, path, before, after, release=False):
    original = path.read_bytes()
    if original.count(before) != 1:
        raise RuntimeError(f"expected one edit anchor in {path.name}")
    try:
        path.write_bytes(original.replace(before, after))
        measure(label, target, release)
    finally:
        path.write_bytes(original)


if __name__ == "__main__":
    debug = output.parent / "cold-debug"
    release = output.parent / "cold-release"
    if debug.exists() or release.exists():
        raise RuntimeError("cold targets already exist; preserve prior evidence instead of overwriting")
    measure("cold-debug", debug)
    measure("cold-release", release, True)
    core = root / "crates/trame-core/src/todo_marks.rs"
    route = root / "crates/trame-probe/src/lib.rs"
    edited("incremental-core-debug", debug, core, b"UPDATED_CAP: usize = 5", b"UPDATED_CAP: usize = 6")
    measure("restore-core-debug", debug)
    edited("incremental-route-debug", debug, route, b'"spike": true', b'"spike": false')
    measure("restore-route-debug", debug)
    edited("incremental-core-release", release, core, b"UPDATED_CAP: usize = 5", b"UPDATED_CAP: usize = 6", True)
    measure("restore-core-release", release, True)
    edited("incremental-route-release", release, route, b'"spike": true', b'"spike": false', True)
    measure("restore-route-release", release, True)
