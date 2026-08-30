Only `title` is required. Send the full object on every update — an omitted field is
cleared, except the transcript linkage. In markdown (`summary`, specs), reference PRs/MRs
by full URL, never a bare `#42` — full links render as badges.

- `title` — `<repo-basename> — <short topic>`; the card's heading.
- `status` — column key, inferred from the conversation: default `active`; `paused`, `blocked`, `done` only if evident. Columns are user-editable and an unknown key is parked on the first column — when unsure of a key (or an existing project/story name), `GET /api/board` returns them all (`statuses`, `projects`, `stories`).
- `client` — **Project** name, resolved/created server-side. From the working dir: the `TRACKER_CLIENTS` env name appearing in the path as `/<Client>/`, else **Side-projects**.
- `objective` — **Story** the session serves, found-or-created by name under the project; only if evident.
- `repo_path` — the working dir (with `branch`, the upsert key among open sessions).
- `branch` — current git branch.
- `next_step` — one imperative line: the very next thing to do on resume; incorporate the user's note.
- `pr_url` — PR/MR link, only if evident.
- `summary` — worklog entry, 1–3 lines, PR-description style: outcome first, plus decisions and dead-ends worth remembering ("X fails because Y") — no implementation narration.
- `links` — optional backlink chips to plan/TODO pages: `[{ "page_id", "block_id"?, "anchor"? }]`; deduped server-side, only ever appended.

### Specs

Specs are a real page — a subpage of the card's story; the tracker's response returns its
`specs_page_id`. Write them whenever a spec is evident (goal, scope, acceptance) —
especially planned work from a TODO/plan item, with `links` back to it. Update only when
the user asks or the plan materially changed; unchanged blocks keep their comment anchors.

```bash
echo '{"session_id": "<session id>", "markdown": "## Goal\n..."}' | deno run -A __PAGE_WRITER__
```

Page dialect: `## Title {{fold}}` renders as a collapsible section — use it for long
explainers so the working spec stays on top; consecutive `## Title {{tab}}` headings render
as a tab strip; `- [ ]`/`- [x]` become checkable todos (2-space nesting). Full PR/MR URLs
render as live state chips, `#123` as issue refs, `{{text}}`/`{{green:text}}` pills
(green|yellow|red|copper|gray), `mermaid` fences as diagrams; code fences highlight, tables
and images render. No raw HTML or entities — write Unicode directly.
