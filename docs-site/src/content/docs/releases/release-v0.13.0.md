---
title: "v0.13.0 — one agent CLI, specs as pages, dated todos"
sidebar:
  label: "v0.13.0"
---

Agents now talk to Trame through a single compiled binary instead of a checkout,
session specs become real pages with comments, and todos carry their own dates.
Three long-standing compatibility paths are gone — read **Upgrading** before
installing.

## tramecli — one binary for every agent

- **`tramecli`** wraps the track, page, comment and watch writers and adds
  `list`. Its `--help` is the single source of truth for the field conventions,
  which the MCP server imports for its own capabilities text.
- **`tramecli setup`** installs the agent commands and skills from docs embedded
  in the binary — no checkout, no `deno`. It links the binary into
  `~/.local/bin` on every run and warns when another `tramecli` shadows it on
  PATH, so freshly installed docs can never sit in front of stale code.
- **`tramecli --version` reports the build**, `0.13.0+<sha>`, not just the
  release — a stale copy is now visible instead of silent.
- **`/trame:watch` is installable** and curl-free: `tramecli watch` takes a page
  id or title, does its own page lookup, presence preflight and comment
  status calls, and `tramecli comment` accepts `in_reply_to` so a thread is
  marked answering then answered around the reply.
- **The MCP page and comment tools delegate to the same writers**, so both
  surfaces share one implementation of markdown conversion, block merge and
  attribution.
- `--json` on `track` and `list` prints machine-readable output for `jq`.

## Session specs are pages

- A session's spec is a **real page** — a subpage of the card's story, with the
  full block editor and inline comments — created lazily and embedded in the
  card drawer. A deterministic page id keeps independent nodes convergent.
- **`trame_session`** reads one card the way a human sees it: project and story
  by name, branch, PR, next step, specs, backlinks and the worklog, from a
  session id or a pasted Trame URL.
- Cards accept **`links`**, backlink chips to plan and TODO pages, deduped by
  page and block.

## Todos carry their own dates

- Todo lines take `{{trame:created_at=…}}`, `{{trame:completed_at=…}}` and
  `{{trame:updated_at=day,day,…}}` marks, rendered as quiet chips. There is no
  new block field and no schema change — the text is the store.
- The app **fills gaps only**: a date an agent or a human wrote is never
  overwritten. The editor stamps `created_at`, keeps `completed_at` in step with
  the checkbox, and appends to `updated_at` on an edit or when a checked todo is
  re-opened. `updated_at` dedupes by day and keeps the five most recent.
- A full-page rewrite that omits the marks keeps them, and keeps its comment
  anchors — merges pair blocks on the visible line.

## Pages and the editor

- **Selection toolbar** — selecting text in a block offers bold, italic,
  strikethrough, code, link and comment, with `Ctrl+B/I/E/K` and
  `Ctrl+Shift+S`. Selecting rendered Markdown offers a comment anchored to the
  exact fragment, quoted above the thread.
- **Enter splits a list item** at the caret and opens the new item; Enter on an
  empty item leaves the list.
- **Drag pages onto projects** in the sidebar to re-file them, and drag stories
  between projects.
- **Story status** drives the sidebar, the pickers and the board lanes.
- **Project logos**, icons in breadcrumbs and project selects, a Created ·
  Updated header, and a Markdown button that shows any page as copyable text.
- **Commented table rows stay visible** — copper tint, a pinned 💬 count, and
  threads quoted as `on row: …`.
- Agent-created pages are filed under the repo's own project instead of
  Unfiled.

## Watchers

- **Page-scoped comment watchers** start from the ghosted agent avatars in the
  page header. Presence registers per page, the inbox filters by page, and a
  comment is badged *seen* the moment a watcher picks it up rather than staying
  silent until the reply lands.

## Hub

- **Duplicate projects merge on push.** A node that had not pulled yet could
  re-create a project by title; the hub now merges same-title projects at the
  sync choke point, repointing references and tombstoning the loser.

## Upgrading

- **Run a recent release first.** The one-time migrations are gone: the dead
  `sessions.specs` column, the identity and agent backfills, the
  objectives/clients teardown, the specs-page backfill and the PG16 → PG18 data
  directory migration. A data directory or hub database that has not been opened
  by a recent build **cannot migrate itself** — open it with v0.12.0 before
  installing this one.
- **Sync is the hub API only.** The direct-Postgres transport, its client
  certificates and the `remotePg` / `syncViaApi` settings are gone. Set the hub
  URL and a device token (Settings, or `TRACKER_HUB_API` /
  `TRACKER_HUB_API_TOKEN`). `just hub-ca` fetches the CA; client certs are no
  longer issued.
- **Protocol 4** — `specs` has left the sessions wire, replaced by
  `specs_page_id`. Write specs through the page writer or `trame_update_page`
  with `{session_id}`.
- **Agent comments must carry `meta.model`**, and `in` / `out` / `ms` as well
  for claude and codex, whose harnesses report their own usage. This is now
  enforced for `tramecli comment`, not just the MCP tool.
- **`tramecli watch` requires `--page`.** The `.plan-trame.json` fallback is
  gone along with the `plan-*` commands that wrote the file.
