# v0.4.1 — security hardening and data-integrity fixes

A patch release for v0.4.0: it closes two credential/CSRF holes in the local API and the
deployments plugin, and fixes several ways the new features could lose or hide data.
**Recommended for everyone running v0.4.0**, especially with the deployments plugin enabled.

## Security

- **Forge credentials are bound to their host.** `GITLAB_TOKEN` and the `glab` CLI could be
  borrowed by a caller-supplied base URL, so a request naming an arbitrary host was answered
  with the token in a `private-token` header. Ambient credentials now only apply to the host
  you configured; a custom host must carry its own token. (v0.4.0 bound the *saved* PAT — this
  completes it for the environment and CLI paths.)
- **The local API rejects cross-origin requests.** `/api` spawns terminals, opens files and
  approves deployments; a page on another origin couldn't read the response but could still
  fire the side effect (including via DNS rebinding). Cross-origin is only ever *asserted*,
  never assumed: the `/trame:track` writer, the MCP server and other header-less clients are
  unaffected, as is the Vite dev proxy.

## Fixes

- **Deleting a board column no longer hides later cards.** The session default, the Claude/Codex
  importers and the tracking skills all emit fixed keys (`active`…); an unknown key is now
  remapped to a surviving column instead of leaving the card in no column at all.
- **Two devices adding the same column converge.** Status ids are derived from their key (the
  same reason the built-ins ship with fixed ids), so offline nodes no longer fork duplicate
  columns on sync. Re-adding a deleted column revives it.
- **`$trame-track` / `/trame:track` install correctly for everyone.** The writer path is now
  substituted for your checkout at install time — `just install-cmd` / `just install-skill`
  (don't copy the files by hand).
- **Page sharing keeps databases usable.** Imported view tabs had their sorts, filters,
  group-by and aggregates silently dropped because they still referenced the exporter's
  property ids; every reference is now remapped. Project colors also survive the round-trip.
- **Deleting a page deletes its inline comments** instead of leaving them synced and readable.
- **The deployments panel fills as soon as you enable the plugin**, rather than sitting on
  "Loading…" until the next idle poll (up to 5 minutes).
- **Un-ignoring a Claude session sticks** — the pre-0.4 ignore list is cleaned up too.
- **A comment on a page's last remaining block no longer orphans.**
- **The Claude session hook serializes its writes**, so two prompts landing at once can't drop
  another working directory's entry.

## Tests / CI
`deno test` now runs in CI (and `just ci`) — it was added in v0.4.0 but gated nothing. New unit
coverage for the cross-origin guard, credential host-binding, status remapping and identity,
and the page-share view/color round-trip.

## Upgrading
No migration; no schema change.
