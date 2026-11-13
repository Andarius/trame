---
title: "v0.27.0 — Plugin page icons"
sidebar:
  label: "v0.27.0"
---

Plugins give the pages holding their blocks an icon, and sandboxed outputs render in the Linux
desktop app.

## Features

- **Plugin page icons.** A plugin declares an icon for the pages that hold one of its blocks; the
  sidebar shows it unless the page sets its own. Notebook cells (v0.3.0) uses it to mark pages
  with code cells with the Jupyter logo.

## Fixes

- Linux desktop: sandboxed `srcdoc` iframes load again instead of showing an empty white box, so
  plugin HTML, SVG and plotly outputs render.

## Upgrading

- No protocol or schema change: v0.14.0 to v0.27.0 nodes sync with each other.
- The macOS app and the AppImage update themselves; deb and snap installs get a link to the release.
