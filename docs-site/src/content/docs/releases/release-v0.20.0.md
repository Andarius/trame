---
title: "v0.20.0 — Terminal panel and Working now"
sidebar:
  label: "v0.20.0"
---

A terminal now lives inside Trame: run a shell or a coding agent next to its card, in splits, with
your own Ghostty look.

## Features

- **Terminal panel.** **Ctrl+`** opens a terminal at the bottom of the window, running your login
  shell; **Ctrl+Shift+`** (or ⤢) lets it fill the view. Tabs split with **⌘D** / **⌘⇧D**, and
  dragging a tab onto a pane's edge adds it to that layout. Shells keep running and come back after a
  reload, but end when the app quits.
- **Agents in the panel.** The **+** menu starts a new shell or any agent CLI installed for you:
  Claude Code, Codex, Gemini, Antigravity, Mistral Vibe. **Open in agent → Trame terminal** on a card
  starts or resumes its agent there.
- **Terminals view.** Cards with live shells, grouped by project, with the card's tabs in the middle
  and its next step, specs and activity beside them. Board cards show a marker while a shell runs for
  them.
- **Looks like your terminal.** When Ghostty is installed, the panel uses its font, size and colors;
  each tab shows the icon of the project it belongs to, and Trame links in the output open in the app.
- **Missing folders.** A card created on another machine opens in the same folder under this home,
  and one whose worktree is gone opens in its repo. Otherwise a dialog offers to choose a folder
  (remembered per repo on this machine), clone the repo from the card's PR, or use the home folder.
- **Working now.** The sidebar's running list becomes a tree, like Claude Code's session list: story,
  then card, then the card's live agent, its forks and its shells. What needs you comes first; a
  collapsed story keeps a yellow dot while something under it waits. A session started from another
  card's work nests under that card when it links that card's spec page.
- **Presence hooks.** The desktop app installs the Claude Code and Codex presence hooks at launch, so
  agent pills appear without running `tramecli setup --presence`.
- **AI Sessions view:** a Live section lists the agents working now (state, step or question,
  elapsed), and a row opens its card. Copying a resume command highlights and unfolds its row for a
  minute.
- **Inline databases** show their SQL source actions in edit mode, and their column menu is no longer
  clipped by a short table.
- **Smaller packages:** deb 51 → 15 MB, snap 189 → 16 MB, AppImage 138 → 94.5 MB, from a pruned
  PostgreSQL, stripped binaries and dropping libraries the snap never loaded.

## Security

- The terminal answers only the Trame page that loaded it: a per-launch token, never stored, guards
  every terminal request.
- Report pages (`/report/…`, report files) are now served sandboxed, so their scripts can't call the
  local API.
- Shells don't inherit an agent session's environment when Trame itself was started from one, so an
  agent started in the panel uses your own login.

## Under the hood

- Deno is gone: the retained TypeScript backend, CLI and MCP server are removed (the native `tramecli`
  replaced them), the hub API and scripts run on Bun, CI lints with oxlint, and the web app moves to
  React 19.

## Upgrading

- No protocol or schema change: v0.14.0 to v0.20.0 nodes sync with each other.
- The PGlite migration helper is no longer bundled. An install whose data is still in PGlite
  refuses to start: run Trame v0.19.x once to migrate it, then upgrade.
- Self-hosted hub: the next `just db-deploy` ships the Bun image; the sync protocol is unchanged, so
  nodes keep syncing with a hub on either runtime.
- The macOS app and the AppImage update themselves; deb and snap installs get a link to the release.
