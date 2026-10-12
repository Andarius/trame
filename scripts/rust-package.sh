#!/usr/bin/env bash
# DESCRIPTION: Build the native Linux desktop packages with pinned PostgreSQL 18 resources.
# USAGE: scripts/rust-package.sh [prepare|cli|deb|appimage]
# EXAMPLES: scripts/rust-package.sh deb
set -euo pipefail

cd "$(dirname "$0")/.."
mode="${1:-deb}"
case "$mode" in prepare|cli|deb|appimage) ;; *) echo "expected prepare, cli, deb, or appimage" >&2; exit 2 ;; esac
[[ "$(uname -s)/$(uname -m)" == Linux/x86_64 ]] || { echo "Linux x86_64 required" >&2; exit 1; }

deno run --allow-read --allow-env --config app/deno.json scripts/rust-cli-contracts.ts --check
sha="$(git rev-parse --short HEAD 2>/dev/null || printf src)"
dirty="$(git status --porcelain --untracked-files=normal 2>/dev/null || true)"
export TRAME_BUILD="$sha${dirty:+-dirty}"
export CARGO_HOME="${CARGO_HOME:-$PWD/.scratch/cargo-home}"
if [[ "$mode" == cli ]]; then
    cargo build -p trame-cli --release --locked
    mkdir -p dist
    cp target/release/tramecli dist/tramecli
    exit 0
fi

package="$PWD/.scratch/package"
pg="$package/pg"
mkdir -p "$package"
if [[ ! -x "$pg/usr/lib/postgresql/18/bin/postgres" ]]; then
    if [[ -x .scratch/stage0/pg18/usr/lib/postgresql/18/bin/postgres ]]; then
        cp -a .scratch/stage0/pg18 "$pg"
    else
        mkdir -p "$package/download"
        while read -r name sha; do
            file="$package/download/$name"
            if [[ ! -f "$file" ]] || ! printf '%s  %s\n' "$sha" "$file" | sha256sum -c - --status; then
                curl -fL --retry 3 "https://apt.postgresql.org/pub/repos/apt/pool/main/p/postgresql-18/$name" -o "$file"
            fi
            printf '%s  %s\n' "$sha" "$file" | sha256sum -c - --status
            dpkg-deb -x "$file" "$pg"
        done <<'PACKAGES'
postgresql-18_18.3-1.pgdg24.04+1_amd64.deb 9e8a64afde91dbf818526b8c200a3ed4a6fd1975171b06a31fe0bd378fe8c7c6
postgresql-client-18_18.3-1.pgdg24.04+1_amd64.deb 571d7977a64de78487d7def807e3cfb304a47a2ece3e62cd01018cf39bb4f6ec
PACKAGES
    fi
fi
[[ "$($pg/usr/lib/postgresql/18/bin/postgres --version)" == 'postgres (PostgreSQL) 18.3'* ]]
[[ -f "$pg/usr/share/postgresql/18/postgres.bki" ]]

triple="$(rustc -vV | sed -n 's/^host: //p')"
[[ "$triple" == x86_64-unknown-linux-gnu ]]
command -v deno >/dev/null || { echo "Deno is required only to compile the legacy migration helper" >&2; exit 1; }
deno compile -A --quiet --config app/deno.json --output "$package/trame-migrate-pglite-$triple" scripts/rust-db-migrate.ts
if [[ "$mode" == prepare ]]; then
    cargo build -p trame-cli --locked
    cp target/debug/tramecli "$package/tramecli-$triple"
    exit 0
fi

npm ci --prefix app/web
npm run build --prefix app/web
cargo build -p trame-cli --release --locked
cp target/release/tramecli "$package/tramecli-$triple"
cd crates/trame-desktop
npx --yes @tauri-apps/cli@2.12.2 build --ci --bundles "$mode"
cd ../..
mkdir -p dist/linux
if [[ "$mode" == deb ]]; then
    find target/release/bundle/deb -maxdepth 1 -name '*.deb' -exec cp '{}' dist/linux/trame.deb \;
    [[ -f dist/linux/trame.deb ]]
    # the window's Wayland app id is `trame`; the menu entry needs that exact name to own the window
    unpacked="$(mktemp -d)"
    dpkg-deb -R dist/linux/trame.deb "$unpacked"
    mv "$unpacked/usr/share/applications/Trame.desktop" "$unpacked/usr/share/applications/trame.desktop"
    if [[ -f "$unpacked/DEBIAN/md5sums" ]]; then
        sed -i 's|usr/share/applications/Trame.desktop$|usr/share/applications/trame.desktop|' "$unpacked/DEBIAN/md5sums"
    fi
    dpkg-deb --root-owner-group -b "$unpacked" dist/linux/trame.deb >/dev/null
    rm -rf "$unpacked"
else
    find target/release/bundle/appimage -maxdepth 1 -name '*.AppImage' -exec cp '{}' dist/linux/Trame.AppImage \;
    [[ -f dist/linux/Trame.AppImage ]]
fi
