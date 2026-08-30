---
allowed-tools: Bash(pwd), Bash(git branch:*), Bash(git remote:*), Bash(deno run:*), Bash(curl:*), Bash(cat:*)
description: Log or update the current coding-agent session in Trame (the local session tracker)
---

## Context

- Working dir: !`pwd`
- Git branch: !`git branch --show-current 2>/dev/null || echo ""`
- Git remote: !`git remote get-url origin 2>/dev/null || echo ""`
- Trame instance: !`cat ~/.local/share/trame/port.json 2>/dev/null || echo "(app not running — writes will queue to the outbox)"`
- Known clients: !`echo "${TRACKER_CLIENTS:-}"`

## What this does

Keeps track of the task this session is working on in **Trame** — a Jira-like board of
projects, stories, and session cards, for following progress and reviewing work. The writer
upserts by repo+branch among open sessions (queuing to the offline outbox if the app is
closed) and attaches the agent's session UUID so the card gets a working Resume button.

## Writer fields

Compose from THIS conversation (do not ask the user).

__TRACK_FIELDS__

## Steps

1. Compose the writer fields above and pipe them as one JSON object to the writer:
   ```bash
   echo '<json>' | deno run -A __TRACK_WRITER__
   ```
   ```jsonc
   {
     "title": "obi-chart — fix legend overflow",
     "status": "active",
     "client": "Obitrain",
     "objective": "Chart v2 polish",
     "repo_path": "/home/julien/Projects/Obitrain/obi-chart",
     "branch": "fix/legend-overflow",
     "next_step": "Re-run the chart e2e suite after the flex fix",
     "pr_url": "https://github.com/obitrain/obi-chart/pull/42",
     "summary": "Legend no longer overflows narrow panels; flex-wrap was a dead-end (breaks export).",
     "links": [{ "page_id": "<plan-page-id>" }]
   }
   ```
2. If a spec is evident, write the spec page (see **Specs** above) with the writer output's session id.
3. Report one line from the writer output: tracked/queued, title, status, and the `next_step` you wrote.
