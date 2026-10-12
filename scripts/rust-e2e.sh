#!/usr/bin/env bash
# DESCRIPTION: Run the unchanged Playwright suite through Rust with a fresh scratch database.
# USAGE: bash scripts/rust-e2e.sh [Playwright arguments]
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .scratch/stage1
run_dir="$(mktemp -d "$PWD/.scratch/stage1/e2e.XXXXXX")"
export TRAME_OFFLINE=1
export TRAME_ISOLATED=1
export TRAME_LOCAL_DIR="$run_dir/db"
export TRAME_E2E_DIR="$run_dir/fixtures"
cleanup() {
  if [[ -f "$TRAME_LOCAL_DIR/.owner.lock" ]]; then
    flock -w 30 "$TRAME_LOCAL_DIR/.owner.lock" true || return
  fi
  rm -rf -- "$run_dir"
}
trap cleanup EXIT
cd app/web
npx playwright test --config playwright.rust.config.ts "$@"
