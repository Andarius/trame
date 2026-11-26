#!/usr/bin/env bash
# DESCRIPTION: Stage the pinned agent relay binary for a Tauri desktop package.
# USAGE: bash scripts/fetch-agent-relay.sh PACKAGE_DIR RUST_TARGET
# EXAMPLES: bash scripts/fetch-agent-relay.sh .scratch/package x86_64-unknown-linux-gnu
set -euo pipefail

package="$1"
target="$2"
version=v0.1.2
case "$target" in
    x86_64-unknown-linux-gnu)
        asset=agent-relay-linux-amd64
        sha=d5edaa2f123418af35621c977e7e9692b63bee9566be1ab6a47d6e5fa6fdf5e7
        ;;
    aarch64-apple-darwin)
        asset=agent-relay-darwin-arm64
        sha=76340baa9f1b599fbeecd5402c1485d50e1ff81cbe211dc44ea069b9eb6d553a
        ;;
    *) echo "unsupported agent relay target: $target" >&2; exit 2 ;;
esac

matches() {
    printf '%s  %s\n' "$sha" "$1" | shasum -a 256 -c --status
}

mkdir -p "$package"
output="$package/agent-relay-$target"
if [[ -f "$output" ]] && matches "$output"; then
    chmod 0755 "$output"
    exit 0
fi
download="$(mktemp "$output.XXXXXX")"
trap 'rm -f -- "$download"' EXIT
curl -fsSL --retry 3 "https://github.com/Andarius/agent-relay/releases/download/$version/$asset" -o "$download"
if ! matches "$download"; then
    echo "agent relay checksum mismatch: $version/$asset" >&2
    exit 1
fi
chmod 0755 "$download"
mv -f -- "$download" "$output"
