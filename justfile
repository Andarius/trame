set quiet
set positional-arguments
set dotenv-filename := ".env"
set dotenv-required := false

# Pinned sqlfluff (rule sets change between versions; keep local == CI)
sqlfluff := "sqlfluff@4.2.2"

# List available recipes
default:
    @just --list

# Bring up the hub + build the frontend (then `just dev`)
up: db web-build

# Postgres hub (hub/docker-compose.yml) — local for testing
[group('infra')]
db:
    cd hub && ./gen-certs.sh init 127.0.0.1 localhost
    docker compose -f hub/docker-compose.yml up -d

# Deploy the Postgres hub over ssh (~/Apps/tracker) and start it — host via TRACKER_HUB_HOST in .env
[group('infra')]
db-deploy host=env_var_or_default('TRACKER_HUB_HOST', 'hub'):
    hub/deploy.sh {{ host }}

# Fetch the hub's ca.crt so this laptop trusts the hub API's TLS
[group('infra')]
hub-ca host=env_var_or_default('TRACKER_HUB_HOST', 'hub'):
    hub/fetch-ca.sh {{ host }}

# Any docker compose command against the local hub: `just infra down`, `just infra logs -f`, `just infra ps`…
[group('infra')]
infra *args:
    docker compose -f hub/docker-compose.yml "$@"

# psql into the hub over ssh (Postgres has no host port since the API cutover)
[group('infra')]
psql host=env_var_or_default('TRACKER_HUB_HOST', 'hub'):
    ssh -t {{ host }} docker exec -it tracker-db psql -U tracker -d tracker

# Run the desktop app (Deno 2.9+)
[group('dev')]
dev:
    cd app && deno task dev

# Run headless — open http://localhost:8787 in a browser
[group('dev')]
serve:
    cd app && deno task serve

# Build a distributable desktop app (Linux .AppImage; .app/.dmg on macOS).
# Depends on web-build: a stale embed.ts would silently ship an old UI.
[group('dev')]
bundle: web-build
    cd app && deno task bundle

# Build the React frontend into app/web/dist
[group('dev')]
web-build:
    cd app && deno task web:build

# Frontend dev server with HMR (proxies /api to :8787)
[group('dev')]
web-dev:
    cd app && deno task web:dev

# Full hot-reload loop: backend --watch (real restarts, new routes included) + Vite HMR.
# Open http://localhost:5173 — close the desktop app first (it holds the local db).
[group('dev')]
hack:
    #!/usr/bin/env bash
    set -euo pipefail
    trap 'kill 0' EXIT
    (cd app && deno run --watch=.,../db --watch-exclude=web/test-results,web/dist,web/node_modules -A main.ts) &
    (cd app/web && npm run dev) &
    wait

# Run one sync pass (local PGlite <-> hub Postgres)
[group('dev')]
sync:
    cd app && deno task sync

# Run the Deno unit tests (isolated PGlite in a temp dir)
[group('dev')]
test *args:
    cd app && deno test -A {{ args }}

# Run Playwright e2e tests (isolated backend in /tmp/trame-e2e)
[group('dev')]
e2e *args:
    cd app/web && npx playwright test {{ args }}

# Lint (TS + SQL schema)
[group('dev')]
lint: lint-sql
    cd app && deno lint

# Lint the SQL schema (sqlfluff, via uvx — no install needed)
[group('dev')]
lint-sql:
    uvx {{ sqlfluff }} lint db/schema.sql

# Format (TS + SQL schema, in place)
[group('dev')]
fmt: fmt-sql
    cd app && deno fmt

# Format the SQL schema in place (sqlfluff)
[group('dev')]
fmt-sql:
    uvx {{ sqlfluff }} format db/schema.sql

# Verify the SQL schema is already formatted (non-mutating; fails on drift)
[group('dev')]
fmt-check-sql:
    uvx {{ sqlfluff }} format - < db/schema.sql | diff -u db/schema.sql - && echo "schema.sql formatted ✓"

# Type check the entry graphs
[group('dev')]
check:
    cd app && deno check main.ts ../track/track.ts ../track/page.ts ../track/comment.ts ../track/watch.ts ../track/cli.ts ../mcp/server.ts

# The hub API is its own Deno project (own deps) — check/test/lint it too (matches CI)
[group('dev')]
check-hub:
    cd hub/api && deno check main.ts && deno test -A && deno lint

# Lint + format-check + type check + unit tests (app + hub)
[group('dev')]
ci: lint fmt-check-sql check test check-hub

# Compile tramecli into dist/tramecli — everything agent-facing lives in that binary
# (track/page/comment/watch/answer/list/setup/mcp); dev checkouts without one on PATH
# get it compiled by the install recipes below.
[group('track')]
compile-cli:
    cd app && deno task compile:cli

# Install the agent command/skills from a fresh build (interactive picker;
# or pass flags: `just setup --claude --codex --skills-dir ~/.gemini/skills`)
[group('setup')]
setup *args:
    cd app && deno task compile:cli
    ./dist/tramecli setup "$@"

# Wipe the local PGlite data + outbox (fresh local db)
[group('setup')]
reset-local:
    rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/trame"
    echo "local data cleared"

# Enable the git pre-commit hook (lint + typecheck on staged code)
[group('dev')]
hooks:
    git config core.hooksPath .githooks
    @echo "pre-commit hook enabled (.githooks). Bypass a commit with --no-verify."

# Seed + serve an isolated demo instance on :8799 (fictional data — the README screenshots)
[group('docs')]
demo:
    #!/usr/bin/env bash
    set -euo pipefail
    dir=/tmp/trame-demo
    rm -rf "$dir"; mkdir -p "$dir/claude-projects"
    # blank hub API explicitly: just loads .env, and demo data must never reach a real hub
    export TRACKER_HUB_API= TRACKER_HUB_API_TOKEN= TRACKER_NODE_ID=demo TRACKER_UPDATE_CHECK=0
    export TRACKER_PORT=8799 TRACKER_HOST=127.0.0.1
    export TRACKER_DATA_DIR="$dir/pglite" TRACKER_PORT_FILE="$dir/port.json"
    export TRACKER_SETTINGS_FILE="$dir/settings.json" TRACKER_OUTBOX="$dir/outbox.jsonl"
    export TRACKER_CLAUDE_DIR="$dir/claude-projects"
    trap 'kill 0' EXIT
    (cd app && deno run -A main.ts) &
    until curl -sf http://127.0.0.1:8799/api/status >/dev/null 2>&1; do sleep 1; done
    DEMO_CLAUDE_DIR="$dir/claude-projects" TRAME_URL=http://127.0.0.1:8799 \
      deno run --config app/deno.json -A scripts/demo-seed.ts
    echo "demo → http://127.0.0.1:8799  (ctrl-c to stop)"
    wait

# Serve the docs site with HMR (Astro + Starlight, http://localhost:4321)
[group('docs')]
docs:
    cd docs-site && npm install && npm run dev

# Build the static docs site into docs-site/dist
[group('docs')]
docs-build:
    cd docs-site && npm install && npm run build
