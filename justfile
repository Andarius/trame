set quiet
set positional-arguments
set dotenv-filename := ".env"
set dotenv-required := false

# List available recipes
default:
    @just --list

# Bring up the hub + build the frontend (then `just dev`)
up: db web-build

# Postgres hub (hub/docker-compose.yml) — local for testing
[group('infra')]
db:
    docker compose -f hub/docker-compose.yml up -d

# Deploy the Postgres hub over ssh (~/Apps/tracker) and start it — host via TRACKER_HUB_HOST in .env
[group('infra')]
db-deploy host=env_var_or_default('TRACKER_HUB_HOST', 'hub'):
    hub/deploy.sh {{ host }}

# Stop the Postgres hub
[group('infra')]
db-down:
    docker compose -f hub/docker-compose.yml down

# Tail the Postgres hub logs
[group('infra')]
db-logs:
    docker compose -f hub/docker-compose.yml logs -f

# psql into the hub (uses TRACKER_REMOTE_PG)
[group('infra')]
psql:
    psql "${TRACKER_REMOTE_PG:?set TRACKER_REMOTE_PG in .env}"

# Run the desktop app (Deno 2.9+)
[group('dev')]
dev:
    cd app && deno task dev

# Run headless — open http://localhost:8787 in a browser
[group('dev')]
serve:
    cd app && deno task serve

# Build a distributable desktop app (Linux .AppImage; .app/.dmg on macOS)
[group('dev')]
bundle:
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
    (cd app && deno run --watch=.,../db -A main.ts) &
    (cd app/web && npm run dev) &
    wait

# Run one sync pass (local PGlite <-> hub Postgres)
[group('dev')]
sync:
    cd app && deno task sync

# Run Playwright e2e tests (isolated backend in /tmp/trame-e2e)
[group('dev')]
e2e *args:
    cd app/web && npx playwright test {{ args }}

# Lint
[group('dev')]
lint:
    cd app && deno lint

# Format
[group('dev')]
fmt:
    cd app && deno fmt

# Type check the entry graphs
[group('dev')]
check:
    cd app && deno check main.ts ../track/track.ts ../mcp/server.ts

# Run the Trame MCP server on stdio (for `claude mcp add trame -- deno run -A .../mcp/server.ts`)
[group('dev')]
mcp:
    deno run -A mcp/server.ts

# Lint + type check
[group('dev')]
ci: lint check

# Run the session writer (JSON as arg or on stdin)
[group('track')]
track *args:
    deno run --allow-all track/track.ts "$@"

# Install the /project:track slash command into ~/.claude
[group('setup')]
install-cmd:
    mkdir -p ~/.claude/commands/project
    cp commands/project/track.md ~/.claude/commands/project/track.md
    echo "installed → ~/.claude/commands/project/track.md"

# Wipe the local PGlite data + outbox (fresh local db)
[group('setup')]
reset-local:
    rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/session-tracker"
    echo "local data cleared"
