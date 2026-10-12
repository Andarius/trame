#!/usr/bin/env bash
# DESCRIPTION: Quickstart — clone Trame, install the desktop app, wire the coding-agent integrations.
# USAGE: curl -fsSL https://raw.githubusercontent.com/Andarius/trame/master/bin/quickstart.sh | bash
# EXAMPLES:
#   curl -fsSL .../quickstart.sh | TRAME_DIR=~/code/trame bash        # custom checkout dir
#   curl -fsSL .../quickstart.sh | TRAME_TARGETS=claude bash          # wire only Claude Code
#   curl -fsSL .../quickstart.sh | TRAME_SKILL_DIRS=~/.gemini/skills bash   # any other agent's skills dir
#   curl -fsSL .../quickstart.sh | TRAME_APP=source bash              # build and install from source
#   curl -fsSL .../quickstart.sh | TRAME_APP=appimage bash            # force the AppImage (no sudo)

set -euo pipefail

REPO_SLUG="Andarius/trame"
RUN_HINT=""

resolve_tag() {
    local tag="${TRAME_VERSION:-latest}"
    if [[ "$tag" == "latest" ]]; then
        tag="$(curl -fsSL "https://api.github.com/repos/$REPO_SLUG/releases/latest" \
            | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')"
    fi
    [[ -n "$tag" ]] && echo "$tag"
}

fetch_asset() { # tag asset dest
    echo "Downloading $2..."
    local progress="-sS"
    [[ -t 2 ]] && progress="--progress-bar"
    curl -fL "$progress" "https://github.com/$REPO_SLUG/releases/download/$1/$2" -o "$3"
}

# Menu entry + icon, named after the window's app id (trame) so the taskbar links the window to them.
integrate_appimage() { # binary
    local bin="$1" tmp
    local data="${XDG_DATA_HOME:-$HOME/.local/share}"
    local icon="$data/icons/hicolor/512x512/apps/trame.png"
    mkdir -p "$data/applications" "${icon%/*}"
    tmp="$(mktemp -d)"
    if (cd "$tmp" && "$bin" --appimage-extract 'usr/share/icons/hicolor/512x512/apps/trame.png' >/dev/null 2>&1) \
        && [[ -f "$tmp/squashfs-root/usr/share/icons/hicolor/512x512/apps/trame.png" ]]; then
        cp "$tmp/squashfs-root/usr/share/icons/hicolor/512x512/apps/trame.png" "$icon"
    else
        echo "could not extract the app icon; the menu entry will use a generic one" >&2
    fi
    rm -rf "$tmp"
    cat >"$data/applications/trame.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Trame
Comment=Local-first session tracker for coding work
Exec=$bin
Icon=$icon
StartupWMClass=trame
Terminal=false
Categories=Development;
EOF
    if command -v update-desktop-database >/dev/null; then update-desktop-database -q "$data/applications" || true; fi
    echo "menu entry → $data/applications/trame.desktop"
}

# release → the packaged app matching this platform; no prebuilt asset → source
detect_flavor() {
    local app="${TRAME_APP:-release}"
    if [[ "$app" != "release" ]]; then
        echo "$app"
        return
    fi
    case "$(uname -s)/$(uname -m)" in
        Linux/x86_64)
            if command -v snap >/dev/null; then echo snap; else echo deb; fi ;;
        *) echo unsupported ;;
    esac
}

