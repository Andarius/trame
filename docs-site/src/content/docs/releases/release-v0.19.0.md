---
title: "v0.19.0 — SQL sources and auto-update"
sidebar:
  label: "v0.19.0"
---

Databases fill themselves from a Postgres query, cards open straight in an agent, and the desktop app
keeps itself up to date.

## Features

- **SQL sources.** On a database page, **⇣ Connect** fills the database from a read-only query on a
  PostgreSQL you choose: pick the key column, a schedule, and whether vanished rows are removed; a dry
  run previews the first fill. Columns a source fills are display-only, and `tramecli db rows`
  refuses to write them.
- **Open in agent.** The card drawer's Resume button becomes a split button: open the card in Claude
  Code or Codex, resuming its own session when there is a local transcript, else starting in the
  card's repo. A Desktop app mode opens Claude Desktop or Codex Desktop instead.
- **Auto-update.** The macOS app and the AppImage download new releases in the background and swap
  them in place; **Restart now** in the banner or Settings runs the new version.
  `TRACKER_AUTO_UPDATE=0` keeps the check but skips the download.
- **Graph:** double-click a project to filter on it.
- Debug builds tint the logo blue, so a dev window can't pass for the installed app.

## Upgrading

- No protocol or schema change: v0.14.0 to v0.19.0 nodes sync with each other.
- Auto-update starts with this version: install v0.19.0 by hand once; later releases arrive on
  their own. deb and snap installs only get a link to the release.
