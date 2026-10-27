---
title: "v0.25.0 — Plugins declare the Trame they need"
sidebar:
  label: "v0.25.0"
---

Plugin releases say which Trame versions they work with, and plugins write pages and sessions in
one transaction.

## Features

- **Trame range.** A plugin declares `TRAME` (for example `">=0.25.0"`) in its `version.ts`. A
  build from repo links stops with a clear message when a plugin declares none or excludes the Trame
  being built, and records each plugin's range in its lock. Local composing only warns. See the
  [Plugins](/plugins/) page.
- **One write plan.** Plugins write pages, sessions, statuses and tags through `api::apply`, which
  runs the whole plan in one transaction: a failed write leaves nothing half-written.

## Upgrading

- No protocol or schema change: v0.14.0 to v0.25.0 nodes sync with each other.
- Plugins composed from repo links need a release that declares `TRAME`:
  [notebook-cells](https://github.com/Andarius/trame-notebook-cells) v0.1.1 and
  [k8s](https://github.com/Andarius/trame-k8s) v0.2.1 do.
- The macOS app and the AppImage update themselves; deb and snap installs get a link to the release.
