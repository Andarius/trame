#!/usr/bin/env bash
# DESCRIPTION: Restore a copied PGlite export into isolated PG18 and compare it from Rust.
# USAGE: scripts/rust-db-verify.sh
set -euo pipefail
cd "$(dirname "$0")/.."
scratch="$PWD/.scratch/stage0"
pgbin="$scratch/pg18/usr/lib/postgresql/18/bin"
deno eval 'import { scratchPath } from "./scripts/rust-db-export.ts"; for (const path of Deno.args) await scratchPath(path);' "$scratch/pg18-data" "$scratch/pg18-socket"
export CARGO_HOME="$PWD/.scratch/cargo-home"
cargo build -p trame-db-spike -j 4
if "$pgbin/pg_ctl" -D "$scratch/pg18-data" status > /dev/null 2>&1; then
  echo 'Refusing to restore over a running scratch database.' >&2
  exit 1
fi
"$pgbin/pg_ctl" -D "$scratch/pg18-data" -l "$scratch/db-pg18.log" -o "-c listen_addresses='' -k $scratch/pg18-socket -p 55438" start
trap '"$pgbin/pg_ctl" -D "$scratch/pg18-data" -m fast stop' EXIT
"$pgbin/psql" -h "$scratch/pg18-socket" -p 55438 -d postgres -v ON_ERROR_STOP=1 -f db/schema.sql > "$scratch/db-schema.log" 2>&1
"$pgbin/psql" -h "$scratch/pg18-socket" -p 55438 -d postgres -v ON_ERROR_STOP=1 -f "$scratch/db-data.sql" > "$scratch/db-import.log" 2>&1
wasm="${XDG_CACHE_HOME:-$HOME/.cache}/deno/npm/registry.npmjs.org/@electric-sql/pglite/0.5.3/dist/pglite.wasm"
target/debug/trame-db-spike "$scratch/db-export.json" "$PWD/db/schema.sql" "$wasm" "$scratch/pg18-socket" > "$scratch/db-evidence.json"
python3 - "$scratch/db-evidence.json" <<'PY'
import json
import sys
e = json.load(open(sys.argv[1]))
if not e['migration_before_schema_reapply']['pass'] or not e['migration_foreign_keys']['pass']:
    raise SystemExit('Migration cell/schema/sequence comparison failed; see db-evidence.json')
print('All exported cells, column metadata, and sequence state match in PostgreSQL18 via Rust.')
print('Schema reapply preserves snapshot:', e['migration_after_schema_reapply']['pass'])
PY
