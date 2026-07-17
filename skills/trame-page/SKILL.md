---
name: trame-page
description: Create a new standalone or nested page, document, note, plan, or write-up in Trame from Markdown. Use when the user asks to create, save, or publish content as a Trame page, especially when they want a new page instead of changing a session card.
---

# Create a Trame page

Create a normal page. Never use session-card fields as a substitute for a requested
document.

## Workflow

1. Preserve the complete requested content. Infer a concise title only when the user
   did not provide one.
2. Create a root page by default. Set `parent_id` only when the user identified the
   parent unambiguously.
3. Prefer the `trame_create_page` MCP tool when it is available. Pass `title`,
   the complete `markdown`, and optional `parent_id` or `icon`.
4. Otherwise invoke the shared writer at `__PAGE_WRITER__`. Pipe one JSON object:

   ```json
   {
     "title": "Release plan",
     "markdown": "# Release plan\n\nComplete document body",
     "parent_id": null
   }
   ```

   ```bash
   deno run -A __PAGE_WRITER__
   ```

   If the content already exists in a local file, pass `markdown_file` instead of
   `markdown`. To nest by title, pass `parent_title`; the writer rejects missing or
   ambiguous matches instead of guessing.
5. Report the created page title and ID or URL from the tool output.

Do not search the Trame source tree or reconstruct its HTTP routes. The writer owns
Markdown conversion and page creation. If the app is not running, report that it must
be started; page creation is deliberately not queued.
