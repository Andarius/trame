---
title: "v0.15.0 — out-of-tree plugins on the native runtime"
sidebar:
  label: "v0.15.0"
---

Private plugins work again. The native runtime could not load the out-of-tree plugins the
Deno backend used to compile in, so they stopped at the v0.14.0 cutover. They now run in a
supervised host process, and release builds still contain no private code.

## Out-of-tree plugins

- **`just plugins-install`** builds the plugins listed in `plugins.local.json` into the data
  directory: `plugins/plugin-host`, a compiled Deno program running the TypeScript plugin
  registry, and `plugins/web/plugins.{js,css}`, their frontend bundle.
- **The app supervises the host.** It starts the host with a per-launch token and the
  PostgreSQL socket, restarts it with backoff, and forwards `/api/plugins/<id>/*` to it.
  Its plugins appear in the plugins manager, and their mark roles apply. The host never
  changes the schema, and exits when the app does.
- **The frontend loads plugin UI at runtime.** The bundle is loaded before the first render
  and takes React and `@trame/web-api` from the app, so a plugin's panel, settings and card
  slots need nothing compiled into the release.

## Development

- `just web-dev` starts its own isolated backend unless `just serve` already runs.
- **`just web-live`** runs Vite with hot reload against the running app: real data and
  real writes, for frontend work.
- `just reset-local` is gone: it deleted the live PostgreSQL database.
- CI caches Rust builds and runs Rust, e2e, oracle and packaging as parallel jobs.
  A PR now takes about 6 minutes instead of 17.

## Upgrading

- No protocol or schema change: v0.14.0 and v0.15.0 nodes sync with each other.
- With private plugins: after updating the app, run `just plugins-install` from your
  checkout and restart Trame. Enable a plugin on one machine only; settings are per device.
