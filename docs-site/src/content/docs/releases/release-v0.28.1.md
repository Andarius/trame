---
title: "v0.28.1 — Resume from AI Sessions"
sidebar:
  label: "v0.28.1"
---

AI Sessions resumes a session the same ways a card does, and plugin rebuilds find npm from nvm.

## Features

- **Resume from AI Sessions.** Each session has the card's Resume button: new window, new tab,
  existing konsole, desktop app or Trame terminal. ▾ picks another way, ⧉ still copies the command,
  and the last pick is shared with the card. Desktop app is off for Claude sessions, since Claude
  Desktop can't resume a CLI session.

## Fixes

- AppImage: "Update now" no longer fails with `building needs npm on PATH` when npm comes from nvm or
  another shell-profile setup. The rebuild now also looks on the login shell's `PATH`.

## Upgrading

- No protocol or schema change: v0.14.0 to v0.28.1 nodes sync with each other.
- The macOS app and the AppImage update themselves; deb and snap installs get a link to the release.
