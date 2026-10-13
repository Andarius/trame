---
title: "v0.16.0 — clean shutdown and relaunch"
sidebar:
  label: "v0.16.0"
---

Fixes for quitting and relaunching the native app.

## Fixes

- **AppImage survives a scope stop.** Stopping the app's systemd scope (logout,
  `systemctl --user stop`) also signalled the AppImage runtime, which unmounted the image
  while the app and PostgreSQL still ran from it; both died of SIGBUS and PostgreSQL needed
  crash recovery on the next start. The runtime now runs in its own scope and unmounts once
  the app has exited.
- **Quit no longer waits on a hung `gh`/`glab` call.** Shutdown drains background work, and
  forge CLI calls had no time limit; they now stop after 30 seconds.
- **Relaunching right after quit works.** The app waits up to 15 seconds for the previous
  instance to release its data directory instead of failing with "root is already running or
  migrating".

## Upgrading

- No protocol or schema change: v0.14.0 to v0.16.0 nodes sync with each other.
