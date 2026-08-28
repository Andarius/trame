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
2. Map the client from the path: if it contains one of the names in the
   `TRACKER_CLIENTS` env var (as `/<Client>/`), use that name; otherwise `Side-projects`.
3. Infer these fields from the current conversation without asking:
   - `title`: `<repo-basename> — <short topic>`.
   - `next_step`: one imperative line for the next resume; incorporate the user's note.
   - `specs`: only when the user asked to set/update the session's spec — the full
     markdown spec shown on the ticket; omitting the key never clears it.
     A `## Title {{fold}}` heading renders as a collapsible section on the ticket.
     Consecutive `## Title {{tab}}` headings render as a tab strip. No raw HTML or
     entities (`&middot;` renders literally) — write Unicode characters directly.
     A session opened from a TODO or plan item (planned work, not a log of work just
     done) always gets `specs` — goal, what exists, what's missing and where, done-when —
     plus `links` (below) back to the plan page and the TODO page.
   - `links`: array of `{page_id, block_id?, anchor?}` — backlink chips shown above the
     specs (deduped by page+block); set them for planned-work cards.
   - `objective`: the larger goal, omitted only when genuinely unclear.
   - `summary`: worklog entry, one to three lines, PR-description style — lead with the
     outcome (what the session delivered or established), not how. Include decisions made
     and dead-ends worth remembering ("X fails because Y"); no implementation narration.
   - `pr_url`: only when evident.
4. Pipe one JSON object containing `title`, `status`, `client`,
   `objective`, `repo_path`, `branch`, `next_step`, `specs` (only when updating it), `links`
   (only when adding backlinks), `pr_url`, and `summary` to:

   ```bash
   deno run -A __TRACK_WRITER__
   ```

5. Report whether the writer tracked or queued the session, plus its title,
   status, and next step.
