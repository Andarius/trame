---
title: "v0.12.0 — session tickets, tabs and folds"
sidebar:
  label: "v0.12.0"
---

Sessions get a full-screen ticket with a Markdown spec, and both pages and
specs gain the same `{{tab}}` / `{{fold}}` section markers.

## Session tickets

- **Full-screen ticket view** — double-click a card (or follow a session link)
  to open the whole session: spec, journal, PR links, next step. The expanded
  state survives a refresh.
- **Specs** are Markdown and are exposed to agents through `trame_track`, so a
  session carries what it must deliver instead of a one-line summary.
- **`{{tab}}` and `{{fold}}` spec sections** — `## Title {{tab}}` groups the
  blocks below it into a tab strip (consecutive markers form one strip), and
  `## Title {{fold}}` makes a standalone collapsible section. Sections fold only
  on an explicit marker.
- **Agent marks on journal entries** — each entry shows which coding agent
  produced it; entries written before the column existed are backfilled as
  claude.
- **Board project chips** filter the board by project, and multiple filters
  combine.

## Session ↔ page links

- Hover a list item on any page and pick 🔗 to link it to a session. The item
  then carries a status chip that opens the session, and the ticket shows a
  **Linked** row whose quote opens the page.
- Links are anchored like page comments (block id plus a text snapshot), so
  they survive edits to the line and degrade to their quote if it disappears.

## Pages

- **`{{tab}}` strips and `{{fold}}` accordions** — the same section markers as
  specs, with `/tab` and `/fold` slash commands to insert them.
- **Interactive Markdown lists** — `- [ ]` / `- [x]` become checkable todos,
  and bullets under an Open/Completed heading render as rings or checks with a
  one-click toggle between the two. Block editing is safer against races.

## Deployments

- Each pending deploy lists the commits behind it, so it is clear what a
  deploy would ship before it runs.

## Agent comments

- **`meta.model` is now required** — an agent comment always names the model
  that wrote it, even when the writer cannot measure its own token counts.
  `in` / `out` / `ms` stay optional: pass only numbers you actually know.
- The MCP server and the `trame-page` skill now document the full page Markdown
  dialect (section markers, todos, status lists, pills, mermaid, code fences,
  PR chips, tables), so agents stop flattening structure into prose.
- PR chips are shared between pages and the session ticket, with a cache TTL
  and truncating labels.
