tramecli track — create or update this work session's card

Pipe ONE JSON object on stdin (or pass it as the single argument):

  echo '{"title": "…", …}' | tramecli track

Posts to the running Trame app, or queues to the offline outbox when the app is
closed. The server matches the open card of this agent session + story (else, with no
session id, repo_path + any of the card's branches) and attaches the session UUID so the
card gets a working Resume button (Codex: CODEX_THREAD_ID; Claude Code:
CLAUDE_CODE_SESSION_ID, else the UserPromptSubmit hook sidecar).
--json prints the server response ({id, specs_page_id, note, story_note}; {queued: true}
when the app is closed) instead of the human lines.

Compose every field from the conversation — do not ask the user.

%%TRACK_FIELDS%%

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
  }
