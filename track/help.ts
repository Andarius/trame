// Shared agent-contract strings — the single source of truth read by tramecli --help
// and the MCP server (mcp/server.ts). Edit here only; the installed skills carry their
// own curated summary and point back at this text.
import app from "../app/deno.json" with { type: "json" };

// TRAME_BUILD is baked into the compiled CLI (scripts/build-cli.ts): the release
// version alone cannot tell two builds of that release apart.
const build = (() => {
  try {
    return Deno.env.get("TRAME_BUILD") ?? "";
  } catch {
    return ""; // no --allow-env (embedders): the plain version still works
  }
})();
export const VERSION: string = build ? `${app.version}+${build}` : app.version;

// Page Markdown dialect, surface-neutral (the CLI and MCP wrap it with their own
// write-specs pointer).
export const PAGE_DIALECT =
  `GFM plus: \`## Title {{tab}}\` headings group the blocks below into a tab strip
(consecutive markers = one strip) and \`## Title {{fold}}\` into a collapsible section;
\`- [ ]\`/\`- [x]\` become checkable todos (2 spaces per nesting level, max 4);
bullets under a Completed/Done/Shipped heading render as checks, under
Open/Todo/Next/Pending/Remaining/In progress/Blocked as open rings, with a one-click
toggle between the two; \`{{text}}\` is a pill (\`{{green:…}}\` tints it:
green|yellow|red|copper|gray); a \`graph\` fence draws an architecture diagram
(see below) and a \`mermaid\` fence a mermaid one; a \`cards\` fence renders a KPI
row, one \`value | label\` per line with an optional trailing
\`| green|yellow|red|copper|gray\` to tint a card; other fences highlight
python/ts/js/bash/json/sql; PR/MR links become live PR chips,
\`#123\` an issue ref, \`![alt](url)\` an inline image; GFM tables render as
interactive cards; a line that is only \`{{trame:folder=<path>}}\` becomes a live
listing of that directory (\`{{trame:view=gallery}}\` after it shows HTML files as
thumbnails) — the path must sit under one of Trame's Explore roots, or the block
lists nothing. A leading \`# Title\` equal to the page title is dropped. No raw
HTML or HTML entities — \`&middot;\` renders literally; write Unicode characters
(·, —, …) directly.`;

// `graph` fences — the diagram dialect, drawn natively (no mermaid).
export const GRAPH_FENCE =
  `A \`graph\` fence is one edge per line, left to right; columns come from the edges
(a node sits one column right of its furthest source), so only write the flow:

  \`\`\`graph
  web[Web app|SPA · REST] -> api[API|granian] : REST + SSE
  cli[CLI] -> api : REST
  api -> pg[PostgreSQL|queue · events] : NOTIFY
  pg -> worker[Workers ×N] : LISTEN
  worker -> vm[Sandbox VM|no network] : sbx exec

  step Create: web>api, api>pg
    Alice submits the task.

    The API inserts it and NOTIFYs a worker, which claims it and starts.
    > What the console shows while it happens.
  step Stream: pg>worker, worker>vm
    The worker streams the agent's output back over SSE.
  \`\`\`

\`id[Title|subtitle]\` names a node the first time it appears (bare \`id\` after that);
\`: text\` after the target labels the edge. A \`step\` line is one beat of a lifecycle:
clicking it dims everything but the nodes and \`from>to\` edges it lists (a bare id
lights a node on its own). Lines indented under a step are that beat's prose, shown in
a card under the diagram and driven by the same selection: the first paragraph is the
scenario line, the rest the detail, and \`> …\` lines become the card's side panel
(inline markdown works throughout). The card carries ← Previous / Next → nav, so the
steps read as a lifecycle. A lifecycle with prose opens on beat 1; without prose the
whole diagram shows. Steps are optional — leave them out for a plain diagram.
Lines starting with \`//\` are comments.`;

