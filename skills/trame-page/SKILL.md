---
name: trame-page
description: Create standalone or nested Trame pages from Markdown and add inline Codex or Claude review comments to page blocks. Use when the user asks to create, save, or publish a Trame page, document, note, plan, or write-up, or asks an agent to review, annotate, or comment on an existing Trame page.
---

# Work with Trame pages

Never use session-card fields as a substitute for a requested document or page review.

## Create a page

1. Preserve the complete requested content. Infer a concise title only when the user
   did not provide one.
2. Create a root page by default. Set `parent_id` only when the user identified the
   parent unambiguously.
3. Prefer the `trame_create_page` MCP tool when available. Pass `title`, the complete
   `markdown`, and optional `parent_id` or `icon`.
4. Otherwise pipe one JSON object to the shared writer at `__PAGE_WRITER__`:

   ```json
   {"title":"Release plan","markdown":"# Release plan\n\nComplete document body","parent_id":null}
   ```

   ```bash
   deno run -A __PAGE_WRITER__
   ```

   Pass `markdown_file` instead of `markdown` when the content is already in a local
   file. Pass `parent_title` to nest under an exact, unique title.
5. Report the created page title and ID or URL.

## Add page comments

1. Keep feedback as separate comments rather than editing the page. Add one comment
   per target block.
2. Identify the page by `page_id` or exact `page_title`. Identify the target block by
   `block_id` or a unique `block_text` quote from the page. Prefer a concise exact quote.
3. Prefer the `trame_add_comment` MCP tool when available. Pass the page reference,
   block reference, comment `body`, and `agent` set to the id of the model actually
   writing — attribute the real model, not the harness seat. `codex` and `claude` get a
   branded avatar; any other id (e.g. `glm`, `gemini`) gets a generated one.
4. Otherwise pipe one JSON object to `__COMMENT_WRITER__`:

   ```json
   {
     "page_title": "Release plan",
     "block_text": "Ship the first release",
     "body": "Clarify the rollback criterion.",
     "agent": "codex"
   }
   ```

   ```bash
   deno run -A __COMMENT_WRITER__
   ```

5. Optionally pass `meta` — honest generation stats `{model, in, out, ms}` (input/output
   tokens, milliseconds) shown as a footer. Only include numbers you actually know; omit
   any you can't measure rather than guessing. A visible footer must mean real data.
6. Do not pass `author` or `author_avatar`. Trame injects the agent name and a
   self-contained avatar from `agent`. Repeat the call for additional target blocks, then report the
   comment IDs and page URL.

Do not search the Trame source tree or reconstruct its HTTP routes. The writers own
page/block resolution and attribution. If the app is not running, report that it must
be started; these operations are deliberately not queued.
