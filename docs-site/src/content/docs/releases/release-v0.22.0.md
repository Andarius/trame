---
title: "v0.22.0 — Insights, Diagnostics and native plugins"
sidebar:
  label: "v0.22.0"
---

Two new views show what you and Trame are doing, Jupyter notebooks open in the sidebar, and plugin
backends now compile into the app.

## Features

- **Insights.** A stats view in the rail: prompts sent, tokens, worklog entries, cards done and PRs
  merged for 7, 30 or 90 days or a year, each against the previous period; a one-year activity
  heatmap with your current and longest streak; activity per project; tokens per agent and model.
  Prompts and tokens come from the Claude Code and Codex transcripts on this machine (read once,
  then cached); merged PRs come from `gh` and `glab` in the background.
- **Diagnostics.** Memory, CPU and network use of Trame and each of its processes (window, database,
  terminals), local HTTP traffic, hub sync, and database size. Open it from Settings.
- **Notebook plugin.** JupyterLab in the sidebar, showing one notebook: start a server in a folder or
  attach to a running one. It follows Trame's theme, and exports to a Trame report or to HTML.
- **Plugin updates.** Out-of-tree plugins can declare a version and a GitHub repo; the Plugins
  manager shows when a newer release exists and how to install it.
- **`trame-plugin` skill**, installed by `tramecli setup`: how to write, test and release an
  out-of-tree plugin.
- **Hide the sidebar.** A button at the top of the rail, or Ctrl/Cmd+\, hides or shows the column
  beside it.
- **Larger icons.** The terminal dock's buttons are proper icons, and small icons and close buttons
  across the app are bigger.

## Changes

- Plugin backends are native Rust compiled into the app; the separate Bun plugin host is gone.

## Upgrading

- No protocol or schema change: v0.14.0 to v0.22.0 nodes sync with each other.
- If you added out-of-tree plugins (for example trame-k8s or trame-cockpit), pull their latest
  `main`, run `just plugins` and `just plugins-install`, then rebuild and reinstall Trame from source:
  their backends now compile into the app. The old `plugin-host` binary is ignored, and the next
  `just plugins-install` removes it.
- The macOS app and the AppImage update themselves; deb and snap installs get a link to the release.
