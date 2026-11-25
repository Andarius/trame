---
title: "v0.35.3 — Agents sidebar"
sidebar:
  label: "v0.35.3"
---

The agents sidebar gets easier to scan, and a project's agents can move to a window of their own.

## Features

- **Project window.** A project header's pop-out button moves that project's agents to their own
  window: the agent list on the left, the selected agent's shell on the right. Closing it brings
  the shells back to the dock in one tab (#456).
- **Working agents tint.** Rows of agents that are working get a background tint, configurable from
  the sidebar's menu (#451).
- **Project headers.** Each project header sits on a faint band, so projects no longer run into
  each other (#452).
- **Rebuild estimate.** An update's rebuild shows the time left, based on how long the last one
  took (#454).
- **trame:// links.** A `trame://` link opens in a new tab instead of replacing the current one (#455).

## Fixes

- **Right-click menu.** A sidebar row's menu opens at the cursor (#453).
