---
title: "v0.14.0 — native runtime, macOS, card view"
sidebar:
  label: "v0.14.0"
---

Trame now runs as a native app: a Tauri 2 shell, a Rust backend and a bundled
PostgreSQL 18 replace the Deno runtime and PGlite. It ships for Linux and, for the
first time, macOS arm64. The hub protocol moves from 4 to 8, so read **Upgrading**
before installing.

## Native runtime

- **Tauri 2 + axum + PostgreSQL 18.** The React UI is unchanged; the backend is an
  in-process Rust server, and PostgreSQL runs as a supervised child on a private Unix
  socket. No Deno install is needed at runtime.
- **One-shot migration on Linux.** On first launch, legacy `pglite/` data is copied,
  exported, imported into the new cluster and verified before it is installed. The
  original `pglite/` directory is left untouched.
- **Native `tramecli`** ships inside every package. `tramecli hook` replaces the Deno
  Claude Code / Codex hook, and `tramecli mcp` serves the MCP tools.
- The window remembers its size and position across restarts, including on
  mixed-scale displays.
- SIGTERM and macOS Quit stop PostgreSQL cleanly and remove `port.json`.

## macOS arm64

- An ad-hoc signed **DMG** bundles a relocatable PostgreSQL 18.6 and `tramecli`.
- macOS does not migrate PGlite data: the new cluster starts empty and the hub sync
  refills it.
- The app declares its Local Network use. Grant the permission when macOS asks for
  it, or hub sync fails with `No route to host (os error 65)`.

## Board and cards

- **Card view and agent journal**: a full-size card page that follows live changes
  and polls the journal while an agent works on it. PR links show as badges.
- **Graph view** of the board, with assignee, due flag and card age.
- **Compact board mode** (one line per card), a built-in **todo** column, paged done
  columns, and PR chips that poll for status.
- Stories order by priority tag; tag chips appear on stories and cards.
- **Deployments** show which cards a waiting release ships, and can be cancelled.
- A soft-deleted card can be restored.

## Pages and databases

- Star pages, drag a page into another, and see recently modified pages in the
  sidebar.
- A page-level **Activity** feed merges the worklogs of every linked session.
- Database **chart views** (bar, line, pie), graph diagrams, KPI cards, inline
  table editing and html blocks.

## Agents and CLI

- `tramecli archive`, `tramecli db rows`, `tramecli convert` (page → card) and a
  gh-style query syntax shared by the board and `tramecli list`.
- Presence hooks for Claude Code and Codex show which agent works on a card or todo.
- One card per agent session and story, not per branch.
- The hub serves the app's `/api`, so `tramecli` works on machines with no local app.
- Out-of-tree plugins are composed at build time; Cockpit moved to its own repo.

## Upgrading

- **Protocol 8.** The hub and every node must run v0.14.0. Redeploy the hub first.
- **Linux:** install the AppImage or the deb, quit the old app, then launch the new one.
  Keep `pglite/` until you have checked the migrated data. The legacy AppImage
  updater does not pick up the native AppImage; install it by hand once.
- **macOS:** run a final sync from the old app and quit it, then install the DMG. The
  first launch pulls everything from the hub.
- Point agent hooks at `tramecli hook` and MCP configs at `tramecli mcp`.
- Snap packaging still builds but has not been tested on a target host.
