---
name: trame
description: Entry point for Trame (the local session tracker) — routes /trame <anything> to the right trame-* skill (track, page, watch, plan review/done), else queries the board, sessions, worklogs, pages and user databases directly. Use for any Trame request or pasted Trame link.
---

# Trame

## Routing

`/trame <args>` is the generic entry point. Pick the first match, invoke that skill with the
same args, and let it drive — don't redo its work here (if it isn't installed, `tramecli <cmd> --help` covers it):

| The ask / args | Skill |
|---|---|
| a bare card link (`?card=` / `?session=`) or card id | `trame-track` to adopt it, name the agent session after the card (a rename tool if your client has one, else end your first reply with `/rename <short-card-slug>` for the user), then **start working**: read its spec and next step (`tramecli show <id>`) and do the first open item, no confirmation. Each todo you start: re-track with `links: [{"page_id": <specs_page_id>, "anchor": "<todo text>"}]` so the todo shows you live; tick it on the spec page (`tramecli page`) once its change is pushed with a PR open (ops steps: once applied), adding any leftover as a new todo. A code todo that builds on this card's still-open PR in the same repo goes on a stacked PR (`gh stack`, one layer per todo; `gh-stack` skill); independent todos branch off the default branch; ops todos need no PR |
| track / log / pause / block / done / next step / list open sessions | `trame-track` |
| watch / follow / answer comments on a page | `trame-watch` |
| address the feedback on the current plan | `trame-plan-review` (if installed) |
| mark the current plan done | `trame-plan-done` (if installed) |
| a page link (`?page=` only), or create / publish / update / comment on a page, note, plan, write-up | `trame-page` |
| any other task or external link (Sentry issue, ticket, error, request) | do the work, track it with `trame-track` (full URLs in `summary` and specs render as chips), and write the spec page: goal, cause, what was ruled out, open todos. If the project files to Cockpit (`GET /api/plugins/cockpit/settings` → `projects[].tagLabel`), give the story a brief and its `cockpit:<product>` tag; ask which product if unclear |
| anything else (board questions, cross-referencing, user databases, reports) | stay here — data access below |

No args: show the open sessions (Recipes) and stop.

# Trame data access

Trame is a local-first session tracker. Everything is a local HTTP API — no auth, JSON in/out.

## Finding the API

```bash
PORT=$(jq -r .port ~/.local/share/trame/port.json)   # usually 8787
curl -s http://127.0.0.1:$PORT/api/status
```

If the port file is missing or the request fails, the app isn't running: reads are
impossible, and writes should go through the outbox writer instead (see Writes).

## Read endpoints

| Endpoint | Returns |
|---|---|
| `GET /api/status` | `{nodeId, remote, lastSync, version, dataDir, desktop}` |
| `GET /api/board` | everything at once: `{projects, stories, sessions, pages, statuses}` |
| `GET /api/sessions/<id>` | one card resolved: project/story **by name**, branch, PR, next_step, `specs_page_id` + read-only `specs` markdown (rendered from the spec page), `links`, `activity` (worklog, newest first; `?events=N`) |
| `POST /api/sessions/<id>/specs-page` | find-or-create the card's spec page (a subpage of its story) → `{page_id}`; write specs by updating that page |
| `GET /api/sessions/<id>/events` | worklog `[{at, kind, summary}]` (kind: log, import, …) |
| `GET /api/pages` | page tree (flat list; `parent_id`, `kind: project\|story\|page`) |
| `GET /api/pages/<id>` | one page with content blocks and its sessions |
| `GET /api/udb` | user databases `[{id, name, icon, row_count}]` |
| `GET /api/udb/<id>` | `{db, properties, rows}` — `rows[].vals` keyed by property id, `derived` holds formula/rollup values |
| `GET /api/reports` | published exploration reports |
| `GET /api/import/claude?days=7` | Claude Code transcripts grouped by repo (preview only, writes nothing) |

A Trame URL the user pastes carries the ids in its query string: `?card=<id>` (legacy
`?session=<id>`) is the card, `?page=<id>` a page. `story=`, `view=`, `q=`, `full=` are UI
state (filters/layout) — ignore them. Read the card
with `GET /api/sessions/<session id>` — that one call is what the drawer shows.

Session fields worth knowing: `status` (active|paused|blocked|done), `next_step` (for a
blocked session this states the blocker), `client_id`/`page_id` (join against
`board.projects` / `board.stories` — `page_id` can point at any page in the tree),
`repo_path`, `branch` (latest) and `branches` (every branch the card shipped, newline-separated;
`pr_url` holds its PRs the same way), `last_touched`.

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
to the offline outbox when the app is closed: `tramecli track` (see `tramecli track --help`,
or route to `trame-track`).

Raw endpoints exist (`POST /api/sessions` upserts the open card of the agent session + story, else
repo + any of its branches,
`POST /api/sessions/<id>/status`, `POST /api/sessions/<id>/events` for a worklog line)
but only work while the app runs. Never POST `/api/sessions` with an explicit `id`
unless intentionally bypassing the card matcher (that's the Claude-import path).
