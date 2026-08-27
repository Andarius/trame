---
name: trame-page
description: Create standalone or nested Trame pages from Markdown, update pages in place (unchanged blocks keep their comment anchors), and add inline agent review comments (attributed to the real model — codex, claude, or any other) to page blocks. Use when the user asks to create, save, publish, or revise a Trame page, document, note, plan, or write-up, or asks an agent to review, annotate, or comment on an existing Trame page.
---

# Work with Trame pages

Never use session-card fields as a substitute for a requested document or page review.

## Create a page

1. Preserve the complete requested content. Infer a concise title only when the user
   did not provide one.
   - Exception for task/status write-ups (session tasks, retros, progress reports):
     order sections actionable-first — `## Open` (or Next/Pending/Todo) before
     `## Completed`/Done. Reorder the sections if the draft has Completed first;
     Trame renders Open lists as a highlighted callout at the top.
   - Trame renders GFM plus the page extensions below — use them instead of
     flattening structure into plain prose.
2. Nest the page under the relevant project by default: use the parent the user named,
   else the project of the current session/repo (`trame_board` lists projects; the
   page writer accepts `parent_title`). Create a root page only for genuinely
   cross-project documents — parentless pages land in the Unfiled inbox for manual
   triage.
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

## Markdown dialect

- **Section markers** — `## Title {{tab}}` groups the blocks below it into a tab;
  consecutive `{{tab}}` headings form one strip. `## Title {{fold}}` is a standalone
  collapsible section, collapsed by default. A fold ends a tab group and vice versa
  (same dialect as the session-ticket spec).
- **Todos** — `- [ ]` / `- [x]` become native checkable todo blocks; two leading spaces
  per nesting level (max 4).
- **Status lists** — plain bullets take their style from the nearest heading above:
  `Completed`/`Done`/`Shipped` renders green checks, `Open`/`Todo`/`Next`/`Pending`/
  `Remaining`/`In progress`/`Blocked` renders copper rings, each with a one-click
  toggle that moves the item to the other list.
- **Pills** — `{{text}}` is a neutral chip, `{{green:text}}` tints it
  (green|yellow|red|copper|gray) — useful for status or category tags in table cells.
- **Diagrams** — a fenced block tagged `mermaid` renders as a diagram.
- **Code** — fences are syntax-highlighted for python/ts/js/bash/json/sql; the language
  label shows on the card.
- **Links** — a GitHub/GitLab PR or MR URL renders as a live PR chip (title + state),
  `#123` as an issue ref, `![alt](url)` as an inline image.
- **Tables** — GFM tables render as interactive cards (select/move/delete rows,
  comment on a row).

A leading `# Title` identical to the page title is dropped rather than rendered twice.

## Update a page

Use only for revising a page this agent (or its workflow) authored — e.g. publishing
a new revision of a plan after feedback. When reviewing someone else's page, comment
instead (next section).

1. Pass the **full new content** as Markdown (not a diff). Blocks whose text is
   unchanged keep their ids, so inline comments stay attached; comments on blocks you
   changed detach to their quoted snapshot. Keep untouched sections byte-identical.
2. **Reply to the comments you are addressing BEFORE updating** — a reply targets a
   block that the update may remove.
3. Prefer the `trame_update_page` MCP tool when available: `page_id` or exact
   `page_title`, plus `markdown`. Pass `title` only to rename the page.
4. Otherwise pipe one JSON object to `__PAGE_WRITER__`:

   ```json
   {"page_id":"0199…","markdown_file":"/path/to/revised.md"}
   ```

   `markdown` works instead of `markdown_file`; structural blocks (embedded HTML,
   databases, subpages) are preserved automatically.
5. Report the page URL and how many block ids were kept (the writer prints it).

## Add page comments

1. Keep feedback as separate comments rather than editing the page: comment on pages
   you are reviewing, update only pages you authored. Add one comment per target block.
2. Identify the page by `page_id` or exact `page_title`. Identify the target block by
   `block_id` or a unique `block_text` quote from the page. Prefer a concise exact quote.
3. Prefer the `trame_add_comment` MCP tool when available. Pass the page reference,
   block reference, comment `body`, `agent` set to the id of the model actually
   writing — attribute the real model, not the harness seat (`codex` and `claude` get a
   branded avatar; any other id, e.g. `glm`, `gemini`, gets a generated one) — and
   `meta` (see step 5; the tool rejects calls without `meta.model`).
4. Otherwise pipe one JSON object to `__COMMENT_WRITER__`:

   ```json
   {
     "page_title": "Release plan",
     "block_text": "Ship the first release",
     "body": "Clarify the rollback criterion.",
     "agent": "codex",
     "meta": {"model": "gpt-5.6-sol", "in": 12894, "out": 512, "ms": 8300}
   }
   ```

   ```bash
   deno run -A __COMMENT_WRITER__
   ```

5. Always pass `meta.model` — the exact model id you run as (`claude-opus-5`,
   `gpt-5.6-sol`, …); it renders as a footer. `in`, `out` and `ms` (input/output tokens,
   milliseconds) are optional: include only numbers you actually know and omit any you
   can't measure rather than guessing. A visible footer must mean real data.
6. Do not pass `author` or `author_avatar`. Trame injects the agent name and a
   self-contained avatar from `agent`. Repeat the call for additional target blocks, then report the
   comment IDs and page URL.

Do not search the Trame source tree or reconstruct its HTTP routes. The writers own
page/block resolution and attribution. If the app is not running, report that it must
be started; these operations are deliberately not queued.
