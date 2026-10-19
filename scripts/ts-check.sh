#!/usr/bin/env bash
# DESCRIPTION: Typecheck, test and lint the TS still shipped or shared, without inherited device credentials or live paths.
# USAGE: bash scripts/ts-check.sh
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .scratch
run_dir="$(mktemp -d "$PWD/.scratch/ts-check.XXXXXX")"
trap 'rm -rf -- "$run_dir"' EXIT
mkdir -p "$run_dir/tmp"
clean_env=(env -i PATH="$PATH" HOME="$run_dir/home" TMPDIR="$run_dir/tmp"
    XDG_DATA_HOME="$run_dir/data" CODEX_HOME="$run_dir/codex"
    TRAME_ISOLATED=1 TRAME_OFFLINE=1 TRAME_LOCAL_DIR="$run_dir/native"
    TRACKER_DATA_DIR="$run_dir/pglite" TRACKER_SETTINGS_FILE="$run_dir/settings.json"
    TRACKER_NODE_ID=ts-check
)
bun install --frozen-lockfile --silent
bunx tsc --noEmit -p .
# app tests configure modules through env before importing them: one process per file
for test_file in app/*_test.ts; do
    "${clean_env[@]}" bun test "./$test_file"
done
"${clean_env[@]}" bun test ./app/plugins ./app/web/src ./scripts
deno lint app core protocol
