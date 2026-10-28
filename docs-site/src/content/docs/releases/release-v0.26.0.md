---
title: "v0.26.0 — Settings pages and plugin commands"
sidebar:
  label: "v0.26.0"
---

Settings becomes its own view, sidebar sections fold, Timeline joins the Sessions views, and plugins
add their own `tramecli` commands.

## Features

- **Settings view.** The gear opens a Settings view with its own sidebar: General, Agent presence,
  Sync hub, Plugins (one page per plugin), Embeds and Explore folders. It replaces the Settings,
  Plugins and plugin settings modals.
- **Fold sidebar sections.** Click a sidebar heading (Due, Working now, Recently modified, Starred,
  Projects, Shared with me, Unfiled, Databases) to hide its rows. Each section remembers its state.
- **Timeline in Sessions.** Timeline is a Sessions view next to Board, List and Graph, with the
  sidebar. `?view=timeline` links still work.
- **Plugin commands.** Plugins declare `tramecli <plugin> <command>` commands, which tramecli
  forwards to the running app. A plugin release adds commands without a tramecli rebuild.
- **Self-updating local builds.** An AppImage built with `tramecli plugins build` offers an update
  when Trame or an unpinned plugin has a new release, and **Update now** rebuilds and installs it.
  `tramecli plugins build` gains `--latest` and `--install=PATH`.

## Fixes

- `port.json` is written atomically, so `tramecli` never reads a half-written file.
- Bundled certificate trust roots are refreshed (webpki-roots 1.0.10, rustls-webpki 0.103.16).
  The hub image moves to Bun 1.4.4.

## Upgrading

- No protocol or schema change: v0.14.0 to v0.26.0 nodes sync with each other.
- The macOS app and the AppImage update themselves; deb and snap installs get a link to the release.
