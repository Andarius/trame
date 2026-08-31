---
allowed-tools: Bash(pwd), Bash(git branch:*), Bash(git remote:*), Bash(tramecli:*), Bash(cat:*)
description: Log or update the current coding-agent session in Trame (the local session tracker)
---

## Context

- Working dir: !`pwd`
- Git branch: !`git branch --show-current 2>/dev/null || echo ""`
- Git remote: !`git remote get-url origin 2>/dev/null || echo ""`
- Trame instance: !`cat ~/.local/share/trame/port.json 2>/dev/null || echo "(app not running — writes will queue to the outbox)"`
- Known clients: !`echo "${TRACKER_CLIENTS:-}"`

## Steps

Track this session in **Trame** — a board of projects, stories, and session cards.

1. Run `tramecli track --help` for the writer contract and the field conventions.
2. Compose every field from THIS conversation (do not ask the user) and pipe one JSON object to `tramecli track`.
3. If a spec is evident, write the spec page with the session id from the writer output (`tramecli page`, see its `--help`).
4. Report one line from the writer output: tracked/queued, title, status, and the `next_step` you wrote.
