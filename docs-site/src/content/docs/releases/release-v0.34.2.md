---
title: "v0.34.2 — Terminal polish"
sidebar:
  label: "v0.34.2"
---

Faster New terminal, cleaner split panes, and grouped cards in the sidebar.

## Features

- **Search from New terminal.** The dialog opens with a search box focused: type part of a repo
  path and press Enter to open a shell there, in that repo's project. Git worktrees now sit in
  their own folded **Worktrees** section, so the main folders come first (#394).
- **Cards that share a tab sit together.** In the sidebar, cards whose shells share a terminal tab
  are grouped, with a copper bar on their side (#391).

## Fixes

- **Split panes.** Terminals no longer show a scrollbar, and a thin separator line marks the border
  between split panes; it lights up when you hover it to resize (#393).

## Upgrading

- No protocol or schema change from v0.34.1.
- The macOS app and the AppImage update themselves; deb and snap installs get a link to the release.
