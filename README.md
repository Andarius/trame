# session-tracker

A **local-first** Claude Code session tracker. Each session ladders up to a **story** (grouped
under a **project**); the board is **status columns × swimlanes** — the view no off-the-shelf
tool gave us. It also holds free-form **pages** and **Notion-style databases**.

Stack: **Deno-desktop** app → **local PGlite** (embedded Postgres, offline read+write) →
custom **push/pull LWW sync** → **Postgres on a home server** (the hub). No PowerSync, no Electric.
Everything is Postgres, so the SQL is identical on the laptop and the hub.

```
 laptop A (Deno app)                          laptop B (Deno app)
   ├─ local PGlite  ◀── read/write offline ──▶  local PGlite
   └─ sync.ts  ─┐                            ┌─ sync.ts
               push/pull (LWW by updated_at) │
                └────────▶  Postgres @ hub  ◀┘   (source of truth, Docker, home LAN)
 /trame:track ─▶ hub Postgres if online, else local outbox.jsonl (app drains on launch)
```

## Demo

![Trame walkthrough](docs/demo.gif)

> A short tour: filter the board by story, regroup into swimlanes, open a session and
> **resume it in Claude Code**, sort the list, then browse a page and a database.
> ([higher-quality MP4](docs/demo.mp4) · screens use demo data)

| Kanban board — status columns | Swimlanes — group by project or story |
| :--- | :--- |
| [![board](docs/board.png)](docs/board.png) | [![grouped board](docs/board-grouped.png)](docs/board-grouped.png) |
| **Session drawer — resume in Claude Code** | **Sortable list view** |
| [![drawer](docs/drawer.png)](docs/drawer.png) | [![list](docs/list.png)](docs/list.png) |
| **Pages — notes & docs next to the work** | **Databases — Notion-style tables** |
| [![page](docs/page.png)](docs/page.png) | [![database](docs/database.png)](docs/database.png) |

## Requirements
- **Deno 2.9+** on each laptop (for `deno desktop`). Install: `curl -fsSL https://deno.land/install.sh | sh`.
- **Docker + openssl** on the hub machine (certs are generated there; the CA key never leaves it).
- Laptops reach the hub's Postgres over the **home LAN** (no Tailscale required;
  the hub binds to its LAN IP — install Tailscale there if you want sync away from home).
- Node/npm is pulled in only to build the Vite frontend (via `deno task web:build`).

## Layout
```
db/schema.sql              shared schema (hub Postgres AND local PGlite)
hub/docker-compose.yml     Postgres hub (TLS-only, mTLS + scram)
hub/deploy.sh              deploy the hub over ssh (~/Apps/tracker) — `just db-deploy`
hub/gen-certs.sh           CA + server/client certs, runs on the hub (called by deploy)
hub/issue-cert.sh          fetch this laptop's client cert — `just db-cert`
hub/pg_hba.conf            hub auth rules: TLS + client cert + password, or reject
app/                       Deno-desktop app
  main.ts                  window + in-process HTTP (serves UI + /api), startup sync loop
  db.ts                    local PGlite + queries + outbox drain
  sync.ts                  custom LWW push/pull to the hub
  config.ts                env config (NODE_ID, REMOTE_PG, data dir…)
  web/                     React swimlane board (Vite)
track/track.ts             the /trame:track writer (hub PG or outbox)
commands/trame/track.md    the /trame:track slash command (copy to ~/.claude/…)
```

## Setup

### 1. The hub
```bash
just db-deploy       # ssh: copies compose+schema+hba to ~/Apps/tracker, creates .env+certs, starts it
just db-cert         # per laptop: issue + fetch this machine's client cert (mTLS)
```
First run generates the password, the CA/server certs, and binds to the hub's LAN IP
(never 0.0.0.0); the script prints the `TRACKER_REMOTE_PG` URL to use on laptops.
Idempotent — rerun to redeploy. `just db-cert` installs `ca.crt`/`client.crt`/`client.key`
into `~/.local/share/session-tracker/certs/`, where sync and `just psql` pick them up.

