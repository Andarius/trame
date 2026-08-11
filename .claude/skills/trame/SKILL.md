---
name: trame
description: Query Trame (the local session tracker) — board, sessions, worklogs, projects/pages, user databases. Use when you need to read or cross-reference tracked work sessions, their status/blockers, or Trame's data.
---

# Trame data access

Trame is a local-first session tracker. Everything is a local HTTP API — no auth, JSON in/out.

## Finding the API

```bash
PORT=$(jq -r .port ~/.local/share/session-tracker/port.json)   # usually 8787
curl -s http://127.0.0.1:$PORT/api/status
```

If the port file is missing or the request fails, the app isn't running: reads are
impossible, and writes should go through the outbox writer instead (see Writes).

## Read endpoints

| Endpoint | Returns |
|---|---|
| `GET /api/status` | `{nodeId, remote, lastSync, version, dataDir, desktop}` |
| `GET /api/board` | everything at once: `{projects, stories, sessions, pages, statuses}` |
| `GET /api/sessions/<id>/events` | worklog `[{at, kind, summary}]` (kind: log, import, …) |
| `GET /api/pages` | page tree (flat list; `parent_id`, `kind: project\|story\|page`) |
| `GET /api/pages/<id>` | one page with content blocks and its sessions |
| `GET /api/udb` | user databases `[{id, name, icon, row_count}]` |
| `GET /api/udb/<id>` | `{db, properties, rows}` — `rows[].vals` keyed by property id, `derived` holds formula/rollup values |
| `GET /api/reports` | published exploration reports |
| `GET /api/import/claude?days=7` | Claude Code transcripts grouped by repo (preview only, writes nothing) |

Session fields worth knowing: `status` (active|paused|blocked|done), `next_step` (for a
blocked session this states the blocker), `client_id`/`page_id` (join against
`board.projects` / `board.stories` — `page_id` can point at any page in the tree),
`repo_path`, `branch`, `last_touched`.

## Recipes

Open sessions with their project, grouped:

```bash
curl -s http://127.0.0.1:$PORT/api/board | jq -r '
  (.stories | map({key: .id, value: .title}) | from_entries) as $proj
  | .sessions[] | select(.status != "done")
  | "\(.status)\t\($proj[.page_id] // "—")\t\(.title)\t→ \(.next_step // "")"' | sort
```

What is blocked and why:

```bash
curl -s http://127.0.0.1:$PORT/api/board \
  | jq -r '.sessions[] | select(.status == "blocked") | "\(.title): \(.next_step)"'
```

Find a session by title, then read its worklog:

```bash
ID=$(curl -s http://127.0.0.1:$PORT/api/board | jq -r '.sessions[] | select(.title | test("ftp"; "i")) | .id')
curl -s http://127.0.0.1:$PORT/api/sessions/$ID/events
```

## Writes

Prefer the tracking writer over raw POSTs — it composes the payload correctly and queues
to the offline outbox when the app is closed (`<repo>` = your trame checkout):

```bash
echo '{"title": "...", "status": "active", ...}' | deno run -A <repo>/track/track.ts
```

Raw endpoints exist (`POST /api/sessions` upserts by repo+branch among open sessions,
`POST /api/sessions/<id>/status`, `POST /api/sessions/<id>/events` for a worklog line)
but only work while the app runs. Never POST `/api/sessions` with an explicit `id`
unless intentionally bypassing the repo+branch matcher (that's the Claude-import path).
