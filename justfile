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

# Build the public link viewer bundle + regenerate hub/api/link-embed.ts
[group('infra')]
link-build:
    cd app/web && npm install && npm run build:link
    deno run -A scripts/gen-link-embed.ts

# Deploy the Postgres hub over ssh (~/Apps/trame) and start it — host via TRACKER_HUB_HOST in .env
[group('infra')]
db-deploy host=env_var_or_default('TRACKER_HUB_HOST', 'hub'): link-build
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
    ssh -t {{ host }} docker exec -it trame-db psql -U tracker -d tracker

# Compose the out-of-tree plugins listed in plugins.local.json (then rebuild)
[group('dev')]
plugins:
    cd app && deno run -A ../scripts/gen-plugins.ts

# Install plugins.local.json plugins for the installed app (host binary + web bundle); then restart Trame
[group('setup')]
plugins-install: plugins
    #!/usr/bin/env bash
    set -euo pipefail
    dest="${XDG_DATA_HOME:-$HOME/.local/share}/trame/plugins"
    mkdir -p .scratch "$dest"
    tmp="$(mktemp -d "$PWD/.scratch/plugins.XXXXXX")"
    trap 'rm -rf -- "$tmp"' EXIT
    # db.ts's schema fallback imports the generated embed.ts, which must match the current web build
    npm run build --prefix app/web --silent
    deno run --allow-read --allow-write=app/embed.ts scripts/gen-embed.ts
    (cd app && deno compile -A --quiet --config deno.json --output "$tmp/plugin-host" plugin-host.ts)
    (cd app/web && TRAME_PLUGINS_WEB_OUT="$tmp/web" npx vite build -c vite.plugins.config.ts --logLevel warn)
    rm -rf "$dest/web.old" && { [[ ! -d "$dest/web" ]] || mv "$dest/web" "$dest/web.old"; }
    mv "$tmp/web" "$dest/web" && rm -rf "$dest/web.old"
    mv "$tmp/plugin-host" "$dest/plugin-host"
    echo "installed into $dest; restart Trame to load them"

# Run the native desktop app
[group('dev')]
dev: web-build
    bash scripts/rust-package.sh prepare
    TRAME_ISOLATED=1 TRAME_OFFLINE=1 TRAME_LOCAL_DIR="$PWD/.scratch/dev" TRACKER_PORT=0 TRAME_PG_BIN="$PWD/.scratch/package/pg/usr/lib/postgresql/18/bin" TRAME_WEB_DIR="$PWD/app/web/dist" cargo run -p trame-desktop --locked

# Run the native backend headlessly
[group('dev')]
serve:
    bash scripts/rust-package.sh prepare
    TRAME_ISOLATED=1 TRAME_OFFLINE=1 TRAME_LOCAL_DIR="$PWD/.scratch/dev" TRACKER_PORT=0 TRAME_PG_BIN="$PWD/.scratch/package/pg/usr/lib/postgresql/18/bin" cargo run -p trame-local --locked

# Build the distributable Linux deb with the native backend and CLI.
[group('dev')]
bundle:
    bash scripts/rust-package.sh deb

# Best-effort standalone Linux AppImage.
[group('dev')]
bundle-appimage:
    bash scripts/rust-package.sh appimage

# Build the React frontend into app/web/dist
[group('dev')]
web-build:
    npm ci --prefix app/web
    npm run build --prefix app/web
    deno run --allow-read --allow-write=app/embed.ts scripts/gen-embed.ts
    npm run build:link --prefix app/web
    deno run --allow-read --allow-write=hub/api/link-embed.ts scripts/gen-link-embed.ts

# Frontend dev server with HMR
[group('dev')]
web-dev:
    #!/usr/bin/env bash
    set -euo pipefail
    export TRAME_ISOLATED=1 TRAME_OFFLINE=1 TRAME_LOCAL_DIR="$PWD/.scratch/dev" TRACKER_PORT=0
    export TRAME_PG_BIN="$PWD/.scratch/package/pg/usr/lib/postgresql/18/bin"
    port_file="$TRAME_LOCAL_DIR/port.json"
    alive() { [[ -f "$port_file" ]] && curl -sf "http://127.0.0.1:$(jq -r .port "$port_file")/api/status" >/dev/null; }
    # reuse a running `just serve`, else run the backend for the lifetime of vite
    if ! alive; then
        bash scripts/rust-package.sh prepare
        cargo build -p trame-local --locked
        log="$PWD/.scratch/web-dev-backend.log"
        target/debug/trame-local >"$log" 2>&1 &
        backend=$!
        trap 'kill "$backend" 2>/dev/null; wait "$backend" 2>/dev/null || true' EXIT
        until alive; do
            kill -0 "$backend" 2>/dev/null || { tail -20 "$log"; exit 1; }
            sleep 0.5
        done
    fi
    npm run dev --prefix app/web

# Frontend dev server with HMR against the running Trame app: real data, real writes
[group('dev')]
web-live:
    TRAME_WEB_LIVE=1 npm run dev --prefix app/web

# Run the Rust unit tests
[group('dev')]
test *args:
    bash scripts/rust-package.sh prepare
    TRAME_ISOLATED=1 TRAME_OFFLINE=1 TRAME_LOCAL_DIR="$PWD/.scratch/test" TRAME_PG_BIN="$PWD/.scratch/package/pg/usr/lib/postgresql/18/bin" cargo test --workspace --locked {{ args }}
    deno run --allow-read scripts/rust-protocol.ts --check
    deno test --config app/deno.json app/web/src/
    deno test -A --config app/deno.json scripts/rust-db-export-test.ts
    deno test -A --config app/deno.json scripts/rust-db-migrate-test.ts

