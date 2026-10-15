#!/usr/bin/env bash
# DESCRIPTION: Run the plugin host from source, a stand-in for the compiled binary in dev and e2e.
# USAGE: TRAME_PLUGIN_HOST="$PWD/scripts/plugin-host.sh" just serve   (trame-local spawns it)
set -euo pipefail
cd "$(dirname "$0")/../app"
exec deno run -A --quiet --config deno.json plugin-host.ts