// Todo lines: the dated marks the app keeps on `- [ ]`/`- [x]` items.
export const TODO_SYNTAX =
  `A todo carries its own dates inline, as \`{{trame:<key>=<value>}}\` marks at the end
of the line:

  - [ ] Rotate the reader keys {{trame:created_at=2026-08-20}}
  - [x] Ship the writers {{trame:created_at=2026-08-19}} {{trame:completed_at=2026-08-28}}

Keys, all plain \`YYYY-MM-DD\`:
  created_at    the day the item was raised          → chip "added 2026-08-20"
  completed_at  the day it was finished              → chip "done 2026-08-28"
  updated_at    comma-separated days the line changed → chip "edited 2026-08-30 ×3"

\`updated_at\` is the one list: days are deduped and sorted, only the 5 most recent are
kept, and a day equal to created_at is dropped. The editor appends to it when the text
of a todo changes and when a checked todo is re-opened — re-opening clears
\`completed_at\`, so nothing else would record it.

Write a mark yourself whenever you know the real date (an item raised last week, a
task finished before it was recorded). Otherwise leave it out: Trame stamps what is
missing on write, and the editor stamps \`completed_at\` when the checkbox is ticked
and drops it when the box is unticked, so \`completed_at\` is present exactly when the
todo is checked.

A mark you write is never overwritten, and marks survive a full-page rewrite that
omits them — so a page update does not have to repeat the dates it did not change
(\`updated_at\` unions both sides rather than picking one).
Quote a block by its visible text when commenting; the marks are not part of it.`;

// User databases — no tramecli command: plain REST on the running app. The column
// `config` is free-form jsonb server-side, so this text is the only place the
// vocabulary is written down for agents (the UI's own copy is app/web/src/api.ts,
// type PropConfig).
export const UDB_CONTRACT =
  `Databases (the Notion-style tables in Trame) have no tramecli command — they are
plain REST on the running app; the port is in ~/.local/share/trame/port.json and
nothing here is queued when the app is closed.

  POST /api/udb               {name}                    → {id}, with a "Name" title column
  POST /api/udb/<db>          {name?, icon?, page_id?}  rename, icon, show it on a page
  POST /api/udb/<db>/props    {name, type, config}      → {id}
  POST /api/udb/props/<prop>  {name?, config?, width?}  config MERGES into the stored one
  POST /api/udb/<db>/rows     {vals, icon?}             → {id}; vals keyed by PROPERTY id
  POST /api/udb/rows/<row>    {vals, icon?}             merges; a null value clears a cell
  POST /api/udb/links         {prop_id, from_row, to_row, remove?}    relation cells
  POST /api/udb/<db>/delete, /api/udb/props/<prop>/delete, /api/udb/rows/<row>/delete
  GET  /api/udb, GET /api/udb/<db> → {db, properties, rows}: rows[].vals keyed by property
       id, rows[].derived the formula/rollup values, rows[].relations the linked rows

\`config\` is stored exactly as sent and every key is optional — a column created with
\`{}\` renders bare (plain number, no unit, no color), which is never what the user
wants. Compose the presentation when you create the column. A column's \`type\` is
fixed at creation (name, config and width are patchable); \`config.icon\` (emoji or
image data-uri) replaces the type glyph in the header, and a row's \`icon\` is its
avatar.

Column types — the config they read, then the cell shape in \`vals\`:

  title         —                            "text"  · exactly one, created with the db
  text          —                            "text"
  url           —                            "https://…"
  checkbox      —                            true
  date          end: true for a range        {"start":"2026-09-21","end":"2026-09-30"}
  select        options: [{id,name,color}]   "<option id>"   (you mint the 8-char ids)
  multi_select  the same options             ["<option id>", …]
  number        the number block below       12.5
  relation      target_db, reverse_name?     not in vals — link rows via /api/udb/links
  formula       expr                         read-only, in rows[].derived
  rollup        relation_prop, agg, …        read-only, in rows[].derived

The number block — honoured by number columns and by formula/rollup results alike:

  format       plain|euro|dollar|percent   (€ / $ / % suffix; a unit replaces it)
  unit         free text after the value ("GB/s", "s"), muted
  unit_prop    id of a sibling select|text column giving a PER-ROW unit (unit is the
               fallback) — the select's option NAME is what shows
  precision    decimals; unset = the number as stored
  show_as      number|bar|ring · max = the value that reads 100% (default 100) ·
               show_value: false drops the figure beside the bar/ring
  color_mode   fixed  → color "#7bd88f"
               scale  → good low|high (which end is green, default low), scale_min /
                        scale_max (unset = auto over the column's visible values)
               rules  → rules: [{lt, color}] — first rule with value < lt wins, an
                        entry with no lt is the fallback
  color_apply  none|text|pill|dot|cell — where the color lands on a plain number
               (bar and ring always wear it)
  colors       hex; the option palette is #7a9ee7 #b590e7 #c98a63 #7bd88f #e3c567
               #e06c75 #6b7280

relation: \`{target_db, reverse_name?}\` — creates the paired column in the target
database (reverse_name defaults to this database's name), so never create both sides.
Cells live in their own table: POST /api/udb/links with the property and the two row
ids (remove: true unlinks). The server stamps \`pair\` and \`owner\` on both columns —
read them, never send them.

formula: \`{expr}\` — raw SQL over column NAMES, bare (case-insensitive, an underscore
matches a space) or quoted for anything else ("36-mo total €"). SQL keywords and
functions pass through (round, nullif, coalesce, case … end); ';' is refused; only
stored columns are referencable (not another formula, rollup or relation). Validated
on write — a bad expression is a 400, never a broken column.

rollup: \`{relation_prop, agg, target_prop, date_prop?}\` — relation_prop is a relation
column of THIS database, agg is count|sum|avg|min|max|latest, target_prop a column of
the target database (required unless count), date_prop the target's date column that
orders "latest" (default: last edited).

Example — a euro column that reddens as it grows:

  T=http://127.0.0.1:$(jq -r .port ~/.local/share/trame/port.json)
  curl -s -XPOST $T/api/udb/$DB/props -d '{"name":"36-mo total","type":"number",
    "config":{"format":"euro","precision":0,"color_mode":"scale","good":"low",
              "color_apply":"text"}}'`;

