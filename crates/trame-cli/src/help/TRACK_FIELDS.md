`title` and `story` are required. One agent session + story = one card: every branch and
PR the session ships on that story lands on the same card (`branch` is the latest, earlier
ones stay in `branches`, PRs accumulate in `pr_url`), across repos. A different story is
the only way to split into a new card; a done card is never reopened. Send the full object on
every update — an omitted field is cleared, except transcript linkage, the story anchor, tags,
branches and PRs. In markdown (`summary`, specs), reference PRs/MRs
by full URL, never a bare `#42` — full links render as badges.

- `title` — `<repo-basename> — <short topic>`; the card's heading.
- `status` — column key, inferred from the conversation: default `active`; `todo` (not started yet), `paused` (started, on hold), `blocked`, `done` only if evident. Columns are user-editable and an unknown key is parked on the first column — when unsure of a key (or an existing project/story name), `GET /api/board` returns them all (`statuses`, `projects`, `stories`).
- `client` — **Project** name, resolved/created server-side. From the working dir: `TRACKER_CLIENTS` is a JSON map of path segment → project or `{"project":"…","tags":["…"],"repos":["…"]}` (e.g. `{"Work":{"project":"Soren","tags":["infra"]}}` files a `/Work/` repo — or a `…-Work-…` scratchpad worktree — under **Soren**, stamping the tags on newly minted stories — only for whitelisted `repos` when set); no match → **Side-projects**.
- `story` — **Story** the session serves: the topic key that groups its branches onto one card. Pick it BEFORE tracking: `tramecli stories -q "<topic>"` lists similar open stories of the project — reuse one that fits, else name a short new topic. Found-or-created by name under the project; a near-identical open story is reused (the response's `story_note` says so), and a new story that resembles existing ones returns them in `story_note` — re-track with one of them when it is the same topic. Do not nest user stories. Sessions attach directly to their enclosing US; documentation may nest below it. Naming a story never converts a page nested in another page — that takes `tramecli convert --story <page-id>`. A story bound for an external tracker (a plugin that files tickets) needs a brief and a routing tag: its sessions inherit that routing and file as tickets, with `next_step` as the objective.
- `tags` — optional array of session tag keys from `GET /api/tags`, e.g. `["priority-p1", "team-devops"]`. Omission preserves existing tags; `[]` clears them. Independent of story and specs-page tags. Create vocabulary labels such as `priority:P1` with `POST /api/tags {"label":"priority:P1"}`; store the returned `key`.
- `repo_path` — the working dir (with `branch`, the upsert key when there is no agent session id). A planned card (open, no branch) on the repo is adopted by the first track naming its story — or by any first track when it has no story anchor.
- `branch` — current git branch.
- `next_step` — one imperative line: the very next thing to do on resume; incorporate the user's note.
- `pr_url` — PR/MR link, only if evident; added to the card's PRs, never replacing them.
- `card` — an existing card you were asked to work on (its id or a pasted Trame link). This
  session adopts that card instead of matching by story: its updates, Resume and live presence
  follow you. Use it whenever the prompt names a card; still send the full object.
- `model` — the exact model id you run as (e.g. claude-opus-5-5, gpt-5.5-codex); the worklog entry shows it next to the agent. Never guess it.
- `tokens`, `cost_usd` — optional usage behind this entry (tokens, USD), shown on the worklog line. Only real numbers your harness reports.
- `summary` — worklog entry, 1–3 lines, PR-description style: outcome first, plus decisions and dead-ends worth remembering ("X fails because Y") — no implementation narration.
- `links` — optional backlink chips to plan/TODO pages: `[{ "page_id", "anchor"?, "block_id"? }]`; deduped server-side, only ever appended. Pass the task line's exact text as `anchor` (marks may be omitted) and the chip lands on that todo, carrying this card's worklog — so each `summary` reads as an update under the task. No unique match, or no anchor at all, files the chip on the page. Every session linked to a page also feeds that page's **Activity** timeline — all their worklogs merged newest-first, read without opening a card.

Specs

Specs are the card's content: the app shows them inside the card view (`?view=card&card=<id>`),
stored as a page that is never listed on its own — the tracker's response returns its
`specs_page_id`. %%SPECS_WHEN%% Update only when the user asks or the plan materially
changed; unchanged blocks keep their comment anchors.

  echo '{"session_id": "<session id>", "markdown": "## Goal\n..."}' | tramecli page

Page dialect: see `tramecli page --help`.
