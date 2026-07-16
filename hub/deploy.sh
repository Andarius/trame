#!/usr/bin/env bash
# DESCRIPTION: Deploy the Postgres sync hub to a home server (~/Apps/tracker).
#   Copies docker-compose.yml + db/schema.sql, creates .env (password + LAN bind)
#   on first run, then `docker compose up -d` and waits for the healthcheck.
#   Idempotent: re-running redeploys the files and restarts the stack; the
#   existing .env and data volume are kept. schema.sql is re-applied (idempotently)
#   on every deploy once the db is healthy — the hub's migration mechanism.
# USAGE: hub/deploy.sh [ssh-host]   (default: $TRACKER_HUB_HOST or 'hub')
# EXAMPLES:
#   just db-deploy
#   hub/deploy.sh my-server
set -euo pipefail

HOST="${1:-${TRACKER_HUB_HOST:-hub}}"
DIR="Apps/tracker"
HERE="$(cd "$(dirname "$0")" && pwd)"

ssh "$HOST" "mkdir -p ~/$DIR"
scp -q "$HERE/docker-compose.yml" "$HOST:$DIR/docker-compose.yml"
scp -q "$HERE/../db/schema.sql" "$HOST:$DIR/schema.sql"
scp -q "$HERE/pg_hba.conf" "$HOST:$DIR/pg_hba.conf"
scp -q "$HERE/gen-certs.sh" "$HOST:$DIR/gen-certs.sh"
ssh "$HOST" "chmod +x ~/$DIR/gen-certs.sh"

ssh "$HOST" bash -s "$DIR" <<'REMOTE'
set -euo pipefail
cd ~/"$1"
if [ ! -f .env ]; then
  LAN_IP=$(ip -4 route get 1.1.1.1 | grep -oP 'src \K[\d.]+')
  {
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)"
    echo "TRACKER_BIND=$LAN_IP"
    echo "TRACKER_SCHEMA=./schema.sql"
  } > .env
  chmod 600 .env
  echo "created .env (bind: $LAN_IP)"
fi
. ./.env
./gen-certs.sh init "$TRACKER_BIND" "$(hostname)"
docker compose up -d
for _ in $(seq 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' tracker-db 2>/dev/null || echo starting)
  [ "$status" = healthy ] && break
  sleep 2
done
[ "$status" = healthy ] || { echo "tracker-db not healthy: $status" >&2; docker logs --tail 20 tracker-db >&2; exit 1; }
# schema.sql is fully idempotent — this is how schema changes reach an existing hub
# (the initdb mount only runs on an empty data volume)
docker exec -i tracker-db psql -q -U tracker -d tracker -v ON_ERROR_STOP=1 < schema.sql
echo "schema.sql applied"
echo "tracker-db healthy — laptops use:"
echo "  export TRACKER_REMOTE_PG=\"postgres://tracker:$POSTGRES_PASSWORD@$TRACKER_BIND:5433/tracker\""
echo "then fetch this laptop's client cert:  just db-cert"
REMOTE
