---
allowed-tools: Bash(pwd), Bash(git branch:*), Bash(git remote:*), Bash(git rev-parse:*), Bash(deno run:*), Bash(curl:*), Bash(cat:*)
description: Log or update the current Claude Code session in Trame (the local session tracker)
---

## Context

- Working dir: !`pwd`
- Git branch: !`git branch --show-current 2>/dev/null || echo ""`
- Git remote: !`git remote get-url origin 2>/dev/null || echo ""`
- Trame instance: !`cat ~/.local/share/session-tracker/port.json 2>/dev/null || echo "(app not running — writes will queue to the outbox)"`
- Known clients: !`echo "${TRACKER_CLIENTS:-}"`
- Argument: `$ARGUMENTS`

## What this does

Records the current session as a card in **Trame** (`~/Projects/session-tracker`). The writer
POSTs to the running app (upserts by repo+branch among open sessions, resolves client/objective by
name, logs the summary as a worklog event); if the app is closed it queues to the offline outbox.
The writer also attaches the Claude session UUID (recorded per-cwd by the UserPromptSubmit hook
`track/claude-hook.ts`) so the card gets a working Resume button.

## Argument grammar

`$ARGUMENTS` optional. First word = action; rest = free-text note.
- *(empty)* / `log` → status **active**
- `paused` / `blocked` / `done` `[note]` → set that status
- `list` → **read-only**: show open sessions across all projects

## Client mapping (from working dir)

If the working-dir path contains one of the **Known clients** listed above (as `/<Client>/`),
use that name as the client; otherwise **Side-projects**. (Configure the list via the
`TRACKER_CLIENTS` env var, e.g. `TRACKER_CLIENTS="Acme,Globex"`.)

## Steps for `list`

1. Read the port from `~/.local/share/session-tracker/port.json`, then `curl -s http://127.0.0.1:<port>/api/board`.
2. Print open (non-done) sessions as a compact table — **Title · Status · Client · Objective · Next step** — grouped by objective. Do not write anything.

## Steps for tracking (all other actions)

1. Resolve **status** from the action word (default `active`).
2. Resolve **client** from the working dir mapping.
3. From THIS conversation, compose (do not ask the user):
   - `title` — `<repo-basename> — <short topic>`
   - `next_step` — one imperative line (the very next thing to do on resume); fold in any note from `$ARGUMENTS`
   - `objective` — the bigger goal this session serves (found-or-created by name server-side); omit if genuinely unclear
   - `summary` — worklog entry, 1–3 lines, PR-description style: lead with the outcome
     (what this session delivered or established), not how. Do include decisions made and
     dead-ends worth remembering ("X fails because Y") — the diff can't show them and
     resume needs them. No implementation narration; name a file only if resuming starts there.
   - `pr_url` — only if evident
4. Build one JSON object with keys:
   `title, status, client, objective, repo_path (=working dir), branch, next_step, pr_url, summary`
5. Pipe it to the writer:
   ```bash
   echo '<json>' | deno run -A __TRACK_WRITER__
   ```
6. Report one line from the writer output: tracked/queued, title, status, and the `next_step` you wrote.
