#!/usr/bin/env bash
# DESCRIPTION: Typecheck, test and lint the TS still shipped or shared, without inherited device credentials or live paths.
# USAGE: bash scripts/deno-check.sh
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .scratch
run_dir="$(mktemp -d "$PWD/.scratch/deno-check.XXXXXX")"
trap 'rm -rf -- "$run_dir"' EXIT
cache="${DENO_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/deno}"
deno_bin="$(command -v deno)"
mkdir -p "$run_dir/tmp" "$run_dir/claude-projects" "$run_dir/codex-sessions"
cd app
clean_env=(env -i PATH="$PATH" DENO_DIR="$cache" TMPDIR="$run_dir/tmp"
    XDG_DATA_HOME="$run_dir/data" CODEX_HOME="$run_dir/codex"
    TRAME_ISOLATED=1 TRAME_OFFLINE=1 TRAME_LOCAL_DIR="$run_dir/native"
    TRACKER_DATA_DIR="$run_dir/pglite" TRACKER_SETTINGS_FILE="$run_dir/settings.json"
    TRACKER_PORT_FILE="$run_dir/port.json" TRACKER_OUTBOX="$run_dir/outbox.jsonl"
    TRACKER_TLS_DIR="$run_dir/certs" TRACKER_CLAUDE_MAP="$run_dir/claude-map.json"
    TRACKER_ASSETS_DIR="$run_dir/assets" TRACKER_CLAUDE_DIR="$run_dir/claude-projects"
    TRACKER_CODEX_DIR="$run_dir/codex-sessions" TRACKER_REPORT_PATHS="$run_dir/reports"
    TRACKER_PORT=0 TRACKER_NODE_ID=deno-check TRACKER_UPDATE_CHECK=0
)
"${clean_env[@]}" "$deno_bin" check plugin-host.ts ../track/track.ts ../track/page.ts ../track/comment.ts ../track/watch.ts ../track/cli.ts ../mcp/server.ts
"${clean_env[@]}" "$deno_bin" test -A
"$deno_bin" lint
"$deno_bin" lint ../core ../track ../mcp
