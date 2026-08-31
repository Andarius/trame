#!/usr/bin/env bash
# DESCRIPTION: Generate the hub's TLS material (private CA + server cert, served by
#   the hub API). Runs in the deploy dir on the hub (called by deploy.sh) and in
#   hub/ locally (called by `just db`). Idempotent: existing keys/certs are kept.
#   Layout (relative to cwd):
#     ca/     ca.key ca.crt                 — never mounted; the CA key stays here
#     certs/  ca.crt server.crt server.key  — mounted into the container
# USAGE: gen-certs.sh init <lan-ip> [dns-name...]   CA + server cert if missing
# EXAMPLES:
#   ./gen-certs.sh init 192.168.1.x "$(hostname)"
set -euo pipefail

case "${1:?usage: gen-certs.sh init <lan-ip> [dns-name...]}" in
init)
  ip="${2:?usage: gen-certs.sh init <lan-ip> [dns-name...]}"
  shift 2
  mkdir -p ca certs
  chmod 700 ca
  if [ ! -f ca/ca.key ]; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
      -keyout ca/ca.key -out ca/ca.crt -subj "/CN=trame-hub-ca"
    chmod 600 ca/ca.key
    echo "created CA (ca/ca.crt)"
  fi
  if [ ! -f certs/server.key ]; then
    # DNS:tracker-hub is what clients verify against (stable across IP changes).
    san="IP:$ip,DNS:tracker-hub"
    for d in "$@"; do san="$san,DNS:$d"; done
    openssl req -newkey rsa:2048 -nodes -keyout certs/server.key \
      -out certs/server.csr -subj "/CN=tracker-hub"
    openssl x509 -req -in certs/server.csr -CA ca/ca.crt -CAkey ca/ca.key \
      -CAcreateserial -days 1825 -out certs/server.crt \
      -extfile <(printf "subjectAltName=%s" "$san")
    rm certs/server.csr
    # Postgres wants the key owned by postgres (<=600) or root (<=640); bind mounts
    # keep the host uid, so chown to the image's postgres uid from inside a container.
    docker run --rm -v "$PWD/certs:/c" postgres:18 \
      sh -c 'chown postgres:postgres /c/server.key && chmod 600 /c/server.key'
    echo "created server cert (SAN: $san)"
  fi
  cp -f ca/ca.crt certs/ca.crt
  ;;
*)
  echo "unknown mode: $1 (want init)" >&2
  exit 1
  ;;
esac
