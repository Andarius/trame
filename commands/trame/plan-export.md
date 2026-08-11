---
description: Export a plan to a Trame page for block-level feedback
allowed-tools: Bash, Read, Write, Glob, Grep
argument-hint: [task description or empty to use conversation context]
---

Generate a structured implementation plan for the following task:

$ARGUMENTS

If no arguments are provided, use the current conversation context to determine what needs to be planned.

## Instructions

1. Explore the codebase as needed to understand the current architecture and relevant files.
2. Design an implementation plan broken into logical sections (3-8 sections), each starting with a numbered `## <n>. <Section name>` heading.
3. Create a Trame page (see the `trame-page` skill). Prefer the `trame_create_page` MCP tool; otherwise pipe JSON to the writer:

   ```bash
   echo '{"title":"Plan: <short title>","markdown_file":"<tmpfile>","icon":"📋"}' | deno run -A __PAGE_WRITER__
   ```

   No feedback placeholders — feedback arrives as Trame block comments.
4. Save the page reference to `.plan-trame.json` at the project root:

   ```json
   {"page_id": "<id>", "title": "Plan: <short title>", "revision": 1}
   ```

## Plan style

- Include **tables** for file inventories, property comparisons, and change summaries
- Include **Mermaid diagrams** where they clarify architecture, data flow, or sequencing
- Keep sections focused and actionable — mention specific files and functions
- No frontmatter, no versioning inside the body

5. After creating the page, tell the user:
   - Open the page in Trame (give the URL from the writer output)
   - Comment directly on any block you want revised — sections without comments count as approved
   - Run `/trame:plan-review` when done
