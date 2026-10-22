---
title: "v0.21.1 — Terminal grouping and trame:// repair"
sidebar:
  label: "v0.21.1"
---

Groupable sidebar lists, terminals tied to a project, and AppImage installs that repair their own
`trame://` links.

## Features

- **Grouping menus.** The Terminals column groups by project, by status or not at all; the DUE list
  groups by project or by date. The choice sticks.
- **New terminal dialog.** Pick what to run (a shell or an agent), the project, then the folder: here,
  one of the project's folders, or any folder through the system file picker. Last picks are
  remembered. Right-click a project in the Terminals column to open a shell in it.
- **Project shells.** A shell can belong to a project without a card; it lists under that project.
- **Drag a card into the terminal area** to show its shell, or beside a pane to split. A card without a
  shell gets a new one in its repo.
- **Reply** on selected terminal text pastes it as a `> ` quote into the prompt; **Copy** copies it.
- Working now uses clearer PR and terminal icons.

## Fixes

- AppImage: on launch, the menu entry and the `trame://` handler are rewritten when missing or
  outdated (installs from before v0.21.0 had no handler), and a `~/.local/bin/tramecli` installed as
  a plain file is replaced by the bundled CLI. Symlinked CLIs are left alone.

## Upgrading

- No protocol or schema change: v0.14.0 to v0.21.1 nodes sync with each other.
- The macOS app and the AppImage update themselves; deb and snap installs get a link to the release.
- Installed agent skills still update with `tramecli setup`.
