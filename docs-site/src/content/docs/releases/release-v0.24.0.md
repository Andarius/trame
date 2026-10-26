---
title: "v0.24.0 — Timeline, plugins from their repos, lighter memory"
sidebar:
  label: "v0.24.0"
---

A Timeline view of your cards, plugins you install from their GitHub link, and a much smaller
memory footprint.

## Features

- **Timeline.** A new view in the rail, built from the worklog: a Gantt with one bar per card from
  its first entry to its last, colored by status (group by project or status; 2 weeks, 6 weeks or a
  quarter), and a journal of entries by day, card and agent. Clicking a card opens it.
- **Plugins from their repos.** Build Trame with native plugins from plain `owner/repo` links:
  `tramecli plugins add owner/repo` builds it locally, or a repository of yours that calls Trame's
  compose workflow publishes your own self-updating build. See the [Plugins](/plugins/) page.
- **Plugin blocks.** Plugins can add their own page block types, and share Trame's buttons, inputs
  and fields. The first one is [notebook cells](https://github.com/Andarius/trame-notebook-cells):
  Python cells on a page, run on a Jupyter kernel.
- **`tramecli due`.** Lists due todos with their card, project and a link that scrolls to the todo;
  agents get the same as the `trame_due` MCP tool.

## Fixes

- Memory: about 40 MB instead of several hundred on a large board. Malloc arenas are capped, and
  board and page polls skip unchanged data. Diagnostics counts terminal shells apart.
- A failed update check is no longer cached or shown as "up to date"; Settings says when GitHub
  could not be reached.
- The AppImage copies `tramecli` into `~/.local/bin` instead of linking into its temporary mount,
  which left a dangling link once the app quit.

## Upgrading

- No protocol or schema change: v0.14.0 to v0.24.0 nodes sync with each other.
- The macOS app and the AppImage update themselves; deb and snap installs get a link to the release.