// When a session gets a spec page — one text, shared by the CLI help, the MCP
// descriptions, and the tracker's specs-less note.
export const SPECS_WHEN =
  `Write a spec page whenever the session produced knowledge worth keeping — planned
work (goal, scope, acceptance, with \`links\` back to the TODO/plan item) and
investigations (what broke, what was ruled out, what is still open) alike; the page is
the only place that survives, \`summary\` is 1–3 lines. When the session's whole story
is its diff, the spec page and the PR description are the same text — write it once on
the page and reuse it for the PR.`;

// Field-by-field composition conventions for `tramecli track` (formerly
// skills/trame-track/fields.md).
export const TRACK_FIELDS =
  `Only \`title\` is required. Send the full object on every update — an omitted field is
cleared, except transcript linkage, the story anchor, and tags. In markdown (\`summary\`, specs), reference PRs/MRs
by full URL, never a bare \`#42\` — full links render as badges.

- \`title\` — \`<repo-basename> — <short topic>\`; the card's heading.
- \`status\` — column key, inferred from the conversation: default \`active\`; \`paused\`, \`blocked\`, \`done\` only if evident. Columns are user-editable and an unknown key is parked on the first column — when unsure of a key (or an existing project/story name), \`GET /api/board\` returns them all (\`statuses\`, \`projects\`, \`stories\`).
- \`client\` — **Project** name, resolved/created server-side. From the working dir: \`TRACKER_CLIENTS\` is a JSON map of path segment → project or \`{"project":"…","tags":["…"],"repos":["…"]}\` (e.g. \`{"Work":{"project":"Soren","tags":["infra"]}}\` files a \`/Work/\` repo — or a \`…-Work-…\` scratchpad worktree — under **Soren**, stamping the tags on newly minted stories — only for whitelisted \`repos\` when set); no match → **Side-projects**.
- \`story\` — **Story** the session serves, found-or-created by name under the project; only if evident. Do not nest user stories. Sessions attach directly to their enclosing US; documentation may nest below it. A story bound for Cockpit needs a brief and a routing tag: its sessions inherit that routing and file as tickets, with \`next_step\` as the objective.
- \`tags\` — optional array of session tag keys from \`GET /api/tags\`, e.g. \`["priority-p1", "cockpit-devops"]\`. Omission preserves existing tags; \`[]\` clears them. Independent of story and specs-page tags. Create vocabulary labels such as \`priority:P1\` with \`POST /api/tags {"label":"priority:P1"}\`; store the returned \`key\`.
- \`repo_path\` — the working dir (with \`branch\`, the upsert key among open sessions). A planned card (open, no branch) on the repo is adopted by the first track naming its story — or by any first track when it has no story anchor.
- \`branch\` — current git branch.
- \`next_step\` — one imperative line: the very next thing to do on resume; incorporate the user's note.
- \`pr_url\` — PR/MR link, only if evident.
- \`summary\` — worklog entry, 1–3 lines, PR-description style: outcome first, plus decisions and dead-ends worth remembering ("X fails because Y") — no implementation narration.
- \`links\` — optional backlink chips to plan/TODO pages: \`[{ "page_id", "anchor"?, "block_id"? }]\`; deduped server-side, only ever appended. Pass the task line's exact text as \`anchor\` (marks may be omitted) and the chip lands on that todo, carrying this card's worklog — so each \`summary\` reads as an update under the task. No unique match, or no anchor at all, files the chip on the page. Every session linked to a page also feeds that page's **Activity** timeline — all their worklogs merged newest-first, read without opening a card.

Specs

Specs are a real page — a subpage of the card's story; the tracker's response returns its
\`specs_page_id\`. ${SPECS_WHEN} Update only when the user asks or the plan materially
changed; unchanged blocks keep their comment anchors.

  echo '{"session_id": "<session id>", "markdown": "## Goal\\n..."}' | tramecli page

Page dialect: see \`tramecli page --help\`.`;

