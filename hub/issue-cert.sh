#!/usr/bin/env bash
# DESCRIPTION: Issue a client cert for this laptop on the hub (the CA key never
#   leaves it) and fetch it into the local certs dir, where sync and `just psql`
#   pick it up automatically.
# USAGE: hub/issue-cert.sh [node-id] [ssh-host]
#   node-id defaults to $TRACKER_NODE_ID or hostname; host to $TRACKER_HUB_HOST or 'hub'.
# EXAMPLES:
#   just db-cert
#   hub/issue-cert.sh mbp-14 my-server
set -euo pipefail

NODE="${1:-${TRACKER_NODE_ID:-$(hostname)}}"
HOST="${2:-${TRACKER_HUB_HOST:-hub}}"
DIR="Apps/tracker"
DEST="${TRACKER_TLS_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/trame/certs}"

ssh "$HOST" "cd ~/$DIR && ./gen-certs.sh client '$NODE'"
mkdir -p "$DEST"
scp -q "$HOST:$DIR/ca/clients/$NODE.crt" "$DEST/client.crt"
scp -q "$HOST:$DIR/ca/clients/$NODE.key" "$DEST/client.key"
scp -q "$HOST:$DIR/certs/ca.crt" "$DEST/ca.crt"
chmod 600 "$DEST/client.key"   # libpq refuses group/world-readable keys
echo "certs installed -> $DEST (node-id: $NODE)"
