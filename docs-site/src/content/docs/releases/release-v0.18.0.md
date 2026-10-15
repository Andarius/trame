---
title: "v0.18.0 — live embeds and databases in pages"
sidebar:
  label: "v0.18.0"
---

Pages embed live dashboards from allowlisted hosts, and databases sit inline in the page text.

## Features

- **Embed block.** A line that is only `{{trame:embed=https://…}}` renders the URL in a frame, with
  an optional `{{trame:height=<px>}}` after it. Only https URLs whose host is listed in
  Settings › Embeds (`embedHosts`, or `TRACKER_EMBED_HOSTS`) render; others stay plain text.
- **Databases inline.** A line-only `{{trame:db=<db id>}}` places a database at that block, with its
  views and tabs; it round-trips through `show` and full-page rewrites. An attached database no
  marker places gets a drag handle to drop it into the text.
- **View and edit modes** for a database on a page: it opens on its tabs and rows; one toggle (Esc
  to leave) brings back the full chrome for that viewer only.
- **Comments on database rows.** Replies, resolve and agent attribution, like block threads.
  `tramecli comment` and `trame_add_comment` target `{db_id, row_id}` or a unique
  `{db_id, row_title}`; `trame-watch` picks them up.
- **Chart series colours.** A series takes an optional `"color": "#rrggbb"`.
- **Wide tables** grow into the margins up to the pane width and resize by their right edge.

## Upgrading

- No protocol or schema change: v0.14.0 to v0.18.0 nodes sync with each other.
- Embeds are off until a host is added under Settings › Embeds.
