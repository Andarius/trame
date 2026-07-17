# v0.6.0 — share pages with guests

Trame becomes multi-user: invite a **guest** and share individual pages with them — live,
not as a file. Guests see exactly what you share (the page, its sub-pages, comments, and
attached databases) and nothing else; edits and comments flow both ways in seconds over
the v0.5 realtime sync. Members are unaffected: your own devices still see everything.

## Sharing

- **Share modal on every page**: grant a guest **viewer** (read-only) or **editor**
  (edit + comment + database rows) access to the page's subtree; change the role or
  revoke from the same place. Revoking purges the guest's local copy on their next sync.
- **Guest onboarding is one command** on the hub:
  `docker exec tracker-api deno run -A --config /srv/hub/api/deno.json /srv/hub/api/main.ts invite "Name" their-node-id`
  — prints a token they drop into their settings.json alongside the hub URL.
- **Enforced at the API, both directions**: guests pull only granted subtrees (grants
  arriving late back-fill history; revocations tombstone it away), and every push is
  authorized per mutation — viewers can't write, editors only inside their subtrees,
  and comment authorship is pinned to the caller.
- Comments everywhere now carry the author's synced profile identity.

## Also

- The direct Postgres port is gone from the default hub topology (laptops sync
  exclusively through the authenticated API since v0.5); `just psql` tunnels over ssh.
- `mint` binds a device to its user on the hub — required under access control, and it
  removes the client-side claim (fresh installs bind correctly before their first sync).
- The old file-based page sharing is still there, renamed **Export**.