export const TRACK_HELP =
  `tramecli track — create or update this work session's card

Pipe ONE JSON object on stdin (or pass it as the single argument):

  echo '{"title": "…", …}' | tramecli track

Posts to the running Trame app, or queues to the offline outbox when the app is
closed. The server upserts by repo_path+branch among open sessions and attaches the
agent's session UUID so the card gets a working Resume button (Codex: from
CODEX_THREAD_ID; Claude Code: from the UserPromptSubmit hook sidecar).
--json prints the server response ({id, specs_page_id, note}; {queued: true} when
the app is closed) instead of the human lines.

Compose every field from the conversation — do not ask the user.

${TRACK_FIELDS}

Example:

  {
    "title": "obi-chart — fix legend overflow",
    "status": "active",
    "client": "Obitrain",
    "story": "Chart v2 polish",
    "repo_path": "/home/me/Projects/Obitrain/obi-chart",
    "branch": "fix/legend-overflow",
    "next_step": "Re-run the chart e2e suite after the flex fix",
    "pr_url": "https://github.com/obitrain/obi-chart/pull/42",
    "summary": "Legend no longer overflows narrow panels; flex-wrap was a dead-end (breaks export).",
    "links": [{ "page_id": "<plan-page-id>", "anchor": "Fix the legend overflow" }]
  }`;

export const PAGE_HELP =
  `tramecli page — create or update a Trame page, or write a session's specs

Pipe ONE JSON object on stdin (or pass it as the single argument):

  create: {title, markdown?|markdown_file?, parent_id?|parent_title?, icon?}
    Without a parent the page files itself under the project owning the current
    working directory; parent_id: null forces a root (Unfiled) page.
  update: {page_id|page_title, markdown|markdown_file, title?, icon?}
    Replaces the content IN PLACE (full new content, not a diff); blocks whose text
    is unchanged keep their ids so inline comments stay anchored. Reply to the
    comments you are addressing BEFORE updating — the update may remove their block.
  specs:  {session_id, markdown|markdown_file}
    Find-or-create the session's spec page, then update it in place.

Requires the running Trame app (page writes are not queued).

Markdown dialect:

${PAGE_DIALECT}

Graph fences:

${GRAPH_FENCE}

Todo lines:

${TODO_SYNTAX}`;

