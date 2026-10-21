---
title: "v0.21.0 — Icon rail and decision fences"
sidebar:
  label: "v0.21.0"
---

The sidebar becomes an icon rail with a column per view, and a page can now ask a human a question
that gets answered in place.

## Features

- **Icon rail.** Every view is one click away in a narrow rail on the left, with what needs you as
  badges: a dot on AI Sessions while an agent waits or works, the number of shells on Terminals, a
  plugin's count on its icon. Hover shows the name and that detail. Settings and sync state sit at
  the bottom.
- **A column per view.** Beside the rail, Sessions keeps its workspace tree; Terminals lists the cards
  with shells; AI Sessions lists who needs you, who is working, and filters by repo and AI; Explore
  lists reports and files. Plugins can fill it too: Deployments lists its organizations there.
  Switching views keeps each one's data instead of loading it again.
- **Decision fence.** A `decision` block asks a question inside a page: one option per line, a
  recommended one, single or multiple picks, an Other… row for a free answer. It shows a waiting pill
  until the human picks; the answer is written back as marks agents can read.
- **`tramecli open`** shows a page or card in the running desktop app. `trame://page/<id>` and
  `trame://card/<id>` links open there too, and start the app on that view when it isn't running.
  When the window can't take focus (Wayland), its taskbar entry is flagged instead.
- **Terminals.** Drag a shell from Working now or a tab onto a pane to split it; typing `exit` closes
  the terminal. Antigravity and Mistral Vibe get their real logos.
- **Demo workspace.** An empty board offers to import your Claude Code or Codex sessions, or to explore
  a demo workspace on sample data (also in Settings → Demo workspace). The demo runs offline, apart
  from your data, and never lists your real transcripts.
- **Deployments** rows show the GitHub and GitLab marks, and each organization gets a colored monogram.
- **SQL sources** are managed from Settings → SQL sources (edit, refresh, delete) instead of a
  sidebar panel.
- **Reload:** Ctrl/Cmd+R and F5 reload the desktop window.

## Fixes

- Linux: quitting the app no longer pops KDE's crash dialog (a WebKit process crashed in Mesa on
  exit).

## Upgrading

- No protocol or schema change: v0.14.0 to v0.21.0 nodes sync with each other.
- Plugins that add a sidebar column need this version: `PanelProps.column` and `SidebarColumn` in
  `@trame/web-api`. On older versions they show their panel as before.
- The macOS app and the AppImage update themselves; deb and snap installs get a link to the release.
