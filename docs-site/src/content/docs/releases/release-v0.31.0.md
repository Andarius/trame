---
title: "v0.31.0 — WebAssembly plugins"
sidebar:
  label: "v0.31.0"
---

Plugins can ship as WebAssembly, with no rebuild of Trame, and a reinstall no longer silently drops
the plugins you built in.

## Features

- **WebAssembly plugins (experimental).** A plugin can be a WebAssembly component on
  `trame:plugin@0.1.0` instead of a Rust module compiled into the app. Build it on its own
  (`cargo build --target wasm32-wasip2`), copy it in with `just wasm-plugin-install <dir>`, restart
  Trame. Packages live in the data folder, so updates and reinstalls keep them. The backend runs
  sandboxed: no files, sockets or processes, 256 MB and 30 s per call, and HTTP only to the hosts its
  manifest lists, never to this machine or the local network. Its optional frontend is not
  sandboxed, so install only packages you trust. The Plugins page shows each package's hosts and why
  a package failed to load (#353). Native plugins are unchanged.
- **Get your plugins back after a reinstall.** A stock AppImage installed over a
  `tramecli plugins build` now notices the plugins listed in `plugins.json` that it lacks and offers
  **Rebuild now**, the same rebuild a plugin build uses for its updates (#354).

## Developer

- `crates/trame-local/tests/fixtures/wasm-hello` is a minimal WebAssembly plugin to start from.
  `--no-default-features` on `trame-local` or `trame-desktop` builds without the WebAssembly runtime.
