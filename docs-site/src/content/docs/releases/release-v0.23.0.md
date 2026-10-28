---
title: "v0.23.0 — Insights across devices, due multi-select"
sidebar:
  label: "v0.23.0"
---

Insights now counts every device that syncs with your hub, due todos can be handled in bulk, and
search finds anything by its id.

## Features

- **Insights across devices.** Prompts and tokens come from every Trame install of yours that syncs
  with the same hub, not only this machine. Each install shares its daily totals with the hub; the
  footer names how many devices are counted.
- **Insights dashboard.** Two columns: the tiles and activity per project on the left, the activity
  heatmap and tokens per agent on the right. Projects show their icon and a bar scaled to the top
  one, and the view has its own icon in the rail.
- **Due multi-select.** In the due list, Shift-click selects a range and Ctrl/Cmd-click toggles one
  todo; the action bar opens a terminal on each selected card or marks the todos done.
- **Hide the card details.** A button in the terminal dock, or Ctrl/Cmd+Shift+\, hides or shows the
  card details beside the terminals.

## Fixes

- Search finds cards, pages, databases and agent sessions by their id, or by its first characters.
- Insights' change badges stay on one line; very large increases show as a multiple (`12×`).

## Upgrading

- No protocol or schema change: v0.14.0 to v0.23.0 nodes sync with each other.
- Insights across devices needs the hub redeployed (`hub/deploy.sh`); until then each install shows
  only its own figures.
- The macOS app and the AppImage update themselves; deb and snap installs get a link to the release.
