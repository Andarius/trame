---
title: "v0.9.0 — HTML blocks: interactive docs inside pages"
sidebar:
  label: "v0.9.0"
---

Pages can now embed self-contained interactive HTML documents — option pickers,
forms, little tools — rendered live, with a data channel back to the page.

## HTML blocks

- **`/html` in the page editor**: paste a complete HTML doc or import a `.html`
  file. Rendered in a **sandboxed iframe** (`allow-scripts`, never
  `allow-same-origin`): scripts run, but the doc has no cookies, no app API, no
  parent DOM, no network identity. 512 KB doc cap with a clear error.
- **Data back**: the doc calls `window.trame.send(data)` and the result is
  persisted on the block (64 KB cap), synced like any page edit, and shown as a
  `data` chip in the block header (hover to inspect, click to copy). On reload
  the block replays saved data via a `trame:init` event so the doc restores its
  state.
- **Sizing**: auto-height via the bridge; drag the strip under a block to pin a
  height, `auto` to unpin.

## Agents

- **`trame_html`** (MCP): drop an interactive doc onto a page — append, replace
  an existing block, or create a new page around it. **`trame_html_data`** reads
  back what the user picked. An agent can now ask a visual question and read the
  answer — no clipboard round-trip.

## Public links

- HTML blocks render in shared `/l/<token>` pages through the same sandboxed
  iframe with auto-height. The data-back channel is off there — public viewers
  see the doc, they can't write to the block.
