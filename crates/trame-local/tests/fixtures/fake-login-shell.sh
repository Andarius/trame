#!/bin/sh
# DESCRIPTION
# Stands in for the user's login shell in the agent tests: answers `command -v <agent>` with the
# fake agent CLIs, the way a shell whose profile adds ~/.local/bin would.
# USAGE
# fake-login-shell.sh -l -i -c 'command -v claude'
set -eu
here=$(cd "$(dirname "$0")" && pwd)
case "$*" in
  *"command -v claude"*) echo "profile noise"; echo "$here/fake-claude.py" ;;
  *) exit 1 ;;
esac