export const COMMENT_HELP =
  `tramecli comment — add an inline agent comment to a page block

Pipe ONE JSON object on stdin (or pass it as the single argument):

  {page_id|page_title, block_id|block_text, body, agent?, meta, in_reply_to?}

- block_text: a unique exact quote from the target block.
- in_reply_to: comment id you are answering — it is marked "answering" before the
  reply and "answered" after, so the UI never shows a stuck spinner.
- agent: id of the model ACTUALLY writing (codex, claude, glm, gemini, …) — attribute
  the real model, not the harness seat; codex/claude get a branded avatar, any other
  id a generated one. Never post as a human.
- meta.model is required: the exact model id you run as (e.g. claude-opus-5); it
  renders as a footer. Running as claude or codex, in/out/ms are required too —
  both harnesses report their own usage, so read it there. Other agents omit what
  they cannot measure; never guess (a visible footer must mean real data).`;

export const SETUP_HELP =
  `tramecli setup — install the agent skills from this binary

  tramecli setup                   pick targets interactively (TTY only)
  tramecli setup --claude          trame-track, trame-page, trame-watch into ~/.claude/skills
  tramecli setup --codex           the same skills into ~/.agents/skills
  tramecli setup --skills-dir DIR  any Agent Skills directory (repeatable)
  tramecli setup --hook            the git pre-push guard, into the repo you run it from

The docs are embedded in the binary and call the bare \`tramecli\`; when that name is
not on PATH the binary links itself into ~/.local/bin first. From a dev checkout,
\`just setup\` compiles a fresh binary and runs this.

\`--hook\` writes the pre-push guard into the repo you run it from (core.hooksPath is
honoured): it refuses a push whose Trame session is missing or older than the commits
being pushed. Bypass one push with \`git push --no-verify\`.`;

export const LIST_HELP = `tramecli list — print open sessions grouped by story

Reads the board from the running Trame app; writes nothing. Sessions whose status
column is terminal (e.g. done) are omitted. --json prints flat rows
({id, title, status, story, branch, repo_path, last_touched, next_step, pr_url})
for jq — what the pre-push hook filters on.`;

export const CONVERT_HELP = `tramecli convert — turn a page into a session card

  tramecli convert <page-id>

The page becomes the card's specs (specs_page_id) — same page, no copy; the card
anchors to the nearest story above it and inherits that branch's project. Same call as
the page header's "Convert to session" button. Idempotent: the card id derives from the
page id, so converting again returns the existing card (--json prints
{id, created:false}) instead of forking a second one.

Then track it as usual — \`repo_path\`/\`branch\` land on the card on the first
\`tramecli track\` that names it.`;

export const OVERVIEW =
  `tramecli ${VERSION} — agent CLI for Trame, the local-first session tracker

Usage: tramecli <command> [args]

Commands:
  track      create/update this work session's card (JSON on stdin)
  page       create/update a page, or write a session's specs (JSON on stdin)
  comment    add an inline agent comment to a page block (JSON on stdin)
  watch      wait for human feedback on page(s); exits 0 when feedback is ready
  answer     daemon: auto-answer human replies on agent comment threads
  list       print open sessions grouped by story
  convert    turn a page into a session card whose specs are that page
  setup      install the agent skills embedded in this binary
  db         print the database write contract (columns, cells) — REST, no command
  mcp        serve the Trame MCP server on stdio
  --version  print the CLI version (the app's is at GET /api/status)

The Trame app must be running (it writes its port to the port file); only
\`tramecli track\` works without it, by queuing to the offline outbox.

Run \`tramecli <command> --help\` for each input contract and the composition
conventions — compose fields from the conversation, do not ask the user.`;
