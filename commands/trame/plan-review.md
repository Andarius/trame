---
description: Review Trame plan feedback and update the plan page in place
allowed-tools: Bash, Read, Write, Glob, Grep
---

Process the user's block comments on the current Trame plan and update the plan page in place.

## Instructions

1. Read `.plan-trame.json` at the project root for `page_id`, `title`, and `revision` (ignore a legacy `root_page_id`). If missing, tell the user there is no active Trame plan (`/trame:plan-export` creates one).
2. Fetch the page and its comments:

   ```bash
   PORT=$(jq -r .port ~/.local/share/trame/port.json)
   curl -s http://127.0.0.1:$PORT/api/pages/<page_id> | jq '{content, comments}'
   ```

   Group comments into threads by `block_id`. Agent comments have `author_id` `"00000000-0000-4000-8000-0000000000aa"`; all others are the user's. Feedback = threads whose LATEST comment is user-authored.
3. If there is no feedback, tell the user the plan is fully approved and stop.
4. Revise the plan markdown, addressing every feedback thread — revise sections, answer questions, rethink approaches as requested. Keep uncommented sections **byte-identical**: unchanged block text is what keeps comments attached after the update.
5. Reply FIRST: post a short agent comment on each addressed thread's existing `block_id` (see the `trame-page` skill; `agent` = the real model, e.g. `claude`). Replies must land before the update — updating first can remove the target block.
6. THEN update the plan page in place (see the `trame-page` skill, "Update a page"). Prefer `trame_update_page`; otherwise:

   ```bash
   echo '{"page_id":"<page_id>","markdown_file":"<tmpfile>"}' | deno run -A __PAGE_WRITER__
   ```

   Same page, same title — do NOT create a new page or pass `parent_id`.
7. Update `.plan-trame.json`: bump `revision`, keep `page_id` and `title`, drop `root_page_id` if present.
8. Summarize for the user: sections approved as-is, sections revised and how, new sections added. Note that comments on rewritten blocks now show as detached snapshots. Tell them:
   - Review the updated plan page in Trame (same URL)
   - Comment again and run `/trame:plan-review` for another round
   - Or say "looks good" to start implementation
