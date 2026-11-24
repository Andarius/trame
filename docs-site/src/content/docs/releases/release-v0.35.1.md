---
title: "v0.35.1 — Usage footer and follow-up progress"
sidebar:
  label: "v0.35.1"
---

The agents sidebar shows your plan usage, and follow-ups show how far the agents started on them got.

## Features

- **Usage footer.** The Terminals column ends with each tool's most-used plan window (amber from
  80%, red from 95%), this machine's name and how many hosts sync with it. Set `usageCommand` in
  `settings.json` to a command printing the usage, for example `choub usage --json` (#437).
- **Follow-up progress.** A follow-up you start an agent on shows that agent's state: running,
  waiting, idle or done. Clicking a started one shows its agent, and a bar beside "N left" tracks
  the progress (#438).

## Fixes

- **Split layout.** Quitting Trame no longer loses the dock's splits: the shells reopen in the
  panes they were in (#439).
- **Tab names.** Long tab names are cut with an ellipsis instead of stretching across the strip (#441).
- A project's `+` is centered with its count, and menus are no longer crossed by the sidebar's
  scrollbar in the desktop app (#437).
