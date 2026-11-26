---
title: "v0.35.5 — Agents across devices"
sidebar:
  label: "v0.35.5"
---

The agents sidebar shows what runs on your other devices, forks and Codex workers under their agent, and one project's tabs at a time.

## Features

- **Other devices.** An ON <device> section lists the agents running in Trame on your other machines, by project,
  with a laptop, desktop or server icon; it needs the Rust hub, which now runs beside the Bun one (#478, #493, #503).
- **Forks and workers.** A `/fork` hangs off its agent with a └ and a "fork" label, and `codex exec` runs started
  by an agent show under it as workers; agent rows show their model (#485, #499).
- **Tabs by project.** Selecting an agent, card or project shows every tab of that project, and only those (#500).
- **Needs you.** Waiting agents stay in their project, counted in the AGENTS and project headers (#490).
- **Project windows.** A project's own window gets the dock's tabs and splits (#475).
- **Recent.** The Recent section folds (#495).
- **Telegram.** Scheduled due digests on Telegram and a Mini App to read and schedule them (#476, #477, #479, #498).

## Fixes

- **Codex.** Codex no longer shows a blank screen in a Trame shell (#486).
- **Resizing.** A maximized or fullscreen window resizes its shells at once (#487).
- **Selection.** Selecting text no longer pops a Copy / Reply bubble; it is opt-in in Settings (#501).
- **gh/glab.** Resolved from the login-shell PATH (#496).

## Other

- Landing page, install-first README and SECURITY.md (#484); dependency updates (#489).
