---
title: "v0.7.0 — public shareable links"
sidebar:
  label: "v0.7.0"
---

Share a page with anyone via a plain URL: a read-only browser view of the page's
subtree — no account, no app install. Complements v0.6's guest sharing (which stays
the path for people who should *edit* and comment).

## Links

- **Create + copy from the Share modal**: mints a capability URL (`…/l/<token>`);
  revoke from the same place — the URL stops working on the next sync pass.
- **What visitors see**: the page and its sub-pages (navigable), text/heading/todo
  blocks, and attached databases as tables. **Comments and folder blocks are never
  rendered.** Server-side HTML, escaped, `noindex`.
- **Security by construction**: only the sha-256 of the token is stored or synced;
  links are served by a **dedicated hub port (:8444) whose only routes are `/l/*`** —
  the reverse proxy you point at the internet can never reach the sync API.
- **Pretty domains**: set `linkBase` in settings.json (or `TRACKER_LINK_BASE`) and
  copied links use your public domain; front the hub's :8444 with any reverse proxy
  that holds a real certificate (a Synology's Let's Encrypt cert works nicely).
