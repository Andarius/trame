---
title: "v0.29.0 — Plugins from one repo, terminals that come back"
sidebar:
  label: "v0.29.0"
---

SQL sources move out to the trame-plugins repo, a plugin spec can name one plugin of a plugins repo, and
terminals reopen after a restart, resuming their agents.

## Breaking

- **SQL sources are a plugin.** The built-in SQL source is removed. Add it back with
  `tramecli plugins add Andarius/trame-plugins/sql-source`; its settings carry over (#324).

## Features

- **Plugin specs `owner/repo/name`.** Install one plugin of a plugins repo, released as `<name>-vX.Y.Z`
  tags (#324). The plugin API gains user-database writes and a rollback-only dry run (#315).
- **Terminals reopen after a restart.** Live shells are saved every 10 s and at shutdown, and the next
  launch reopens them with their folder, card and Claude or Codex session resumed (#312).
- **A tab tints when its agent needs you**: a permission prompt, a question, or a finish while out of
  sight (#314).
- **Konsole-style panes**: split with Ctrl+( and Ctrl+), maximize with Ctrl+Shift+E, drag a pane's title
  bar to move its shell, and an **All shells** row (#304). Ctrl+Shift+←/→ switch tabs (#313).
- **One sidebar entry per agent session**, named by `/rename` (#308).
- **Image previews**: hover an image path a shell printed for a thumbnail, click for full size (#307).
- **AI Sessions** marks sessions already running in a Trame terminal (#306).
- **Updates** show the plugin rebuild's progress, and keep its result past a dropped request (#310).

## Fixes

- Shells get the host environment, not the AppImage's (`LD_LIBRARY_PATH`, `PYTHONHOME`, …) (#305).
- Settings → **Update now** shows why an update failed instead of going back to idle (#297).
- Dependency updates, including security fixes for astro, vite and sharp.

## Upgrading

- No protocol or schema change: v0.14.0 to v0.29.0 nodes sync with each other.
- Using SQL sources? Run `tramecli plugins add Andarius/trame-plugins/sql-source` after updating.
- The macOS app and the AppImage update themselves; deb and snap installs get a link to the release.
