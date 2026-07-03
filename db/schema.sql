-- Shared schema. Runs on BOTH the mini's Postgres and each laptop's local PGlite,
-- so the SQL is identical everywhere (that's the whole point of PGlite over SQLite).
-- gen_random_uuid() is built into Postgres 13+ and PGlite — no extension needed.

-- Every synced row carries: id (uuid), updated_at (LWW clock), origin (which node
-- wrote it), deleted (soft-delete so deletions propagate). The custom sync uses these.

create table if not exists clients (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  color      text,
  origin     text not null default 'seed',
  updated_at timestamptz not null default now(),
  deleted    boolean not null default false
);

create table if not exists objectives (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  story      text not null default '',
  client_id  uuid references clients(id),
  status     text not null default 'open',      -- open | done | archived
  origin     text not null default 'seed',
  updated_at timestamptz not null default now(),
  deleted    boolean not null default false
);

create table if not exists sessions (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  status       text not null default 'active',  -- active | paused | blocked | done
  client_id    uuid references clients(id),
  objective_id uuid references objectives(id),
  repo_path    text,
  branch       text,
  next_step    text,
  pr_url       text,
  summary      text not null default '',
  last_touched timestamptz not null default now(),
  origin       text not null default 'seed',
  updated_at   timestamptz not null default now(),
  deleted      boolean not null default false
);

create table if not exists session_events (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id),
  at         timestamptz not null default now(),
  summary    text,
  kind       text not null default 'track',
  origin     text not null default 'seed',
  updated_at timestamptz not null default now(),
  deleted    boolean not null default false
);

create table if not exists reports (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  html         text not null default '',
  client_id    uuid references clients(id),
  objective_id uuid references objectives(id),
  created_at   timestamptz not null default now(),
  origin       text not null default 'seed',
  updated_at   timestamptz not null default now(),
  deleted      boolean not null default false
);

-- Local-only sync bookkeeping (harmless if it also exists on the mini).
create table if not exists sync_state (
  id             int primary key default 1,
  last_pulled_at timestamptz not null default 'epoch',
  last_pushed_at timestamptz not null default 'epoch'
);
insert into sync_state (id) values (1) on conflict do nothing;
