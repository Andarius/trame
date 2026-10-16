#!/usr/bin/env bash
# DESCRIPTION: Build the native desktop packages (Linux x86_64, macOS arm64) with pinned PostgreSQL 18 resources.
# USAGE: scripts/rust-package.sh [prepare|cli|deb|appimage|dmg]
# EXAMPLES: scripts/rust-package.sh deb
#           scripts/rust-package.sh dmg   # on macOS arm64
set -euo pipefail

cd "$(dirname "$0")/.."
mode="${1:-deb}"
platform="$(uname -s)/$(uname -m)"
case "$platform/$mode" in
    Linux/x86_64/prepare|Linux/x86_64/cli|Linux/x86_64/deb|Linux/x86_64/appimage) ;;
    Darwin/arm64/prepare|Darwin/arm64/cli|Darwin/arm64/dmg) ;;
    *) echo "unsupported: $mode on $platform (Linux x86_64: prepare|cli|deb|appimage, macOS arm64: prepare|cli|dmg)" >&2; exit 2 ;;
esac

deno run --allow-read --allow-env --config app/deno.json scripts/rust-cli-contracts.ts --check
sha="$(git rev-parse --short HEAD 2>/dev/null || printf src)"
dirty="$(git status --porcelain --untracked-files=normal 2>/dev/null || true)"
export TRAME_BUILD="$sha${dirty:+-dirty}"
if [[ "$mode" == cli ]]; then
    cargo build -p trame-cli --release --locked
    mkdir -p dist
    cp target/release/tramecli dist/tramecli
    exit 0
fi

# Keep only what the app runs (postgres, initdb, psql) plus dump/recovery tools; no contrib, headers or docs.
prune_pg() {
    local root="$1" share="$2" file
    for file in "$root"/bin/*; do
        case "$(basename "$file")" in
            postgres|initdb|psql|pg_dump|pg_restore|pg_resetwal|pg_controldata) ;;
            *) rm -f "$file" ;;
        esac
    done
    for file in "$root"/lib/*; do
        case "$(basename "$file")" in
            lib*.so*|lib*.dylib|plpgsql.*|dict_snowball.*|*_and_*) ;;
            *) rm -rf "$file" ;;
        esac
    done
    find "$share/extension" -mindepth 1 ! -name 'plpgsql*' -delete
    rm -rf "$share/man" "$share/doc"
}

package="$PWD/.scratch/package"
pg="$package/pg"
mkdir -p "$package"
if [[ "$platform" == Darwin/arm64 ]]; then
    # relocatable build: bin/, lib/ and share/ must stay siblings
    name=postgresql-18.6.0-aarch64-apple-darwin
    sum=a257bcdb8aa3301a13d6a5bcec48f8c9517045b7cbae71e50788b2615539e95b
    if [[ ! -x "$pg/usr/lib/postgresql/18/bin/postgres" ]]; then
        mkdir -p "$package/download" "$pg/usr/lib/postgresql/18"
        file="$package/download/$name.tar.gz"
        if [[ ! -f "$file" ]] || ! printf '%s  %s\n' "$sum" "$file" | shasum -a 256 -c - --status; then
            curl -fL --retry 3 "https://github.com/theseus-rs/postgresql-binaries/releases/download/18.6.0/$name.tar.gz" -o "$file"
        fi
        printf '%s  %s\n' "$sum" "$file" | shasum -a 256 -c - --status
        tar -xzf "$file" -C "$pg/usr/lib/postgresql/18" --strip-components 1
    fi
    [[ "$($pg/usr/lib/postgresql/18/bin/postgres --version)" == 'postgres (PostgreSQL) 18.6'* ]]
    [[ -f "$pg/usr/lib/postgresql/18/share/postgres.bki" ]]
    prune_pg "$pg/usr/lib/postgresql/18" "$pg/usr/lib/postgresql/18/share"
    rm -rf "$pg/usr/lib/postgresql/18/include"
    triple=aarch64-apple-darwin
    [[ "$(rustc -vV | sed -n 's/^host: //p')" == "$triple" ]]
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
    # CI=true skips the Finder AppleScript window styling, which fails without a GUI session (ssh)
    CI=true npx --yes @tauri-apps/cli@2.12.2 build --ci --bundles dmg
    cd ../..
    mkdir -p dist/macos
    find target/release/bundle/dmg -maxdepth 1 -name '*.dmg' -exec cp '{}' dist/macos/Trame.dmg \;
    [[ -f dist/macos/Trame.dmg ]]
    cp target/release/tramecli dist/macos/tramecli
    exit 0
fi
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

prune_pg "$pg/usr/lib/postgresql/18" "$pg/usr/share/postgresql/18"
rm -rf "$pg/usr/share/doc" "$pg/usr/share/man" "$pg/usr/share/lintian" "$pg/etc"

triple="$(rustc -vV | sed -n 's/^host: //p')"
[[ "$triple" == x86_64-unknown-linux-gnu ]]
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
