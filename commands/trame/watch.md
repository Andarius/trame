---
description: Watch a Trame page from this session — answer feedback live as it arrives
allowed-tools: Bash(tramecli:*), Read, Write, Glob, Grep
argument-hint: [page-id-or-title | stop]
---

Watch a Trame page from THIS session: show a presence badge, wake when the user leaves
block comments, reply from full session context, and revise the page in place.

$ARGUMENTS

## Instructions

1. If the argument is `stop`: TaskStop the running watch background task and tell the
   user the badge disappears within ~20s. Done.
2. Start the watcher as a background Bash task (`run_in_background: true`) — pass the
   argument as `--page` when there is one (a page id or an exact title); with no
   argument it watches the plan page from `.plan-trame.json`:

   ```bash
   tramecli watch --page <id-or-title>
   ```

   It resolves the page, warns if a global watcher may double-answer, heartbeats the
   presence badge, and exits 0 when feedback is ready (after a 45s quiet period). Tell
   the user you're watching and continue other work normally.
3. When the task-completion notification arrives, its stdout holds the pending items
   (`comment_id`, `page`, `block_id`, `body`) — that is the whole inbox, no fetch needed.
   For each item:
   1. Reply FIRST from session context, passing `in_reply_to` so the thread is marked
      answering then answered:

      ```bash
      echo '{"page_id":"<page id>","block_id":"<block id>","body":"…","agent":"claude","in_reply_to":"<comment_id>","meta":{"model":"<the real model id running this session>","in":<input tokens>,"out":<output tokens>,"ms":<elapsed ms>}}' | tramecli comment
      ```

      `meta` is mandatory for claude and codex — model id plus this reply's own token
      counts and elapsed time, read from the harness, never guessed.
      Keep replies short and concrete — they render in a small comment box.
   2. **Comments are the default — and the only — response.** Touch the page content
      ONLY when a comment explicitly asks for a content change, and then only revise
      the discussed section in place — unchanged blocks byte-identical (that keeps
      comments anchored): `echo '{"page_id":"<id>","markdown_file":"<tmp>"}' | tramecli page`.
      If this is the plan page, bump `revision` in `.plan-trame.json`.
      Never delete or resolve anything — pages, blocks, comments, threads — and never
      touch other pages, unless a human comment explicitly asks for that exact action.
      When unsure whether a comment wants a change or just an answer, answer in the
      thread and ask.
4. Summarize for the user what was answered/changed, then RESTART the watcher (step 2)
   and keep watching.
5. Watching ends only on `/trame:watch stop`, or implicitly when the session ends (the
   watcher dies with it and the badge expires).