### 2. Each laptop — env (add to your shell profile, or the project `.env` for `just`)
```bash
export TRACKER_NODE_ID="mbp-14"                                   # unique per machine
export TRACKER_REMOTE_PG="postgres://tracker:PASSWORD@192.168.1.152:5433/tracker"  # printed by db-deploy
# folders scanned (depth 4) for *.html reports + *.excalidraw drawings, shown+searchable in Explore
export TRACKER_REPORT_PATHS="$HOME/Projects:$HOME/LLMS"
```
The hub URL can also be set **from the app**: ⚙ Settings → Sync hub — URL and password are
separate fields (paste the full printed URL and the password auto-moves to the masked field).
Stored per-machine in `settings.json` (chmod 600), overrides the env var, applies on the next
sync pass — no restart. The password is never sent back to the UI.

### 3. Run the app
```bash
cd app
deno task web:build     # build the React frontend → web/dist
deno task dev           # opens the desktop window (Deno 2.9+)
# no desktop subcommand yet? →  deno task serve   then open http://localhost:8787
# frontend dev with HMR:        deno task web:dev  (proxies /api to :8787)
```

### 4. Wire `/trame:track`
`/trame:track` is a Claude Code slash command that records the current session as a card on
the board — it reads the repo, branch, and a one-line note from the conversation and writes
straight to your local PGlite (syncing to the hub when online, else queued in the outbox).
Install it into Claude Code:
```bash
cp commands/trame/track.md ~/.claude/commands/trame/track.md
```
Then from any repo: `/trame:track` to log the session, or
`/trame:track paused|blocked|done "note"` to set its status with a note.

## How sync works
- **Transport**: mutual TLS — the hub only accepts connections presenting a client cert
  signed by its private CA (CN = laptop node-id) *and* the scram password; laptops verify
  the hub's cert (`tracker-hub` SAN). Plaintext connections are rejected outright.

```mermaid
flowchart LR
    subgraph laptop [Laptop — each machine]
        app[Deno desktop app] --> pgl[(local PGlite<br/>offline read/write)]
        pgl <--> sync[sync.ts<br/>LWW push/pull]
        certs[certs dir — just db-cert<br/>client.crt CN=node-id<br/>client.key + ca.crt]
    end
    subgraph hub [Hub — home server, Docker]
        hba[pg_hba: hostssl + scram<br/>+ clientcert=verify-ca<br/>anything else: reject] --> pg[(Postgres 18<br/>LAN IP only)]
        ca[private CA<br/>key never leaves the hub]
    end
    sync <==>|TLS 1.3 — laptop checks the tracker-hub SAN,<br/>hub checks the CA-signed client cert,<br/>scram password inside the tunnel| pg
    ca -. issues client certs<br/>ssh, once per laptop .-> certs
```
- Every row has `updated_at` (LWW clock), `origin` (which node wrote it), `deleted` (soft delete).
- **Pull**: remote rows with `updated_at >` last-pull → upsert locally *if newer*.
- **Push**: local rows where `origin = this node` and `updated_at >` last-push → upsert to the hub *if newer*.
- Single user ⇒ conflicts are near-impossible and last-write-wins is correct.

## Packaging & releases

Push a `v*` tag (matching `app/deno.json` `version`) and GitHub Actions builds the desktop
apps and attaches them to the [release](https://github.com/Andarius/trame/releases):

| Platform | Assets | First launch |
| :--- | :--- | :--- |
| **Linux** | `Trame.AppImage`, `trame.deb`, `.snap` (classic) | snap: `bin/snap-install-release.sh` → `snap install --dangerous --classic` |
| **macOS** | `Trame.dmg` (Apple Silicon) | ad-hoc signed — right-click → **Open**, or `xattr -dr com.apple.quarantine /Applications/Trame.app` |

> Proper macOS signing/notarization needs an Apple Developer identity in
> `desktop.macos.codesignIdentity`.

Assets (`web/dist`, `db/schema.sql`) are **embedded into the binary** via raw imports
(`scripts/gen-embed.ts`, regenerated by `just web-build`) — bundles run from anywhere with no
disk layout. Local builds: `just bundle` (AppImage), `deno task bundle:mac` (on a Mac).