# Deno typecheck, tests and lint for the TS still shipped or shared (plugin host, core, protocol)
[group('dev')]
deno-check:
    bash scripts/deno-check.sh

# Synthetic PGlite migration: source preservation and idempotency
[group('dev')]
migration:
    #!/usr/bin/env bash
    set -euo pipefail
    bash scripts/rust-package.sh prepare
    cargo build -p trame-local --locked
    dir="$(mktemp -d "$PWD/.scratch/cif.XXXXXX")"
    trap 'rm -rf -- "$dir"' EXIT
    export TRAME_CI_FIXTURE_DIR="$dir" TRAME_ISOLATED=1 TRAME_OFFLINE=1
    export TRAME_PG_BIN="$PWD/.scratch/package/pg/usr/lib/postgresql/18/bin"
    deno run -A --config app/deno.json scripts/rust-ci-fixture.ts

# PostgreSQL ownership, crash recovery and startup failure gate
[group('dev')]
lifecycle:
    bash scripts/rust-package.sh prepare
    cargo build -p trame-local --locked
    TRAME_ISOLATED=1 TRAME_PG_BIN="$PWD/.scratch/package/pg/usr/lib/postgresql/18/bin" python3 scripts/rust-db-lifecycle-test.py

# Run Playwright e2e tests against the native backend
[group('dev')]
e2e *args: web-build
    bash scripts/rust-package.sh prepare
    cargo build -p trame-local --locked
    TRAME_PG_BIN="$PWD/.scratch/package/pg/usr/lib/postgresql/18/bin" TRAME_WEB_DIR="$PWD/app/web/dist" bash scripts/rust-e2e.sh {{ args }}

# Check Rust formatting, clippy and SQL schema
[group('dev')]
lint: lint-sql
    cargo fmt --all -- --check
    cargo clippy --workspace --all-targets --locked -- -D warnings

# Lint the SQL schema (sqlfluff, via uvx — no install needed)
[group('dev')]
lint-sql:
    uvx {{ sqlfluff }} lint db/schema.sql

# Format Rust and SQL schema in place
[group('dev')]
fmt: fmt-sql
    cargo fmt --all

# Format the SQL schema in place (sqlfluff)
[group('dev')]
fmt-sql:
    uvx {{ sqlfluff }} format db/schema.sql

# Verify the SQL schema is already formatted (non-mutating; fails on drift)
[group('dev')]
fmt-check-sql:
    uvx {{ sqlfluff }} format - < db/schema.sql | diff -u db/schema.sql - && echo "schema.sql formatted ✓"

# Type check the native workspace and frontend
[group('dev')]
check:
    bash scripts/rust-package.sh prepare
    cargo check --workspace --locked
    npm run typecheck --prefix app/web

# The hub API is its own Deno project (own deps) — check/test/lint it too (matches CI)
[group('dev')]
check-hub:
    cd hub/api && bun install --frozen-lockfile && bun run typecheck && bun test && deno lint --ignore=link-embed.ts

# Native and hub checks
[group('dev')]
ci: lint fmt-check-sql check test deno-check check-hub e2e migration lifecycle

# Build the native CLI into dist/tramecli.
[group('track')]
compile-cli:
    bash scripts/rust-package.sh cli

# Install the agent skills from a fresh build (interactive picker;
# or pass flags: `just setup --claude --codex --skills-dir ~/.gemini/skills`)
[group('setup')]
setup *args: compile-cli
    ./dist/tramecli setup "$@"

# Enable the git hooks (pre-commit: lint + typecheck; pre-push: `tramecli setup --hook`)
[group('dev')]
hooks:
    git config core.hooksPath .githooks
    @echo "hooks enabled (.githooks). Bypass one with --no-verify."

# Seed + serve an isolated demo instance on :8799 (fictional data — the README screenshots)
[group('docs')]
demo: web-build
    #!/usr/bin/env bash
    set -euo pipefail
    dir="$PWD/.scratch/demo"
    bash scripts/rust-package.sh prepare
    cargo build -p trame-local --locked
    rm -rf -- "$dir"
    mkdir -p "$dir/claude-projects"
    export TRACKER_HUB_API= TRACKER_HUB_API_TOKEN= TRACKER_NODE_ID=demo TRACKER_UPDATE_CHECK=0
    export TRAME_ISOLATED=1 TRAME_OFFLINE=1 TRAME_LOCAL_DIR="$dir" TRAME_WEB_DIR="$PWD/app/web/dist"
    export TRAME_PG_BIN="$PWD/.scratch/package/pg/usr/lib/postgresql/18/bin"
    export TRACKER_PORT=8799 TRACKER_HOST=127.0.0.1 TRACKER_PORT_FILE="$dir/port.json"
    export TRACKER_SETTINGS_FILE="$dir/settings.json"
    export TRACKER_CLAUDE_DIR="$dir/claude-projects"
    ./target/debug/trame-local &
    server_pid=$!
    trap 'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true' EXIT
    until curl -sf http://127.0.0.1:8799/api/status >/dev/null 2>&1; do
      if ! kill -0 "$server_pid" 2>/dev/null; then wait "$server_pid"; exit 1; fi
      sleep 1
    done
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
