---
title: "v0.30.0 — One Agents view, card workspaces"
sidebar:
  label: "v0.30.0"
---

Terminals and AI sessions merge into one Agents view, cards open as tabs on the rail, and Due gets its
own rail icon.

## Features

- **One Agents view** for terminals and AI sessions: agents waiting on you on top, running shells, then
  this week's past sessions (#333). **Recent** shows how each session ended (a question, finished,
  stopped) and groups by day, repo or card (#337); a past session's tail replays in a read-only
  terminal (#336).
- **Card workspaces**: Ctrl/⌘-click a card to open it as a tab on the rail, Ctrl+1…9 to switch, right-click
  to rename, move or close (#340).
- **Due on the rail**, its list as the sidebar column (#342).
- **Terminals**: start a terminal or agent from the Cards sidebar (#311), link a running shell to a card
  (#332), open `file://` links a shell prints (#331), preview a PR link on hover (#335), and
  Ctrl/⌘ `+` `-` `0` resize the font of a focused shell (#345).
- **Decision fences** take several picks (`{{trame:pick=many}}`) and a free-text answer (#343).
- **Comment links** let visitors of a published HTML page comment through the hub (#329).
- **Insights** count Mistral Vibe sessions per model (#339).
- A kanban-board icon for Sessions on the rail (#346).

## Fixes

- Resuming a past session that still runs in the background attaches to it instead of failing (#341).
- Terminal panel and sidebar polish (#330).
- The agent skills report `trame://` links, which open the desktop app (#347).
- Dependency updates, including a security fix for rmcp (#328).

## Upgrading

- No protocol or schema change: v0.14.0 to v0.30.0 nodes sync with each other.
- The macOS app and the AppImage update themselves; deb and snap installs get a link to the release.
