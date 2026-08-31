---
description: Watch a Trame page from this session — answer feedback live as it arrives
allowed-tools: Bash, Read, Write, Glob, Grep
argument-hint: [page-id-or-title | stop]
---

Watch a Trame page from THIS session: show a presence badge, wake when the user leaves
block comments, reply from full session context, and revise the page in place.

$ARGUMENTS

## Instructions

1. If the argument is `stop`: TaskStop the running page-watch background task and tell
   the user the badge disappears within ~20s. Done.
2. Resolve the page id:
   - Argument is a UUID → use it directly.
   - Argument is text → match a title (case-insensitive) via
     `curl -s http://127.0.0.1:$PORT/api/pages` (`PORT=$(jq -r .port ~/.local/share/trame/port.json)`).
   - No argument → `page_id` from `.plan-trame.json` at the project root. If none of
     these resolve, tell the user and stop.
3. Preflight: `curl -s "http://127.0.0.1:$PORT/api/presence?page=<id>"` — if a watcher
   entry with id exactly `watcher:claude` (global, `page_id: "*"`) exists, warn the
   user that a standalone claude watcher is running and may double-answer; offer to
   continue anyway.
4. Start the poller as a background Bash task (`run_in_background: true`):

   ```bash
   __TRAMECLI__ watch --page <id>
   ```

   It heartbeats the scoped presence badge and exits 0 when feedback is ready (after a
   45s quiet period). Tell the user you're watching and continue other work normally.
5. When the task-completion notification arrives (the poller exited — its stdout lists
   the pending items):
   1. Fetch `curl -s "http://127.0.0.1:$PORT/api/comments/inbox?page=<id>&mode=all"`
      and keep items with `"agent": "claude"` (leave codex/other threads alone).
   2. Immediately mark each `seen` then `answering`:
      `curl -s -X POST http://127.0.0.1:$PORT/api/comments/<comment_id>/agent-status -H 'content-type: application/json' -d '{"status":"answering","agent":"claude"}'`
   3. Reply FIRST on each thread from session context (see the `trame-page` skill;
      prefer `trame_add_comment`, else `POST /api/comments` with `page_id`, `block_id`,
      `anchor` = the block text, `body`, `agent: "claude"`, and
      `meta: {"model": "<the real model id running this session>"}`). Keep replies
      short and concrete — they render in a small comment box.
   4. **Comments are the default — and the only — response.** Touch the page content
      ONLY when a comment explicitly asks for a content change, and then only revise
      the discussed section in place per `/trame:plan-review` semantics — unchanged
      blocks byte-identical (that keeps comments anchored), `trame_update_page` or
      `echo '{"page_id":"<id>","markdown_file":"<tmp>"}' | __TRAMECLI__ page`.
      If this is the plan page, bump `revision` in `.plan-trame.json`.
      Never delete or resolve anything — pages, blocks, comments, threads — and never
      touch other pages, unless a human comment explicitly asks for that exact action.
      When unsure whether a comment wants a change or just an answer, answer in the
      thread and ask.
   5. Mark each handled comment `answered` (same agent-status endpoint), summarize for
      the user what was answered/changed, then RESTART the poller (step 4) and keep
      watching.
6. Watching ends only on `/trame:watch stop`, or implicitly when the session ends (the
   poller dies with it and the badge expires).
