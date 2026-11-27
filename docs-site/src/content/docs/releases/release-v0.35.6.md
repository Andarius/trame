---
title: "v0.35.6 — Flat tabs"
sidebar:
  label: "v0.35.6"
---

Terminal tabs are flat and full-height with project and agent icons, Konsole's shortcuts work, and dropped files type their path.

## Features

- **Flat tabs.** Full-height tabs in the IDE style, each with its project's icon, or its agent's or a terminal glyph (#510).
- **Konsole shortcuts.** Ctrl+Shift+T opens a tab, Ctrl+Shift+W closes one, Shift+←/→ and Ctrl+PgUp/PgDn switch tabs (#510).
- **File drops.** Dropping files on a shell types their quoted paths (#510).

## Fixes

- **Stale shells.** A shell whose agent or command has ended no longer reopens on restart (#508).
- **Scrollbars.** The tab strips no longer show a horizontal scrollbar (#509).
- **Forks.** Clicking a fork shows its shell instead of opening a hidden one (#511).
- **Rail.** No plugins divider when there are no plugins (#505).

## Other

- CI lints `db/schema.sql` with squawk (#492).
