---
title: "v0.34.1 — Check for updates"
sidebar:
  label: "v0.34.1"
---

Settings finds a new release as soon as it is out.

## Fixes

- **Check for updates.** Opening Settings → General asks GitHub for the latest release instead of
  reusing the answer from the last hour, so it no longer says "up to date" right after a release. A
  **check now** link next to the version does the same on demand (#389).

## Upgrading

- No protocol or schema change from v0.34.0.
- The macOS app and the AppImage update themselves; deb and snap installs get a link to the release.
