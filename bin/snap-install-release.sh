#!/usr/bin/env bash
# DESCRIPTION: Download and install a GitHub release .snap of Trame.
# USAGE: bin/snap-install-release.sh [tag]
# EXAMPLES:
#   bin/snap-install-release.sh           # latest release
#   bin/snap-install-release.sh v0.1.0    # specific tag

set -euo pipefail

repo="Andarius/trame"
tag="${1:-latest}"

tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

if [[ "${tag}" == "latest" ]]; then
    echo "Resolving latest release..."
    gh release download --repo "${repo}" --pattern '*.snap' --dir "${tmp}"
else
    echo "Downloading release ${tag}..."
    gh release download "${tag}" --repo "${repo}" --pattern '*.snap' --dir "${tmp}"
fi

snap_file="$(ls "${tmp}"/*.snap | head -n1)"
echo "Installing ${snap_file}..."
sudo snap install --dangerous --classic "${snap_file}"
# bare `tramecli` for agents (snap exposes apps as trame.<app>)
sudo snap alias trame.tramecli tramecli || echo "snap alias failed — use trame.tramecli" >&2
