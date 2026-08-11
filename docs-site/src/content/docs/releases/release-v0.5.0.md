---
title: "v0.5.0 — realtime sync through a hub API"
sidebar:
  label: "v0.5.0"
---

The hub grows from "just Postgres" into an **API server in front of Postgres** — the
foundation for multi-user collaboration (design: [Hub API & sync](../../sync-walkthrough/)). Sync can now ride an
authenticated HTTPS changeset protocol with **realtime push**, while the existing
direct-Postgres path keeps working unchanged: both transports coexist, per device,
behind a flag.

## Realtime sync (opt-in)

- **Hub API server** (`hub/api`, Deno + Hono beside the Postgres container): a versioned
  `POST /sync` — mutations up, changes down — with per-device opaque bearer tokens and
  TLS terminated by Deno using the existing private-CA certs. Mint a device token on the
  hub, set `syncViaApi`/`hubApi`/`hubApiToken` in `settings.json`, and the 15s sync rides
  the API instead of raw SQL. Default **off** — nothing changes until you opt in.
- **WS nudges**: the API listens to Postgres once and pushes "something changed" over a
  WebSocket; the app then syncs immediately. Edits from another device appear in ~2s
  instead of on the next poll. The socket carries no data — a dropped connection costs
  latency, never correctness — and the poll stays as the fallback.
- **Writes push fast too**: a local edit schedules a sync ~1.5s later (debounced), so
  device-to-device latency is seconds in both directions.
- **Change log**: every write on hub and laptops is captured by triggers into a
  `change_log` (monotonic revision = the API's pull cursor). Legacy direct-SQL writes are
  captured the same way, so mixed fleets stay consistent during the transition.

## Identity

- **Users and devices are first-class**: a synced `users` profile (name/avatar) and a
  `devices` table mapping each machine to its user. Comments now carry a durable
  `author_id` and pages an `owner_id`, backfilled for existing data. Setting "Your name"
  in ⚙ Settings updates the synced profile — other machines render it even before
  configuring their own.

## Configuration

- **`TRACKER_CLIENTS`** env var replaces the hardcoded client-name mapping used by the
  session importers and `/trame:track` (empty → everything files under Side-projects).

## Deploy

- `hub/deploy.sh` now re-applies the idempotent `schema.sql` on every deploy (schema
  changes finally reach an existing hub) and restarts the API container so it picks up
  the copied source. The compose stack gains the `tracker-api` service on `:8443`,
  DB access scoped to the docker subnet in `pg_hba`.
