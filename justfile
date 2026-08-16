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

# Issue + fetch this laptop's client cert from the hub (the CA key never leaves it)
[group('infra')]
db-cert node_id=env_var_or_default('TRACKER_NODE_ID', `hostname`) host=env_var_or_default('TRACKER_HUB_HOST', 'hub'):
    hub/issue-cert.sh {{ node_id }} {{ host }}

# Stop the Postgres hub
[group('infra')]
db-down:
    docker compose -f hub/docker-compose.yml down

# Tail the Postgres hub logs
[group('infra')]
db-logs:
    docker compose -f hub/docker-compose.yml logs -f

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
    cd app && deno check main.ts ../track/track.ts ../track/page.ts ../track/comment.ts ../track/watch.ts ../mcp/server.ts

# The hub API is its own Deno project (own deps) — check/test/lint it too (matches CI)
[group('dev')]
check-hub:
    cd hub/api && deno check main.ts && deno test -A && deno lint

# Run the Trame MCP server on stdio (for `claude mcp add trame -- deno run -A .../mcp/server.ts`)
[group('dev')]
mcp:
    deno run -A mcp/server.ts

# Lint + format-check + type check + unit tests (app + hub)
[group('dev')]
ci: lint fmt-check-sql check test check-hub

# Run the session writer (JSON as arg or on stdin)
[group('track')]
track *args:
    deno run --allow-all track/track.ts "$@"

# Create a Trame page (JSON as arg or on stdin)
[group('track')]
page *args:
    deno run --allow-all track/page.ts "$@"

# Add an agent comment to a Trame page (JSON as arg or on stdin)
[group('track')]
comment *args:
    deno run --allow-all track/comment.ts "$@"

# Watch agent threads and auto-answer human replies (codex/claude)
[group('track')]
watch *args:
    deno run --allow-all track/watch.ts "$@"

# Install the /trame:track slash command + trame-page skill into ~/.claude
[group('setup')]
install-cmd:
    deno run --config app/deno.json -A scripts/install-track.ts --target claude

# Install the native Trame skills for Codex (available from every repository)
[group('setup')]
install-skill:
    deno run --config app/deno.json -A scripts/install-track.ts --target codex

# Choose Claude Code, Codex, or both interactively
[group('setup')]
install-track:
    deno run --config app/deno.json -A scripts/install-track.ts

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
    # blank REMOTE_PG explicitly: just loads .env, and demo data must never reach a real hub
    export TRACKER_REMOTE_PG= TRACKER_NODE_ID=demo TRACKER_UPDATE_CHECK=0
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

# Read a doc in the terminal with glow. No arg = browse; `just docs-read hub-api` opens one
[group('docs')]
docs-read doc='':
    #!/usr/bin/env bash
    set -euo pipefail
    command -v glow >/dev/null || { echo "glow not installed — see https://github.com/charmbracelet/glow (or open docs-site/src/content/docs in your editor)" >&2; exit 1; }
    dir=docs-site/src/content/docs
    doc="{{ doc }}"
    if [ -z "$doc" ]; then
        glow "$dir"
    else
        f=$(find "$dir" -name "${doc%.md}.md" -print -quit)
        [ -n "$f" ] || { echo "no such doc: $doc" >&2; exit 1; }
        glow -p "$f"
    fi
