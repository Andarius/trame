# session-tracker

A **local-first** Claude Code session tracker. Each session ladders up to an **Objective**;
the board is **columns (status) × swimlanes (objective)** — the view no off-the-shelf tool gave us.

Stack: **Deno-desktop** app → **local PGlite** (embedded Postgres, offline read+write) →
custom **push/pull LWW sync** → **Postgres on a home server** (the hub). No PowerSync, no Electric.
Everything is Postgres, so the SQL is identical on the laptop and the hub.

```
 laptop A (Deno app)                          laptop B (Deno app)
   ├─ local PGlite  ◀── read/write offline ──▶  local PGlite
   └─ sync.ts  ─┐                            ┌─ sync.ts
               push/pull (LWW by updated_at) │
                └────────▶  Postgres @ hub  ◀┘   (source of truth, Docker, home LAN)
 /project:track ─▶ hub Postgres if online, else local outbox.jsonl (app drains on launch)
```

## Requirements
- **Deno 2.9+** on each laptop (for `deno desktop`). Install: `curl -fsSL https://deno.land/install.sh | sh`.
- **Docker** on the hub machine.
- Laptops reach the hub's Postgres over the **home LAN** (no Tailscale required;
  the hub binds to its LAN IP — install Tailscale there if you want sync away from home).
- Node/npm is pulled in only to build the Vite frontend (via `deno task web:build`).

## Layout
```
db/schema.sql              shared schema (hub Postgres AND local PGlite)
hub/docker-compose.yml     Postgres hub
hub/deploy.sh              deploy the hub over ssh (~/Apps/tracker) — `just db-deploy`
app/                       Deno-desktop app
  main.ts                  window + in-process HTTP (serves UI + /api), startup sync loop
  db.ts                    local PGlite + queries + outbox drain
  sync.ts                  custom LWW push/pull to the hub
  config.ts                env config (NODE_ID, REMOTE_PG, data dir…)
  web/                     React swimlane board (Vite)
track/track.ts             the /project:track writer (hub PG or outbox)
commands/project/track.md  rewired slash command (copy to ~/.claude/… when live)
```

## Setup

### 1. The hub
```bash
just db-deploy       # ssh: copies compose+schema to ~/Apps/tracker, creates .env, starts it
```
First run generates the password and binds to the hub's LAN IP (never 0.0.0.0); the
script prints the `TRACKER_REMOTE_PG` URL to use on laptops. Idempotent — rerun to redeploy.

### 2. Each laptop — env (add to your shell profile, or the project `.env` for `just`)
```bash
export TRACKER_NODE_ID="mbp-14"                                   # unique per machine
export TRACKER_REMOTE_PG="postgres://tracker:PASSWORD@192.168.1.152:5433/tracker"  # printed by db-deploy
# folders scanned (depth 4) for *.html exploration reports, shown+searchable in Explore
export TRACKER_REPORT_PATHS="$HOME/Projects:$HOME/LLMS"
```

Window size/position is persisted automatically (`~/.local/share/session-tracker/window.json`).

### 3. Run the app
```bash
cd app
deno task web:build     # build the React frontend → web/dist
deno task dev           # opens the desktop window (Deno 2.9+)
# no desktop subcommand yet? →  deno task serve   then open http://localhost:8787
# frontend dev with HMR:        deno task web:dev  (proxies /api to :8787)
```

### 4. Wire `/project:track`
```bash
cp commands/project/track.md ~/.claude/commands/project/track.md
```
Then `/project:track` (or `/project:track paused|blocked|done "note"`) from any repo writes here
instead of Anytype. (Leave the Anytype command in place until you're happy with this.)

## How sync works
- Every row has `updated_at` (LWW clock), `origin` (which node wrote it), `deleted` (soft delete).
- **Pull**: remote rows with `updated_at >` last-pull → upsert locally *if newer*.
- **Push**: local rows where `origin = this node` and `updated_at >` last-push → upsert to the hub *if newer*.
- Single user ⇒ conflicts are near-impossible and last-write-wins is correct.

## v0 caveats (deliberately a scaffold)
- **Deno desktop is new** (2.9+). `deno task dev` runs `deno desktop --hmr -A main.ts`; plain
  `deno desktop main.ts` *builds* a bundle instead of running. `deno task serve` is the browser fallback.
- **HMR reloads the UI, not new API routes** — after adding backend endpoints, restart `just dev`.
  Frontend (`web/dist`) is read per-request, so `just web-build` refreshes the window live.
- **Sync is LWW, not CRDT.** Fine for one user; if you ever go multi-user, swap in `cr-sqlite`.
- **Offline `/project:track`** queues only session fields to the outbox; client/objective-by-name
  resolution happens only on the online path (see `db.ts` note).
- **Auth** = Tailscale + the Postgres password. No app-level users (single user).

## Packaging & releases

Mirrors the scw-secrets-desktop pipeline: push a `v*` tag (matching `app/deno.json` `version`) →
GitHub Actions builds and attaches to the release:
- **Linux**: `Trame.AppImage`, `trame.deb`, and a **`.snap`** (classic; install via
  `bin/snap-install-release.sh` → `snap install --dangerous --classic`)
- **macOS**: `Trame.dmg` for arm64 + x64 (ad-hoc signed — first launch needs
  right-click → Open, or `xattr -dr com.apple.quarantine /Applications/Trame.app`;
  proper signing/notarization needs an Apple Developer identity in `desktop.macos.codesignIdentity`)

Assets (`web/dist`, `db/schema.sql`) are **embedded into the binary** via raw imports
(`scripts/gen-embed.ts`, regenerated by `just web-build`) — bundles run from anywhere with no
disk layout. Local builds: `just bundle` (AppImage), `deno task bundle:mac` (on a Mac).

## Status (2026-07-06 — first real run on this box)

Ran end-to-end headless (`deno task serve` → http://localhost:8787), offline-only (no hub).

**Verified working:**
- `deno task web:build` — Vite build + `gen-embed.ts` (assets embedded into the binary).
- `deno check main.ts ../track/track.ts ../mcp/server.ts` — clean (run from `app/`; needs the
  `raw-imports` unstable flag, which `app/deno.json` supplies).
- `deno task serve` — boots, creates the local PGlite db, serves UI + all `/api/*` routes.
- Write path: `just track` (the `/project:track` writer) → PGlite → shows up on `/api/board`
  and renders as a card on the board.
- The board UI renders (Board/List toggle, swimlane grouping, Import-from-Claude, Sync-now).
- **Drag-between-columns is wired** (`@dnd-kit` in `Board.tsx`) — the README's old "drag isn't
  wired" caveat was stale.
- A **session Drawer** exists (`Drawer.tsx`: fields, logs, events) — the old "add an Objective
  drawer" next-step is largely done.
- **User databases** (`app/web/src/udb/*`), Projects and Pages sections in the sidebar — beyond
  the original v0 scope described above.

**Still to do / not exercised here:**
1. **`deno task dev`** (the actual desktop window). The `deno desktop` subcommand exists in 2.9.1;
   only the browser (`serve`) path has been driven so far — try the real window next.
2. **Hub + sync.** No `TRACKER_REMOTE_PG` set and no Postgres hub deployed, so `just db-deploy`,
   the push/pull sync loop, and the "Sync now" button are untested end-to-end. Needs the hub up.
3. **Packaging.** `just bundle` / `deno task bundle:mac` (and the tag-driven GitHub Actions
   release) not run on this box yet.
4. **Wire `/project:track` for real** — `just install-cmd` copies the slash command into
   `~/.claude`; not yet installed here.
