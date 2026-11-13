---
title: Native desktop runtime
description: Tauri 2, Rust and local PostgreSQL startup and migration.
---

Trame uses a Tauri 2 shell with the existing React UI, an in-process Rust axum server,
and a supervised PostgreSQL 18 child. The native `tramecli` discovers the local server
through its port file. The hub protocol and database schema stay compatible.

## Data and startup

The default data root is `$XDG_DATA_HOME/trame`, or `~/.local/share/trame`.
`TRAME_LOCAL_DIR` overrides it. The root holds `postgres/`, `socket/`, `settings.json`,
and `port.json`. An exclusive owner lock prevents two app instances from opening the
same database. PostgreSQL listens on a private Unix socket and stops with the app.

Packaged deb, classic snap and AppImage builds include PostgreSQL, React assets and the
native CLI; nothing else needs installing. On macOS arm64, an ad-hoc signed DMG bundles a
relocatable PostgreSQL 18 (theseus-rs/postgresql-binaries) and the native CLI; install it with the
quickstart, which does not quarantine the download. A DMG downloaded through a browser needs
right-click → Open the first time.

## Legacy migration and rollback

On macOS, legacy `pglite/` data is left untouched: run a final sync from the old app, quit it,
and the native app starts with an empty cluster that the hub sync refills.

On Linux, on first launch with legacy `pglite/` data and no PostgreSQL cluster, Trame checks that the
source is stopped, copies it, exports the copy, imports it into a new PostgreSQL cluster,
and verifies it before installing it. Only v0.19.x packages bundle the migration helper (it
retains the PGlite JavaScript/Wasm runtime); later packages refuse to start on unmigrated
`pglite/` data, so run v0.19.x once first.

Keep the original legacy data and the migration backup until the new installation has
been verified. To roll back, stop Trame, preserve the new data root, and restore the saved
legacy copy for the old application. Changes made after migration need a separate export;
never replace a running database directory.

## Out-of-tree plugins

Private plugins listed in `plugins.local.json` never compile into release builds. `just plugins`
composes them: each plugin's `src/mod.rs` becomes a module of `trame-local` (so a plugin's routes run
in the app's own process, with the full request and response), its `mark-roles.json` joins the
hierarchy rules, and `just plugins-install` builds their frontend into the live data root as
`plugins/web/plugins.{js,css}` (built against `window.__trame`), which the frontend loads before its
first render. A backend change is a rebuild of the app; settings stay device-local, so a plugin runs
only where it is enabled.

## WebAssembly plugins

A plugin can instead ship as a WebAssembly component, loaded at startup with no rebuild of the app.
It implements `crates/trame-local/wit/plugin.wit`, is built with
`cargo build --target wasm32-wasip2 --release`, and installs as a folder named after its id:
`plugins/wasm/<id>/plugin.wasm` in the data root, with an optional `plugin.js` / `plugin.css`
frontend. `just wasm-plugin-install <dir>` copies one in; restart Trame to load it. A package that
fails to load shows on the Plugins page with the reason. Packages live in the data root, so
reinstalling or updating Trame keeps them; compiled components are cached in `plugins/wasm-cache`.

Its backend runs sandboxed: no files, no sockets, no processes, 256 MB of memory and 30 s per call,
a fresh instance per call and at most four at once. It reaches Trame only through the host imports:
its own settings slice, page and database reads, write plans applied in one transaction, and HTTP to
the hosts its manifest lists (`name` for the default port, `name:port` otherwise; the Plugins page
shows them). Loopback, private and link-local addresses are refused even when listed, including
names that resolve to them, and the app's cookies and credentials never reach the guest. A plugin
that needs more (subprocesses, WebSockets, a long-lived connection) stays native.

Its `plugin.js` is not sandboxed: it runs in the app page with the app's privileges, like a native
plugin's frontend, so install only packages you trust. `crates/trame-local/tests/fixtures/wasm-hello`
is a minimal one to copy. Builds without the default `wasm-plugins` feature
(`--no-default-features` on `trame-local` or `trame-desktop`) leave the runtime out.

## Isolated development

`just dev` and `just serve` use `.scratch/dev`, offline mode and a random loopback port.
Debug builds always confine data, imports, settings and assets to this worktree's `.scratch/`.
`TRAME_ISOLATED=1` applies that confinement to release builds for package testing;
`TRAME_OFFLINE=1` disables network activity and alone does not imply confinement in release builds.
Do not point test commands at live data.

`cargo test --workspace --locked` runs the Rust suites. `bash scripts/rust-e2e.sh` runs the
Playwright suite against the native backend.

## Verification and cutover

`just ts-check` typechecks, tests and lints the TypeScript still shipped or shared (plugin
host, core, protocol) in a clean scratch environment. `just migration` creates a synthetic
PGlite source, migrates it twice and checks source preservation. `just lifecycle` checks owner refusal, parent death, WAL recovery and
failed startup without requiring a developer's copied database.

The old `hack` recipe's TypeScript backend watcher is retired: `just web-dev` runs Vite against an
isolated backend, starting one for its lifetime unless `just serve` already runs. Restart it
after Rust changes. `just web-live` runs Vite against the running Trame app instead: real data
and real writes, with the installed backend. The old standalone
`sync` recipe is retired: the running native app owns synchronization, with an explicit sync
from the UI. Offline development deliberately disables it.

Publication requires a manual release dispatch with `allow_native_cutover=true`; tag pushes
cannot publish. The release verifies the resolved tag commit through the complete CI workflow
before building and publishing that same commit. Native AppImage assets omit `linux` from their
names to prevent selection by the legacy updater. Keep legacy updates pinned during rollout,
stop the old app, retain a stopped-source backup, and validate the new installation before
allowing production sync. Target-host Snap installation remains unqualified.
