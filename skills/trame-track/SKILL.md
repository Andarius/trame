---
name: trame-track
description: Log, update, pause, block, complete, or list coding-agent work sessions in Trame. Use when the user invokes $trame-track, asks to track the current Claude Code or Codex session, save a next step, update its Trame status, or list open Trame sessions.
---

# Track in Trame

If the user asks for a page, document, note, plan, or write-up rather than a
session card, use `$trame-page` instead.

Use the shared writer at
`__TRACK_WRITER__`. It posts to the running
Trame app or queues locally when the app is closed. In Codex, the writer reads
`CODEX_THREAD_ID` automatically so the card can resume this exact session.

Interpret an optional first argument as the action:

- Empty or `log`: status `active`.
- `paused`, `blocked`, or `done`: use that status; treat the remaining text as a note.
- `list`: read the port from `~/.local/share/trame/port.json`, GET
  `/api/board`, and print open sessions grouped by story. Do not write.

For tracking actions:

1. Read the current working directory and Git branch.
2. Compose the writer fields below from the current conversation without asking.
3. Pipe them as one JSON object to:

   ```bash
   deno run -A __TRACK_WRITER__
   ```

4. Report whether the writer tracked or queued the session, plus its title,
   status, and next step.

## Writer fields

__TRACK_FIELDS__
