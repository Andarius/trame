#!/usr/bin/env bash

# DESCRIPTION: trame pre-push guard: refuses a push when the Trame session for the
#              branch is missing, terminal, or older than the newest commit being
#              pushed — i.e. the session was not updated after the work.
# USAGE: run automatically by `git push`; install it with `tramecli setup --hook`
#        bypass with `git push --no-verify` or `SKIP_TRAME_CHECK=1 git push`

set -euo pipefail

if [ "${SKIP_TRAME_CHECK:-}" = "1" ]; then
  exit 0
fi

# no tramecli, or the app is not running: nothing to check against
sessions=$(tramecli list --json 2>/dev/null) || exit 0
# a tramecli older than the fields below would fail every branch: skip instead
jq -e 'length == 0 or (.[0] | has("repo_path"))' >/dev/null <<<"$sessions" || exit 0

repo=$(git rev-parse --show-toplevel)
# a worktree pushes from a different path than the session's repo_path
repo_name=$(basename "$repo")
zero='0000000000000000000000000000000000000000'
stale=0

while read -r local_ref local_sha _remote_ref _remote_sha; do
  [ "$local_sha" = "$zero" ] && continue # branch deletion
  # tags and other refs carry no session: a release tag points at merged work
  case "$local_ref" in refs/heads/*) ;; *) continue ;; esac

  session=$(jq -r --arg repo "$repo" --arg name "$repo_name" \
    --arg branch "${local_ref#refs/heads/}" '
    [ .[]
      | select(.branch == $branch)
      | select(.repo_path == $repo or ((.repo_path // "") | split("/") | last) == $name)
    ] | sort_by(.last_touched) | last // empty' <<<"$sessions")

  if [ -z "$session" ]; then
    echo "pre-push: no open Trame session for ${repo_name}@${local_ref#refs/heads/} — run /trame-track" >&2
    stale=1
    continue
  fi

  # epochs on both sides: jq parses the ISO stamp, git prints one — no `date -d` (BSD)
  touched=$(jq -r '.last_touched | sub("\\.[0-9]+Z$";"Z") | fromdateiso8601' <<<"$session")
  committed=$(git log -1 --format=%ct "$local_sha")
  if [ "$touched" -lt "$committed" ]; then
    echo "pre-push: Trame session '$(jq -r .title <<<"$session")' last touched $(jq -r .last_touched <<<"$session")," >&2
    echo "          older than the newest commit ($(git log -1 --format=%cI "$local_sha")) — run /trame-track" >&2
    stale=1
  fi
done

if [ "$stale" -ne 0 ]; then
  echo "          (bypass: git push --no-verify)" >&2
  exit 1
fi
