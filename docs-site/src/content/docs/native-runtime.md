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
native CLI. No installed Deno runtime is needed. Linux x64 is the current package target.
macOS PostgreSQL bundling and package installation remain unimplemented and unverified.

## Legacy migration and rollback

On first launch with legacy `pglite/` data and no PostgreSQL cluster, Trame checks that the
source is stopped, copies it, exports the copy, imports it into a new PostgreSQL cluster,
and verifies it before installing it. The bundled one-shot migration helper retains the
PGlite JavaScript/Wasm runtime; the running backend uses Rust exclusively.

Keep the original legacy data and the migration backup until the new installation has
been verified. To roll back, stop Trame, preserve the new data root, and restore the saved
legacy copy for the old application. Changes made after migration need a separate export;
never replace a running database directory.

## Isolated development

`just dev` and `just serve` use `.scratch/dev`, offline mode and a random loopback port.
Debug builds always confine data, imports, settings and assets to this worktree's `.scratch/`.
`TRAME_ISOLATED=1` applies that confinement to release builds for package testing;
`TRAME_OFFLINE=1` disables network activity and alone does not imply confinement in release builds.
Do not point test commands at live data.

`cargo test --workspace --locked` runs the Rust suites. `bash scripts/rust-e2e.sh` runs the
unchanged Playwright suite through Rust. The retained TypeScript backend is a regression
oracle used by the differential harness, not a production dependency.

## Verification and cutover

`just oracle-check` retains the TypeScript backend, core and CLI typechecks, tests and lint in
a clean scratch environment. `just differential` creates a synthetic PGlite source, migrates it
twice, checks source preservation, and compares native HTTP/CLI behavior with the retained
TypeScript oracle. `just lifecycle` checks owner refusal, parent death, WAL recovery and
failed startup without requiring a developer's copied database.

The old `hack` recipe's Deno backend watcher is retired: use `just serve` and `just web-dev`
in separate terminals, and restart the native backend after Rust changes. The old standalone
`sync` recipe is retired: the running native app owns synchronization, with an explicit sync
from the UI. Offline development deliberately disables it.

Publication requires a manual release dispatch with `allow_native_cutover=true`; tag pushes
cannot publish. The release verifies the resolved tag commit through the complete CI workflow
before building and publishing that same commit. Native AppImage assets omit `linux` from their
names to prevent selection by the legacy updater. Keep legacy updates pinned during rollout,
stop the old app, retain a stopped-source backup, and validate the new installation before
allowing production sync. macOS resources/packages and target-host Snap installation remain
cutover blockers until independently qualified.
