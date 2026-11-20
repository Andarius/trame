---
title: "v0.34.0 — Split panes with tabs, pop-out shells, starred sessions"
sidebar:
  label: "v0.34.0"
---

Terminal splits that work like an editor's, shells in their own windows, and an Agents list you can pin.

## Features

- **Split panes with their own tabs.** Each pane of a split holds several shells as tabs, with its own
  **+**, split and maximize buttons. Drop a shell on a pane's middle to add it as a tab, on an edge to
  split. ⌘T / Ctrl+T opens a shell in the focused pane (#376, #377).
- **Resizable splits.** Drag the line between two panes; the size is kept, and a double-click evens it
  out (#375).
- **Pop a shell out.** Open a dock shell in a window of its own; closing that window puts it back where
  it was (#381).
- **Starred sessions.** Star a session in the Agents list: starred ones sort first, have their own
  filter, and stay listed however long ago they ran. Sessions renamed with `/rename` show that name
  (#382).
- **Trame links open in a tab.** A card, page or database link clicked in a terminal opens on the rail as
  its own tab, so the view you were in stays put (#384).
- **Insights** count a done card on the day it was closed, not on its last edit (#380).

## Fixes

- Links Claude Code prints (OSC 8) open directly and preview PRs on hover, without the "potentially
  dangerous" prompt (#373).
- Moving a shell to another tab, or merging two tabs, no longer reloads it (#374).
- An agent waiting in a terminal outside Trame stays under **Outside Trame** instead of **Needs you**
  (#383).
- Lower typing latency in terminals (#386).
- Long pages no longer get extra blank scroll height (#385).
- Insights: a failing `gh` / GitLab CLI no longer retries every few seconds, and change badges skip
  periods with partial data (#380).
- Dependency updates, including a security fix for wasmtime (#378, #379).

## Upgrading

- **Protocol 9:** redeploy the hub first (`hub/deploy.sh`), then update every install. Done cards get
  their closing date from their last activity once.
- The macOS app and the AppImage update themselves; deb and snap installs get a link to the release.
