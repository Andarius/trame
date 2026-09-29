---
name: trame-track
description: Log, update, pause, block, complete, or list coding-agent work sessions in Trame. Use when the user invokes $trame-track, asks to track the current Claude Code or Codex session, save a next step, update its Trame status, or list open Trame sessions.
allowed-tools: Bash(tramecli:*), Bash(pwd), Bash(git branch:*), Bash(git remote:*)
---

# Track in Trame

If the user asks for a page, document, note, plan, or write-up rather than a
session card, use `$trame-page` instead.

Trame tracks work as a board of projects, stories, and session cards. The writer
is the `tramecli` binary: it posts to the running app, else to the Trame hub when
one is configured (a box with no app), else queues to an offline outbox. It reads
`CODEX_THREAD_ID` (Codex) or `CLAUDE_CODE_SESSION_ID` (Claude Code) automatically so
the card can resume this exact session. One session + story = one card: every branch
and PR you ship on that story lands on the same card, so track after each PR instead
of worrying about duplicates. A different story is the only thing that starts a new card.

Interpret an optional first argument as the action:

- Empty or `log`: status `active`.
- `paused`, `blocked`, or `done`: use that status; treat the remaining text as a note.
- `list`: run `tramecli list`. Do not write.

For tracking actions:

1. Run `tramecli track --help` for the writer contract and the field conventions.
2. Pick the story first: run `tramecli stories -q "<topic>"` and reuse the open story
   that fits; name a short new topic only when none does.
3. Read the current working directory and Git branch, compose every field from THIS
   conversation (do not ask the user), and pipe one JSON object to `tramecli track`.
   If the output has a `story:` line naming a better existing story, re-track with it.
4. Write the spec page when the writer contract (Specs, in that `--help`) says so,
   with the session id from the writer output (`tramecli page`, see its `--help`).
5. Report one line from the writer output: tracked/queued, title, status, and the
   `next_step` you wrote.
