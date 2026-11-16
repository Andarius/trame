---
title: "v0.32.0 — Running list"
sidebar:
  label: "v0.32.0"
---

The Terminals view's RUNNING list gets side tabs, multi-select and a right-click menu, and the desktop
app stops forgetting its settings on every restart.

## Features

- **Side tabs from RUNNING.** Ctrl/⌘-click opens a running card, or an agent session without a card,
  as a side tab in the rail (#357).
- **Select and close several.** Shift-click selects a range and Ctrl/⌘+Shift-click toggles one card.
  **Close shells** (or Delete) closes all their shells after one confirm (#357).
- **Right-click menu on running rows**: **Link to card…** and **Close shell(s)** (#357).
- **Newest first.** Cards sort by their last update, agent sessions by Claude's own `updatedAt`
  (#357).
- **Done sessions.** An idle Claude session whose last reply ends with "Follow-ups: none" shows a
  green ✓ instead of idle (#357).
- **Outside agents in their own section.** Cards listed only because their agent runs in a
  terminal outside Trame move to a dimmed **OUTSIDE TRAME** section at the bottom (#357).

## Fixes

- **Settings survive a restart.** The desktop app reuses the port of its previous launch, so the
  webview keeps the same origin and its saved settings: terminal zoom, interface scale, folded
  sections and groupings. The first launch after updating picks up the most recent settings (#363).
- **Terminal tabs** are larger, the scrollbar no longer covers their labels, and dragging the tab
  you're on now shows your last tab so you can drop it beside it (#356).
- **Due pills update live.** Late pills and the DUE list refresh as soon as a page changes, and at
  midnight (#359).
