#!/usr/bin/env bash
# DESCRIPTION: Quickstart — clone Trame, install the desktop app, wire the coding-agent integrations.
# USAGE: curl -fsSL https://raw.githubusercontent.com/Andarius/trame/master/bin/quickstart.sh | bash
# EXAMPLES:
#   curl -fsSL .../quickstart.sh | TRAME_DIR=~/code/trame bash        # custom checkout dir
#   curl -fsSL .../quickstart.sh | TRAME_TARGETS=claude bash          # wire only Claude Code
#   curl -fsSL .../quickstart.sh | TRAME_SKILL_DIRS=~/.gemini/skills bash   # any other agent's skills dir
#   curl -fsSL .../quickstart.sh | TRAME_APP=source bash              # build from source instead of a release
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

# release → the packaged app matching this platform; no prebuilt asset → source
detect_flavor() {
    local app="${TRAME_APP:-release}"
    if [[ "$app" != "release" ]]; then
        echo "$app"
        return
    fi
    case "$(uname -s)/$(uname -m)" in
        Linux/x86_64)
            if command -v snap >/dev/null; then echo snap; else echo appimage; fi ;;
        Darwin/arm64) echo dmg ;;
        *) echo source ;;
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
            RUN_HINT="trame"
            ;;
        appimage)
            mkdir -p "$HOME/.local/bin"
            fetch_asset "$tag" "Trame-${tag}-linux-x64.AppImage" "$HOME/.local/bin/trame"
            chmod +x "$HOME/.local/bin/trame"
            RUN_HINT="$HOME/.local/bin/trame"
            ;;
        dmg)
            fetch_asset "$tag" "Trame-${tag}-macos-arm64.dmg" "$tmp/Trame.dmg"
            local vol
            vol="$(hdiutil attach -nobrowse "$tmp/Trame.dmg" | awk 'END {print $NF}')"
            rm -rf /Applications/Trame.app
            cp -R "$vol/Trame.app" /Applications/
            hdiutil detach "$vol" >/dev/null
            xattr -dr com.apple.quarantine /Applications/Trame.app
            RUN_HINT="open /Applications/Trame.app"
            ;;
        *)
            echo "unknown TRAME_APP flavor: $flavor (expected release, snap, appimage, dmg, source, or none)" >&2
            return 1
            ;;
    esac
    echo "installed → Trame $tag ($flavor)"
}

build_source() { # dir
    if command -v npm >/dev/null; then
        (cd "$1/app" && deno task web:build)
        RUN_HINT="cd $1/app && deno task dev"
    else
        echo "npm not found — skipping the frontend build; run 'cd $1/app && deno task web:build' once installed" >&2
    fi
}

main() {
    local repo="${TRAME_REPO:-https://github.com/$REPO_SLUG.git}"
    local dir="${TRAME_DIR:-$HOME/trame}"
    local targets="${TRAME_TARGETS:-claude,codex}"
    local flavor
    flavor="$(detect_flavor)"

    command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
    command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }

    if ! command -v deno >/dev/null; then
        echo "Deno not found — installing to \${DENO_INSTALL:-\$HOME/.deno}..."
        curl -fsSL https://deno.land/install.sh | sh </dev/null
        export PATH="${DENO_INSTALL:-$HOME/.deno}/bin:$PATH"
    fi

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

    local install_args=()
    [[ "$targets" != "none" ]] && install_args+=(--target "$targets")
    [[ -n "${TRAME_SKILL_DIRS:-}" ]] && install_args+=(--skills-dir "$TRAME_SKILL_DIRS")
    if [[ ${#install_args[@]} -gt 0 ]]; then
        (cd "$dir" && deno run --config app/deno.json -A scripts/install-track.ts "${install_args[@]}")
    fi

    cat <<EOF

Trame is ready (checkout: $dir).
${RUN_HINT:+  Run the app:  $RUN_HINT
}Hub sync, device tokens, and the Claude session hook: see the Setup section of
$dir/README.md
EOF
}

main "$@"
