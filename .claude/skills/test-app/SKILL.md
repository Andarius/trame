---
name: test-app
description: Start, reload and stop the Trame desktop app built from the current checkout, on isolated dev data. Use when asked to open, run, launch or restart the test app, or to try a change in the desktop app.
---

# Test app

`just dev` builds the web bundle, then runs the Tauri desktop app from this checkout. The logo is tinted blue (debug build).
It uses isolated data in `.scratch/dev` (its own Postgres, offline, random port), never the user's real Trame on `~/.local/share/trame`.

## Start

Run it in the background; the first build takes a few minutes:

```bash
just dev > .scratch/test-app.log 2>&1
```

It is ready when the log prints `Tauri window navigated after backend bind`; wait for that line with a bounded loop, not repeated sleeps.
The backend port is in `.scratch/dev/port.json` (`jq -r .port .scratch/dev/port.json`).

## After a change

- Frontend only (`app/web/src`): `npm run build` in `app/web`, then ⌘R in the window. No restart needed.
- Rust (`crates/`): quit the window and run `just dev` again.

## Stop

Quitting the window stops the app and its backend, and hangs up any embedded terminals. Delete `.scratch/test-app.log` when done.

## Cautions

- Opening the dev port in another browser takes over any embedded terminal shown there: the desktop window then says "Opened in another window". Check `GET /api/term` (with the `x-trame-term` token from `GET /api/term/token`) before loading the page elsewhere.
- Seed test cards through the dev backend's API (`POST /api/sessions`), never with tramecli, which writes to the real app.
- Headless alternative for API or browser-only checks: `just serve` (same isolated data, no window).