install_release() { # flavor
    local flavor="$1" tag ver tmp
    tag="$(resolve_tag)" || { echo "could not resolve the latest release tag" >&2; return 1; }
    ver="${tag#v}"
    tmp="$(mktemp -d)"
    # expand now: the RETURN trap outlives this function's locals
    trap "rm -rf '$tmp'" RETURN
    case "$flavor" in
        snap)
            fetch_asset "$tag" "trame_${ver}_amd64.snap" "$tmp/trame.snap"
            echo "Installing the snap $tag (needs sudo)..."
            sudo snap install --dangerous --classic "$tmp/trame.snap"
            sudo snap alias trame.tramecli tramecli || echo "snap alias failed — use trame.tramecli" >&2
            RUN_HINT="trame"
            ;;
        deb)
            fetch_asset "$tag" "trame-${tag}-linux-x64.deb" "$tmp/trame.deb"
            sudo apt install -y "$tmp/trame.deb"
            RUN_HINT="trame"
            ;;
        appimage)
            mkdir -p "$HOME/.local/bin"
            fetch_asset "$tag" "Trame-${tag}-native-x64.AppImage" "$HOME/.local/bin/trame"
            chmod +x "$HOME/.local/bin/trame"
            fetch_asset "$tag" "tramecli-${tag}-linux-x64" "$HOME/.local/bin/tramecli"
            chmod +x "$HOME/.local/bin/tramecli"
            integrate_appimage "$HOME/.local/bin/trame"
            RUN_HINT="$HOME/.local/bin/trame"
            ;;
        unsupported|dmg)
            echo "Native Trame packages currently support Linux x86_64 only" >&2
            return 1
            ;;
        *)
            echo "unknown TRAME_APP flavor: $flavor (expected release, snap, deb, appimage, source, or none)" >&2
            return 1
            ;;
    esac
    echo "installed → Trame $tag ($flavor)"
}

build_source() { # dir
    [[ "$(uname -s)/$(uname -m)" == Linux/x86_64 ]] || { echo "Source packages currently support Linux x86_64 only" >&2; return 1; }
    command -v npm >/dev/null || { echo "npm is required for a source build" >&2; return 1; }
    command -v cargo >/dev/null || { echo "Rust is required for a source build" >&2; return 1; }
    if ! command -v deno >/dev/null; then
        curl -fsSL https://deno.land/install.sh | sh </dev/null
        export PATH="${DENO_INSTALL:-$HOME/.deno}/bin:$PATH"
    fi
    sudo apt-get update
    sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev
    (cd "$1" && bash scripts/rust-package.sh deb)
    sudo apt install -y "$1/dist/linux/trame.deb"
    RUN_HINT="trame"
}

main() {
    local repo="${TRAME_REPO:-https://github.com/$REPO_SLUG.git}"
    local dir="${TRAME_DIR:-$HOME/trame}"
    local targets="${TRAME_TARGETS:-claude,codex}"
    local flavor
    flavor="$(detect_flavor)"

    command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
    command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }

    # the checkout hosts the agent writers the integrations point at
    if [[ -d "$dir/.git" ]]; then
        echo "Updating existing checkout in $dir..."
        git -C "$dir" pull --ff-only
    else
        git clone "$repo" "$dir"
    fi

    case "$flavor" in
        none) ;;
        source) build_source "$dir" ;;
        *) install_release "$flavor" ;;
    esac

    # agent docs come from the tramecli binary (`tramecli setup`)
    local setup_args=()
    if [[ "$targets" != "none" ]]; then
        local t
        for t in ${targets//,/ }; do
            case "$t" in
                claude) setup_args+=(--claude) ;;
                codex) setup_args+=(--codex) ;;
                *) echo "unknown TRAME_TARGETS entry: $t (expected claude, codex, or none)" >&2 ;;
            esac
        done
    fi
    if [[ -n "${TRAME_SKILL_DIRS:-}" ]]; then
        local d
        for d in ${TRAME_SKILL_DIRS//,/ }; do
            setup_args+=(--skills-dir "$d")
        done
    fi
    if [[ ${#setup_args[@]} -gt 0 ]]; then
        local cli
        if command -v tramecli >/dev/null; then cli=tramecli
        elif command -v trame.tramecli >/dev/null; then cli=trame.tramecli
        else
            (cd "$dir" && bash scripts/rust-package.sh cli)
            cli="$dir/dist/tramecli"
        fi
        "$cli" setup "${setup_args[@]}"
    fi

    cat <<EOF

Trame is ready (checkout: $dir).
${RUN_HINT:+  Run the app:  $RUN_HINT
}Hub sync, device tokens, and the Claude session hook: see the Setup section of
$dir/README.md
EOF
}

main "$@"
