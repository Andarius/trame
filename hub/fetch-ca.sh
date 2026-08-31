#!/usr/bin/env bash
# DESCRIPTION: Fetch the hub's ca.crt into the local certs dir, so this laptop trusts
#   the hub API's TLS. Postgres itself is unreachable from here — no client cert.
# USAGE: hub/fetch-ca.sh [ssh-host]
#   host defaults to $TRACKER_HUB_HOST or 'hub'.
# EXAMPLES:
#   just hub-ca
#   hub/fetch-ca.sh my-server
set -euo pipefail

HOST="${1:-${TRACKER_HUB_HOST:-hub}}"
DIR="Apps/tracker"
DEST="${TRACKER_TLS_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/trame/certs}"

mkdir -p "$DEST"
scp -q "$HOST:$DIR/certs/ca.crt" "$DEST/ca.crt"
echo "ca.crt installed -> $DEST"
