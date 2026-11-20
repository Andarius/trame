---
title: "v0.34.3 — Live split resize"
sidebar:
  label: "v0.34.3"
---

Split panes follow the divider as you drag it, and the Claude mod offers to exit paused sessions.

## Fixes

- **Live split resize.** Dragging the divider between split panes now resizes them as you move,
  instead of only on release. Shells still get the new size once the drag settles, so zsh and TUIs
  don't redraw on every move (#400).
- **Exit prompt on paused cards.** The Claude mod's end-of-turn Exit/Stay question now also appears
  when the session's card is paused, not only done, and names the status. Run
  `tramecli setup --mod` to update the mod (#398).

## Upgrading

- No protocol or schema change from v0.34.2.
- The macOS app and the AppImage update themselves; deb and snap installs get a link to the release.
