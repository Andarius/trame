---
title: "v0.28.0 — Deployments moves to its own repo"
sidebar:
  label: "v0.28.0"
---

The Deployments plugin leaves Trame and ships from
[Andarius/trame-deployments](https://github.com/Andarius/trame-deployments), which now groups
deployments by project with their logos.

## Breaking

- **Deployments is out of tree.** Trame no longer bundles it. Install it with
  `tramecli plugins add Andarius/trame-deployments`: it keeps its settings, and
  `tramecli deployments ships` now comes with the plugin.

## Features

- **Plugin API.** Out-of-tree plugins reach the helpers Deployments needed (`spawn_terminal`,
  `output_within`, `scratch_path`, `encode`) and record session events through
  `Write::AddSessionEvent`. Plugin e2e specs set their backend env through `e2e/env.json`.

## Fixes

- Settings says why an update check found no release.
- Security updates for rustls, tokio, mermaid, hono and zod.

## Upgrading

- No protocol or schema change: v0.14.0 to v0.28.0 nodes sync with each other.
- The macOS app and the AppImage update themselves; deb and snap installs get a link to the release.
