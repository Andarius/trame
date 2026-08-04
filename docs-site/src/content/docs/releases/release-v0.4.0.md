---
title: "v0.4.0 — Codex support, editable columns, quick-find, comments, database views, page sharing & a deployments plugin"
sidebar:
  label: "v0.4.0"
---

Trame now tracks **Codex** sessions alongside Claude Code, the board columns are **yours to
define**, and pages gain **inline comments** and **sharing**. Databases get real **views**
(sort / filter / group / summary), a **Ctrl+P** palette jumps to anything, and a new **plugin
system** debuts with GitHub/GitLab **deployment approvals** in the sidebar.

## Highlights

### Coding agents — Claude Code **and** Codex
- Import and **resume Codex** sessions (`codex resume <id>`) next to Claude Code, from the
  same board card. The import dialog scans both `~/.claude/projects` and `~/.codex/sessions`,
  tags each row with its source, and hides subagent rollouts.
- One installer for tracking: `just install-track` lets you pick Claude Code, Codex, or both.
  Codex ships a native `$trame-track` skill; Claude Code keeps the `/trame:track` slash command
  plus a `UserPromptSubmit` hook that records the session id so **Resume** works.

### Editable board columns (statuses)
- Add, rename, recolor, reorder, and delete the kanban **status columns** — the old fixed
  `active / paused / blocked / done` are just the defaults now. Mark any column "done-like"
  (**terminal**) and it counts as done everywhere. Columns are **synced**, so the layout
  follows you across machines.
- A **Columns** toolbar menu hides empty statuses and reorders columns per-machine.

### Quick-find command palette (Ctrl / Cmd + P)
- One recency-ranked search across sessions, projects, pages, and databases. Arrow-key
  navigation; Enter opens the session drawer, page, client, or database.

### Inline page comments
- Block-anchored comments on pages with resolve / reopen, edit, and delete. Set a display
  **name + avatar** in Settings; comments still list even after their block text is removed
  (an "orphaned comments" section keeps the note).

### Database views
- Per-database **view tabs** you can add, rename, and delete. Each holds its own
  **multi-column sort**, **type-aware filters** (contains / is / comparisons / empty / …), and
  **group-by** with per-group aggregates (sum / avg / min / max). A "N of M" counter and a
  "no rows match" state show when a filter or sort is active.
- **Summary views**: a read-only aggregate table — one row per group with its count and each
  configured aggregate, a live projection of the underlying rows.
- View tabs are **stored on the hub** (`udb_databases.views`), so they sync across devices
  instead of living only in one browser's localStorage.
- **Row pagination** (25/50/100/200/all, remembered per device) keeps large tables — full LLM
  transcripts in text cells — from stalling the desktop webview.
- Row detail panel: **Markdown** rendering in text/title cells, and a full-screen expand toggle.

### Plugins — GitHub & GitLab deployments
- A new **plugin system** (`Settings → Manage plugins`), off by default so nothing reaches the
  network until you opt in. Plugin settings (including forge tokens) live in the device-local
  `settings.json` (mode 0600), never synced.
- The first plugin surfaces **deployments waiting for approval** across watched GitHub repos and
  GitLab projects in the sidebar, with a live count badge: approve a GitHub environment gate,
  play a GitLab manual job, or approve a GitLab deployment — right from the panel. In-progress
  and recently-failed deployments show too. Auth resolves from a PAT, an env var, or the
  `gh`/`glab` CLI (with an in-app login helper).

### Pages: sharing & folder blocks
- **Share a page** subtree (sub-pages + attached databases, their rows and relations) to a
  portable `*.trame.json` bundle, and **import** it on another Trame instance — every id is
  remapped, and relations whose target didn't travel are dropped cleanly.
- A **folder block** embeds a live directory listing in a page (list / gallery), opens a file
  in the OS, or jumps to Explore — all gated to the configured report roots.

### Session drawer
- Leads with a **"Next step" resume banner** (read-only until clicked, auto-growing).
- **Multiple PR/MR links** as chips, each with a live open / draft / merged / closed badge
  (GitHub via the authed `gh` CLI; other hosts show "unknown").
- **Full-screen expand** toggle, and resume placement modes: new window, new tab, or into an
  already-focused terminal.
- The story filter now **persists across refresh** (via a `?story=` URL param).

## Fixes (this release)
- **Resume hardening**: the stored session id is validated as a UUID before it reaches the
  shell, so a poisoned/synced `claude_id` can't inject a command.
- **Database row panel**: a row added (or edited out of view) while a filter is active still
  opens in the detail panel — it now resolves against the full row set, not the filtered one.
- **Project/page "done" count**: sessions in any *terminal* column count as done and sort to
  the bottom, instead of only the built-in `done`.

## Tests
- New Playwright e2e specs: editable statuses, quick-find/palette, inline comments, database
  views (sort/filter, hub-synced view tabs, summary views, pagination + the row-panel
  regression), and the deployments plugin (gating, enable/disable, panel, approve — against a
  fixture backend); Codex import/resume covered in `import.spec`.
- New Deno unit tests (`just test`) for the page-share export→import round-trip, relation-drop,
  and bundle validation, running against an isolated PGlite.

## Upgrading
No manual migration: `db/schema.sql` adds the `statuses` and `page_comments` tables and the
`sessions.claude_id` / `sessions.agent` columns idempotently on first launch, and both ride the
existing LWW sync. The deployments plugin is stateless (device-local settings, no schema) and
stays off until you enable it in `Settings → Manage plugins`.
