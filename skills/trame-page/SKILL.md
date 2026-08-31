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
2. Every page is nested. With no parent given, it files itself under the project that
   owns the current working directory (the session on that repo path, else a project
   named in it, else Side-projects) — so do not pass a parent unless the user named
   one, or a specific page is the right home (`trame_board` lists projects and pages;
   the page writer also accepts `parent_title`). Only a genuinely cross-project
   document takes an explicit `parent_id: null`, which puts it in the Unfiled inbox.
3. Prefer the `trame_create_page` MCP tool when available. Pass `title`, the complete
   `markdown`, `repo_path` (your working directory, so it files itself), and optional
   `parent_id` or `icon`.
4. Otherwise pipe one JSON object to `tramecli page`:

   ```json
   {"title":"Release plan","markdown":"# Release plan\n\nComplete document body"}
   ```

   ```bash
   echo '<json>' | tramecli page
   ```

   Pass `markdown_file` instead of `markdown` when the content is already in a local
   file. Pass `parent_title` to nest under an exact, unique title.
5. Report the created page title, its parent project (the writer prints where it was
   filed), and the ID or URL.

## Markdown dialect

Trame renders GFM plus page extensions — `{{tab}}`/`{{fold}}` section headings,
checkable todos, status lists, `{{color:pills}}`, mermaid diagrams, highlighted code
fences, live PR chips, interactive tables, `{{trame:folder=…}}` directory listings;
no raw HTML or entities. Run `tramecli page --help` for the full dialect before
composing, and use the extensions instead of flattening structure into plain prose.

## Todo lines

Todos carry their dates inline as `{{trame:created_at=…}}`, `{{trame:completed_at=…}}`
and `{{trame:updated_at=…}}` marks at the end of the line:

```markdown
- [ ] Rotate the reader keys {{trame:created_at=2026-08-20}} {{trame:updated_at=2026-08-25,2026-08-30}}
- [x] Ship the writers {{trame:created_at=2026-08-19}} {{trame:completed_at=2026-08-28}}
```

`updated_at` is a comma-separated day list, deduped and capped at the 5 most recent.

Write a mark when you know the real date; otherwise omit it and Trame stamps what is
missing. A mark you wrote is never overwritten, and marks you leave out of a rewrite
are carried over from the stored page — so an update need not repeat dates it did not
change. `tramecli page --help` has the full rules.

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
4. Otherwise pipe one JSON object to `tramecli page`:

   ```json
   {"page_id":"0199…","markdown_file":"/path/to/revised.md"}
   ```

   `markdown` works instead of `markdown_file`; structural blocks (embedded HTML,
   databases, subpages) are preserved automatically.

   A session's SPECS are a page too: pass `session_id` (instead of
   `page_id`/`page_title`) and the writer finds or creates the card's spec page — a
   subpage of its story — then updates it the same way. The MCP equivalent is
   `trame_update_page` with `session_id`.
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
   `meta` (see step 5; the tool rejects calls without `meta.model`, and without
   `in`/`out`/`ms` when the agent is `claude` or `codex`).
4. Otherwise pipe one JSON object to `tramecli comment`:

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
   echo '<json>' | tramecli comment
   ```

5. Always pass `meta.model` — the exact model id you run as (`claude-opus-5`,
   `gpt-5.6-sol`, …); it renders as a footer. Running as `claude` or `codex`, `in`, `out`
   and `ms` (input/output tokens, milliseconds) are required too — both harnesses report
   their own usage, so read it there. Any other agent may omit stats it cannot measure;
   never guess a number. A visible footer must mean real data.
6. Do not pass `author` or `author_avatar`. Trame injects the agent name and a
   self-contained avatar from `agent`. Repeat the call for additional target blocks, then report the
   comment IDs and page URL.

Do not search the Trame source tree or reconstruct its HTTP routes. The writers own
page/block resolution and attribution. If the app is not running, report that it must
be started; these operations are deliberately not queued.
