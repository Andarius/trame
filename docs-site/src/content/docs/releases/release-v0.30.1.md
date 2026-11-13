---
title: "v0.30.1 — Faster local builds"
sidebar:
  label: "v0.30.1"
---

Local packaging rebuilds in seconds, and macOS syncs with a self-hosted hub again.

## Fixes

- **Hub certificates macOS accepts.** `gen-certs.sh` now issues 825-day server certificates with the
  `serverAuth` usage; macOS refused the old ones, so desktop sync failed every pass (#350). On a
  running hub, remove `certs/server.{crt,key}` and rerun the script: the CA is unchanged.

## Developer

- **Faster local packaging.** `just bundle`, `just bundle-appimage` and `just compile-cli` skip LTO and
  keep incremental builds: a release rebuild after a small edit drops from ~75 s to ~6 s (#351). CI,
  `bin/quickstart.sh` and `tramecli plugins build` keep the shipped release profile; set
  `TRAME_FULL_RELEASE=1` to get it locally.
- Releases publish only on manual dispatch (#349).
