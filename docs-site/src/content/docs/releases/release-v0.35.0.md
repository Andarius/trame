---
title: "v0.35.0 — Agents sidebar"
sidebar:
  label: "v0.35.0"
---

The Terminals sidebar now lists the agents you have running, grouped by project and repo, with their
forks, subagents, /advices runs and follow-ups underneath. Projects keep a list of their repos.

## Features

- **Agents sidebar.** The Terminals sidebar lists running agents instead of cards, grouped by
  project and repo, with a live preview in the row menu (#416, #417, #419). Plain shells fold into
  their own section, or hide (#422), and agents can be pinned to the top (#424).
- **Fork or stop.** Right-click an agent to fork it or stop it (#425). Background `/fork` sessions,
  subagents and `/advices` runs show under the agent that started them, with their state, provider
  logo and age (#426, #427, #428).
- **Follow-ups.** An idle agent whose last reply lists follow-ups shows how many are left; selecting
  it lists them, and a click starts a new agent on one. Follow-ups untouched for a day move to a
  LEFT OVER section (#429).
- **Find a terminal.** Ctrl/⌘+P matches open terminals by name, agent session and folder;
  Ctrl/⌘+Shift+P lists only them and works from inside a shell (#434).
- **Project repos.** A project keeps a list of its repos, matched by git remote across machines.
  New cards file under the project listing their repo, and New terminal offers the project's repos
  first (#407).
- **Saved board views.** Save a board's filters as a named view, and open boards and views with
  `trame://board` and `trame://view` links (#406).
- **Back and forward everywhere.** Ctrl+Alt+←/→ walk back and forward from anywhere, a focused
  terminal included (#410).
- **PR chips.** PR and MR chips and their hover card show the GitHub or GitLab logo (#404).
- **Plugins** can read projects and use `EntityIcon` (#415).

## Fixes

- **Wayland.** No flicker when the window moves between screens of different scales (#405).
- **Builds.** Plugins rebuild with the fast local profile, and local AppImage builds skip copyright
  lookups (#431, #433).

## Upgrading

- **Protocol 10:** redeploy the hub first (`hub/deploy.sh`), then update every install.
- The macOS app and the AppImage update themselves; deb and snap installs get a link to the release.
