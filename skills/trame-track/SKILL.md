---
name: trame-track
description: Log, update, pause, block, complete, or list coding-agent work sessions in Trame. Use when the user invokes $trame-track, asks to track the current Claude Code or Codex session, save a next step, update its Trame status, or list open Trame sessions.
---

# Track in Trame

If the user asks for a page, document, note, plan, or write-up rather than a
session card, use `$trame-page` instead.

Trame tracks work as a board of projects, stories, and session cards. The writer
is the `tramecli` binary: it posts to the running app or queues to an offline
outbox when it is closed, and in Codex reads `CODEX_THREAD_ID` automatically so
the card can resume this exact session.

Interpret an optional first argument as the action:

- Empty or `log`: status `active`.
- `paused`, `blocked`, or `done`: use that status; treat the remaining text as a note.
- `list`: run `tramecli list`. Do not write.

For tracking actions:

1. Run `tramecli track --help` for the writer contract and the field conventions.
2. Read the current working directory and Git branch, compose every field from THIS
   conversation (do not ask the user), and pipe one JSON object to `tramecli track`.
3. If a spec is evident, write the spec page with the session id from the writer
   output (`tramecli page`, see its `--help`).
4. Report one line from the writer output: tracked/queued, title, status, and the
   `next_step` you wrote.
