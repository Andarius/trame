Session query (the board's query box, mirrored to ?q=) — gh-style:
  terms AND, commas OR within a key, "-" negates, * globs, "quote spaced values"
  status:active,blocked  tag:p1  project:trame  story:"cli rollout"
  branch:feat/*  repo:  agent:codex  title:  summary:  next:
  assigner:carlo   who handed you the card, from a plugin (e.g. Cockpit)
  has:pr|specs|branch|next|story|project|tags|transcript|assigner   no:specs
  touched:>7d  touched:<2026-09-01   (h/d/w relative, or a date; >= and <= too)
  bare words search title, summary, next step and branch
  e.g. status:active,blocked -has:specs touched:>7d "topbar"
  from a terminal: tramecli list -q '<query>'
