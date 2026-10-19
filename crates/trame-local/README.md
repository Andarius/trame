# Native local runtime

Trame runs an axum backend in the Tauri 2 process and supervises bundled PostgreSQL
18 on a private Unix socket. React and the hub protocol remain unchanged. Normal
startup does not run Deno or a TypeScript backend. The standalone `trame-local`
binary serves the same backend without a window.

## Worktree verification

All development checks below use disposable data inside this worktree. Debug
builds require a worktree `.scratch` root. Set `TRAME_ISOLATED=1` for the same
confinement in release builds. `TRAME_OFFLINE=1` disables hub and remote work;
it is a separate network switch. Never point these commands at running app data.

```sh
export TRAME_ISOLATED=1
export TRAME_OFFLINE=1
export TRAME_LOCAL_DIR="$PWD/.scratch/native-app"
export TRACKER_PORT=0
bash scripts/rust-package.sh prepare
export TRAME_PG_BIN="$PWD/.scratch/package/pg/usr/lib/postgresql/18/bin"
npm ci --prefix app/web
npm run build --prefix app/web
cargo build -p trame-local -p trame-cli --locked
target/debug/trame-local
```

The bound port and PID are published privately in `$TRAME_LOCAL_DIR/port.json`
(or `TRACKER_PORT_FILE`). Ports 8787 and 5181 are refused. PostgreSQL has no TCP
listener; its socket filename must fit Linux's 107-byte limit. Host, Origin and
Fetch-Site checks protect the HTTP front door. Local CLI access needs no token,
matching the existing local API.

```sh
cargo test --workspace --locked
bash scripts/rust-e2e.sh
python3 scripts/rust-db-lifecycle-test.py
bun test ./scripts
```

## Legacy data migration

An existing PG18 PGlite directory is fingerprinted and copied before it is opened.
Only a disposable copy is opened by PGlite. Rust imports the export, compares
all rows, column metadata and sequences, reapplies the shared schema, and
atomically installs PostgreSQL. The original and an untouched backup survive.
An open source, overlapping paths, unsupported major version or unrelated
existing target is refused. Repeating a completed migration is a no-op.

```sh
TRAME_LOCAL_DIR="$PWD/.scratch/migrated-app" TRAME_ISOLATED=1 TRAME_OFFLINE=1 \
  target/debug/trame-local migrate "$PWD/.scratch/stage0/pglite-copy"
```

Packaged startup migrates an existing `pglite` subdirectory when no PostgreSQL
cluster exists yet; once migrated, the legacy source is ignored. Interrupted
private staging blocks startup for deliberate recovery.
Packages after v0.19.x no longer bundle the `trame-migrate-pglite` helper (a
Deno-compiled PGlite exporter, ~140 MB): unmigrated `pglite/` data needs v0.19.x
once. Debug builds fall back to `bun scripts/rust-db-migrate.ts`, and
`TRAME_MIGRATION_HELPER` points at a compiled helper. Normal app operation, CLI
and MCP are Rust.

## Installed resources

Release `Config::from_env()` uses `TRAME_LOCAL_DIR`, otherwise `$XDG_DATA_HOME/trame`
(or `~/.local/share/trame`); debug defaults to `.scratch/dev-local`. Release
`TRAME_OFFLINE=1` disables network activity without changing the data root.
The desktop supplies its bundled PostgreSQL and web
resource paths; `TRAME_PG_BIN` and `TRAME_WEB_DIR` override them. Window geometry is
persisted by Tauri. Device settings, outbox, assets and port discovery retain their
existing environment overrides. Node identity defaults to the hostname.

The schema remains `db/schema.sql`, embedded into Rust and reapplied at startup.
`protocol/rust-entities.json` is generated from the shared TypeScript wire registry;
run `bun scripts/rust-protocol.ts --check` to check drift.

```sh
bash scripts/rust-package.sh deb
bash scripts/rust-package.sh appimage
```

Packaging includes the native CLI, PG18 resources (pruned to the server, `initdb`,
`psql` and dump/recovery tools) and built frontend. Snapcraft extracts the Debian
payload; like the deb, the classic snap uses the host's runtime libraries.
Package verification and outstanding platform limits are recorded in
`.scratch/full-packaging-report.html`.
