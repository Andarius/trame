# Trame — capabilities for agents

Trame is a local-first tracker (sessions, pages, databases) that syncs to a shared hub.
As an agent you can:

## Review comments (conversational)
- Leave inline comments on a page block with **trame_add_comment** (page by id/title,
  block by id or a unique text quote), or on a database row (db_id + row_id or a unique row_title).
- **Attribution**: set `agent` to the id of the model ACTUALLY writing (codex, claude,
  glm, gemini, …) — not the harness seat. codex/claude get a branded avatar; any other
  id gets a generated one. Never post as a human.
- **`meta.model` is required** — the exact model id you run as; it shows as a footer.
  Running as claude or codex, `in`/`out`/`ms` are required too — both harnesses
  report their own usage, so read it there. Other agents omit what they can't measure;
  never guess a number (a footer must be real).
- **The watcher loop**: a human may reply to your comment. If the human runs `tramecli answer`,
  YOUR agent is invoked to answer that reply — so a thread is a back-and-forth, not a
  one-shot. Your answer posts as the next comment; the watcher fills its meta for you.

## Pages & reports
- **trame_create_page** — create a page from Markdown (not a session card). It files
  itself under the project owning `repo_path` (pass your working directory); pass
  parent_id only to nest it elsewhere.
- **trame_update_page** — replace a page's content from Markdown IN PLACE; unchanged
  blocks keep their ids so inline comments stay anchored. Reply to comments before updating.
- **trame_move_page** — reparent/reorder an existing page (fix a wrong parent, nest under another page).
- **trame_html** — embed an interactive HTML doc on a page (sandboxed iframe, scripts run).
  The doc calls `window.trame.send(data)` to persist structured results on the block;
  **trame_html_data** reads them back. Use this to ASK the user something visual
  (option pickers, forms) — they click in Trame, you read the answer. Prefer it over
  trame_report when you want an answer back.
- **trame_report** — publish a self-contained HTML report to the Explore view.

## Page Markdown dialect
%%PAGE_DIALECT%%

## Graph fences
%%GRAPH_FENCE%%

## Todo lines
%%TODO_SYNTAX%%

A session's specs are a page too (a subpage of the card's story) — write them with
`trame_update_page` passing `{session_id}`. %%SPECS_WHEN%%

## Databases and chart views
%%UDB_CONTRACT%%

## Sessions (the board)
- **trame_session** — read ONE card the way the user sees it: project and story by name,
  branch, PR, next step, specs, backlinks and the activity worklog. Takes a session id or
  a Trame URL the user pasted — when someone gives you a link, read it with this rather
  than guessing what is on it. `trame_board` returns raw ids and no worklog.
- **trame_track** — create/update a work session (upsert by repo_path+branch).
- **trame_set_status** — move a card between columns.
- **trame_new_story** — create the story/epic sessions ladder up to.

## Read / sync
- **trame_board** — read sessions, stories, projects. **trame_reports** — list reports.
- **trame_sync** — push/pull with the hub now.

The app must be running (it writes its port for these tools). All writes ride the normal
LWW sync to the hub.
