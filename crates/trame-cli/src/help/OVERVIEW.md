tramecli %%VERSION%% — agent CLI for Trame, the local-first session tracker

Usage: tramecli <command> [args]

Commands:
  track      create/update this work session's card (JSON on stdin)
  page       create/update a page, or write a session's specs (JSON on stdin)
  comment    add an inline agent comment to a page block (JSON on stdin)
  presence   report what the agent is doing now: working / waiting / idle
  show       read a card (fields, specs, worklog) or a page, by id or Trame URL
  watch      wait for human feedback on page(s); exits 0 when feedback is ready
  answer     daemon: auto-answer human replies on agent comment threads
  list       print open sessions grouped by story
  stories    open stories similar to a topic (pick one before tracking)
  convert    turn a page into a session card whose specs are that page
  archive    fold a page or user story away (--restore brings it back)
  move       reparent a page under another page (or --top)
  open       show a page or card in the desktop app (or its trame:// link)
  setup      install the agent skills embedded in this binary
  deployments  per-repo rules matching waiting releases to cards
  db         write database rows (`db rows <db>`); bare, the database contract
  query      print the board's session-filter syntax
  mcp        serve the Trame MCP server on stdio
  --version  print the CLI version (the app's is at GET /api/status)

Commands talk to the running Trame app (it writes its port to the port file).
With no app running they go to the hub instead — hubApi + hubApiToken in
settings.json (or TRACKER_HUB_API + TRACKER_HUB_API_TOKEN), members only — except
`watch` and `answer`, which need the app. With neither, `tramecli track` queues
to the offline outbox.

Run `tramecli <command> --help` for each input contract and the composition
conventions — compose fields from the conversation, do not ask the user.
