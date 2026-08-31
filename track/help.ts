// Shared agent-contract strings — the single source of truth read by tramecli --help,
// the MCP server (mcp/server.ts), and the installed command/skill stubs. Edit here only.
import app from "../app/deno.json" with { type: "json" };

export const VERSION: string = app.version;

// Page Markdown dialect, surface-neutral (the CLI and MCP wrap it with their own
// write-specs pointer).
export const PAGE_DIALECT =
  `GFM plus: \`## Title {{tab}}\` headings group the blocks below into a tab strip
(consecutive markers = one strip) and \`## Title {{fold}}\` into a collapsible section;
\`- [ ]\`/\`- [x]\` become checkable todos (2 spaces per nesting level, max 4);
bullets under a Completed/Done/Shipped heading render as checks, under
Open/Todo/Next/Pending/Remaining/In progress/Blocked as open rings, with a one-click
toggle between the two; \`{{text}}\` is a pill (\`{{green:…}}\` tints it:
green|yellow|red|copper|gray); a \`mermaid\` fence renders as a diagram and other
fences highlight python/ts/js/bash/json/sql; PR/MR links become live PR chips,
\`#123\` an issue ref, \`![alt](url)\` an inline image; GFM tables render as
interactive cards. A leading \`# Title\` equal to the page title is dropped. No raw
HTML or HTML entities — \`&middot;\` renders literally; write Unicode characters
(·, —, …) directly.`;

// Field-by-field composition conventions for `tramecli track` (formerly
// skills/trame-track/fields.md).
export const TRACK_FIELDS =
  `Only \`title\` is required. Send the full object on every update — an omitted field is
cleared, except the transcript linkage. In markdown (\`summary\`, specs), reference PRs/MRs
by full URL, never a bare \`#42\` — full links render as badges.

- \`title\` — \`<repo-basename> — <short topic>\`; the card's heading.
- \`status\` — column key, inferred from the conversation: default \`active\`; \`paused\`, \`blocked\`, \`done\` only if evident. Columns are user-editable and an unknown key is parked on the first column — when unsure of a key (or an existing project/story name), \`GET /api/board\` returns them all (\`statuses\`, \`projects\`, \`stories\`).
- \`client\` — **Project** name, resolved/created server-side. From the working dir: the \`TRACKER_CLIENTS\` env name appearing in the path as \`/<Client>/\`, else **Side-projects**.
- \`objective\` — **Story** the session serves, found-or-created by name under the project; only if evident.
- \`repo_path\` — the working dir (with \`branch\`, the upsert key among open sessions).
- \`branch\` — current git branch.
- \`next_step\` — one imperative line: the very next thing to do on resume; incorporate the user's note.
- \`pr_url\` — PR/MR link, only if evident.
- \`summary\` — worklog entry, 1–3 lines, PR-description style: outcome first, plus decisions and dead-ends worth remembering ("X fails because Y") — no implementation narration.
- \`links\` — optional backlink chips to plan/TODO pages: \`[{ "page_id", "block_id"?, "anchor"? }]\`; deduped server-side, only ever appended.

Specs

Specs are a real page — a subpage of the card's story; the tracker's response returns its
\`specs_page_id\`. Write them whenever a spec is evident (goal, scope, acceptance) —
especially planned work from a TODO/plan item, with \`links\` back to it. Update only when
the user asks or the plan materially changed; unchanged blocks keep their comment anchors.

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
    "objective": "Chart v2 polish",
    "repo_path": "/home/me/Projects/Obitrain/obi-chart",
    "branch": "fix/legend-overflow",
    "next_step": "Re-run the chart e2e suite after the flex fix",
    "pr_url": "https://github.com/obitrain/obi-chart/pull/42",
    "summary": "Legend no longer overflows narrow panels; flex-wrap was a dead-end (breaks export).",
    "links": [{ "page_id": "<plan-page-id>" }]
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

${PAGE_DIALECT}`;

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
  `tramecli setup — install the agent command/skills from this binary

  tramecli setup                   pick targets interactively (TTY only)
  tramecli setup --claude          /trame:track, /trame:watch + trame-page into ~/.claude
  tramecli setup --codex           $trame-track + $trame-page into ~/.agents/skills
  tramecli setup --skills-dir DIR  any Agent Skills directory (repeatable)

The docs are embedded in the binary and call the bare \`tramecli\`; when that name is
not on PATH the binary links itself into ~/.local/bin first. From a dev checkout,
\`just setup\` compiles a fresh binary and runs this.`;

export const LIST_HELP = `tramecli list — print open sessions grouped by story

Reads the board from the running Trame app; writes nothing. Sessions whose status
column is terminal (e.g. done) are omitted. --json prints flat rows
({id, title, status, story, branch, next_step, pr_url}) for jq.`;

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
  setup      install the agent command/skills embedded in this binary
  mcp        serve the Trame MCP server on stdio
  --version  print the CLI version (the app's is at GET /api/status)

The Trame app must be running (it writes its port to the port file); only
\`tramecli track\` works without it, by queuing to the offline outbox.

Run \`tramecli <command> --help\` for each input contract and the composition
conventions — compose fields from the conversation, do not ask the user.`;
