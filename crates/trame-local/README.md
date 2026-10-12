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
export CARGO_HOME="$PWD/.scratch/cargo-home"
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
TRAME_DIFF_GROUPS=full deno run -A --config app/deno.json scripts/rust-pages-diff.ts
python3 scripts/rust-db-lifecycle-test.py
deno test -A --config app/deno.json scripts/rust-db-export-test.ts scripts/rust-db-migrate-test.ts
```

The differential gate clones the stopped `.scratch/stage1/copied-app` database
into two isolated roots. It compares response bytes, every public-table row,
sequence state and PostgreSQL notifications after deterministic replay. Only the
import listing's clone-specific directory prefixes are normalized. Test-only
`TRAME_DIFF_TS_ORACLE=1` selects the original TypeScript handler in debug builds;
release builds cannot select it. The original TS sources remain regression
oracles and shared frontend/hub source, outside the production backend.

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

Packaged startup migrates an existing `pglite` subdirectory before starting the
native server, then checks its source fingerprint on subsequent starts. A changed
legacy source or interrupted private staging blocks startup for deliberate recovery.
The bundled `trame-migrate-pglite` executable is a **one-shot legacy
export helper** compiled from the proven PGlite exporter. It retains an embedded
JavaScript/Wasm runtime because PGlite's Emscripten format cannot be opened by
native PostgreSQL. No installed `deno` command is required. Normal app operation,
CLI and MCP are Rust; this helper is used only during legacy conversion.

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
run `deno run --allow-read scripts/rust-protocol.ts --check` to check drift.

```sh
bash scripts/rust-package.sh deb
bash scripts/rust-package.sh appimage
```

Packaging includes the native CLI, migration helper, PG18 resources and built
frontend. Snapcraft extracts the Debian payload and stages its declared runtime
libraries. Package verification and outstanding platform limits are recorded in
`.scratch/full-packaging-report.html`.
