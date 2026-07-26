#!/usr/bin/env bash
# DESCRIPTION: Quickstart — clone Trame, build the frontend, wire the coding-agent integrations.
# USAGE: curl -fsSL https://raw.githubusercontent.com/Andarius/trame/master/bin/quickstart.sh | bash
# EXAMPLES:
#   curl -fsSL .../quickstart.sh | TRAME_DIR=~/code/trame bash        # custom checkout dir
#   curl -fsSL .../quickstart.sh | TRAME_TARGETS=claude,codex bash    # wire both agents
#   curl -fsSL .../quickstart.sh | TRAME_TARGETS=none bash            # clone + build only

set -euo pipefail

main() {
    local repo="${TRAME_REPO:-https://github.com/Andarius/trame.git}"
    local dir="${TRAME_DIR:-$HOME/trame}"
    local targets="${TRAME_TARGETS:-claude}"

    command -v git >/dev/null || { echo "git is required" >&2; exit 1; }

    if ! command -v deno >/dev/null; then
        echo "Deno not found — installing to \${DENO_INSTALL:-\$HOME/.deno}..."
        curl -fsSL https://deno.land/install.sh | sh </dev/null
        export PATH="${DENO_INSTALL:-$HOME/.deno}/bin:$PATH"
    fi

    if [[ -d "$dir/.git" ]]; then
        echo "Updating existing checkout in $dir..."
        git -C "$dir" pull --ff-only
    else
        git clone "$repo" "$dir"
    fi

    if command -v npm >/dev/null; then
        (cd "$dir/app" && deno task web:build)
    else
        echo "npm not found — skipping the frontend build; run 'cd $dir/app && deno task web:build' once installed" >&2
    fi

    if [[ "$targets" != "none" ]]; then
        (cd "$dir" && deno run --config app/deno.json -A scripts/install-track.ts --target "$targets")
    fi

    cat <<EOF

Trame is ready in $dir. Next:
  cd $dir/app && deno task dev    # open the desktop app (Deno 2.9+)
Hub sync, device tokens, and the Claude session hook: see the Setup section of
$dir/README.md
EOF
}

main "$@"
