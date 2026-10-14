---
title: "v0.17.0 — query box everywhere"
sidebar:
  label: "v0.17.0"
---

The GitHub-style query box replaces the Filters menu, and graph fences gain groups and styles.

## Features

- **`assigner:` query key.** `assigner:carlo` (substring, case-insensitive), `-assigner:carlo`,
  `has:assigner` and `no:assigner` filter sessions in the Board, List and Graph views and in
  `tramecli list -q`.
- **Query suggestions.** Typing in the query box proposes keys (`status:`, `project:`…) and
  their values, drawn like the app: avatars, status dots, project and story icons, tag chips.
- **Query box replaces the Filters menu.** Card chips toggle query terms; `story:` and
  `project:` match a parent's whole subtree. `?nospecs=1` links become `no:specs`; `?story=`
  links are dropped.
- **Graph fences:** groups (one column each), `#bad`/`#warn`/`#good` tones, dashed edges
  (`..>`), a `style` line (`workshop`, `sketch`, `neon`), a `wide` toggle and a draggable width.
- **`tramecli move`** reparents a page in place.

## Fixes

- **Manual sync reports its error.** The sync button shows "Sync failed · <reason>" instead of a
  bare failure; an unreachable hub answers 502.
- **Plugin styles no longer override the app's responsive layout**, which hid the specs column
  of the session card.

## Upgrading

- No protocol or schema change: v0.14.0 to v0.17.0 nodes sync with each other.
- Two project chips now AND together as substring matches instead of giving their union.
