-- Shared schema. Runs on BOTH the hub's Postgres and each laptop's local PGlite,
-- so the SQL is identical everywhere (that's the whole point of PGlite over SQLite).
-- Requires Postgres 18+ (uuidv7() on the udb_* tables) = PGlite 0.5.x and the
-- postgres:18 hub image. Older tables keep gen_random_uuid() (v4) — changing a
-- default rewrites nothing and existing ids stay valid; new udb ids are time-ordered v7.

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

-- LEGACY: superseded by pages (kind='project'). Kept as the frozen migration
-- source — nothing reads or writes it anymore. Drop once every machine migrated.
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

-- Pages (Notion-style): one nestable tree for everything. kind='project' pages are
-- the former objectives — migrated with the SAME ids, so session/report links carry
-- over as a value copy. Body = ordered block list in `content`; databases live on a
-- page via udb_databases.page_id (sidebar child) or inline as a {type:'database'} block.
create table if not exists pages (
  id         uuid primary key default uuidv7(),
  parent_id  uuid,                           -- null = top level; no FK: LWW pull is updated_at-ordered, so a child can arrive before its parent — readers tolerate orphans
  kind       text not null default 'page',   -- page | project
  title      text not null default '',
  icon       text,
  story      text not null default '',       -- project blurb, shown as the page description
  client_id  uuid references clients(id),
  status     text not null default 'open',   -- open | done | archived (projects)
  content    jsonb not null default '[]',    -- ordered blocks (LWW whole-doc; fine single-user)
  sort_key   text not null default 'a0',     -- fractional key: order among siblings
  origin     text not null default 'seed',
  updated_at timestamptz not null default now(),
  deleted    boolean not null default false
);
create index if not exists pages_parent on pages (parent_id);

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

-- User-defined databases (Notion-style). Fixed physical tables; user schemas are
-- data inside them. Derived values (formula/rollup) are computed on read, never stored.

create table if not exists udb_databases (
  id         uuid primary key default uuidv7(),
  name       text not null,
  icon       text,
  sort_key   text not null default 'a0',    -- fractional key: sidebar order
  views      jsonb not null default '[]',   -- future board/chart view configs; unused in v1
  origin     text not null default 'seed',
  updated_at timestamptz not null default now(),
  deleted    boolean not null default false
);

create table if not exists udb_properties (
  id         uuid primary key default uuidv7(),
  db_id      uuid not null references udb_databases(id),
  name       text not null,
  type       text not null,   -- title|text|number|select|multi_select|date|url|checkbox|relation|formula|rollup
  config     jsonb not null default '{}',   -- per-type config (options, relation pair, formula expr, rollup agg…)
  sort_key   text not null,                 -- fractional key: column order
  width      int,                           -- optional column width (px)
  origin     text not null default 'seed',
  updated_at timestamptz not null default now(),
  deleted    boolean not null default false
);
create index if not exists udb_properties_db on udb_properties (db_id);

create table if not exists udb_rows (
  id         uuid primary key default uuidv7(),
  db_id      uuid not null references udb_databases(id),
  icon       text,                          -- emoji glyph, or an image URL / data URI
  vals       jsonb not null default '{}',   -- { "<property uuid>": <typed value> } — id-keyed = rename-safe
  sort_key   text not null,                 -- fractional key: row order
  origin     text not null default 'seed',
  updated_at timestamptz not null default now(),
  deleted    boolean not null default false
);
-- idempotent guard: dirs created before the icon column existed (no migration system)
alter table udb_rows add column if not exists icon text;
create index if not exists udb_rows_db on udb_rows (db_id);

-- Relation links, stored ONLY under the owner side of a relation pair; the reverse
-- property queries with from/to swapped. No unique constraint (LWW sync upserts by
-- id, cross-node duplicates possible) — dedupe on read.
create table if not exists udb_links (
  id         uuid primary key default uuidv7(),
  prop_id    uuid not null references udb_properties(id),
  from_row   uuid not null references udb_rows(id),
  to_row     uuid not null references udb_rows(id),
  origin     text not null default 'seed',
  updated_at timestamptz not null default now(),
  deleted    boolean not null default false
);
create index if not exists udb_links_from on udb_links (prop_id, from_row);
create index if not exists udb_links_to   on udb_links (prop_id, to_row);

-- Objectives → pages migration (idempotent: copy is conflict-do-nothing, backfills
-- only fill nulls, and the dual-write in upsertSession keeps both columns equal
-- until the frontend is fully off objective_id).
alter table sessions      add column if not exists page_id uuid references pages(id);
alter table reports       add column if not exists page_id uuid references pages(id);
alter table udb_databases add column if not exists page_id uuid references pages(id);
-- new project pages exist only in pages, so the objectives FKs must go
alter table sessions drop constraint if exists sessions_objective_id_fkey;
alter table reports  drop constraint if exists reports_objective_id_fkey;
insert into pages (id, kind, title, story, client_id, status, origin, updated_at, deleted)
  select id, 'project', title, story, client_id, status, origin, updated_at, deleted
  from objectives
  on conflict (id) do nothing;
update sessions set page_id = objective_id where page_id is null and objective_id is not null;
update reports  set page_id = objective_id where page_id is null and objective_id is not null;

-- Local-only sync bookkeeping (harmless if it also exists on the hub).
create table if not exists sync_state (
  id             int primary key default 1,
  last_pulled_at timestamptz not null default 'epoch',
  last_pushed_at timestamptz not null default 'epoch'
);
insert into sync_state (id) values (1) on conflict do nothing;

-- Catalog documentation (COMMENT ON is idempotent — safe to re-run every startup).
-- Shows up in \d+ / \dt+ so the schema is self-describing from psql on the hub too.

comment on table clients is 'Who the work is for (Obitrain, Polarsen, …). Referenced by sessions, pages, reports.';
comment on column clients.name  is 'Display name; find-or-create key used by the CLI/MCP (resolveClient).';
comment on column clients.color is 'Chip color (hex); null = deterministic hash pick from the app palette.';

comment on table objectives is 'LEGACY — superseded by pages (kind=''project''), same ids. Frozen migration source; drop once every machine has migrated.';

comment on table pages is 'Notion-style page tree: one nestable hierarchy for everything. kind=''project'' pages are the former objectives (migrated with identical ids).';
comment on column pages.parent_id is 'Parent page; null = top level. Deliberately NO FK: LWW pull is updated_at-ordered so a child can arrive before its parent — readers tolerate orphans.';
comment on column pages.kind      is 'page | project. Behavioral: a page becomes a project (one-way) when a session attaches. Projects carry story/status and are what sessions ladder up to.';
comment on column pages.icon      is 'Emoji glyph, or an image URL / data URI.';
comment on column pages.story     is 'Project blurb, shown as the page description.';
comment on column pages.status    is 'open | done | archived (meaningful for kind=''project'').';
comment on column pages.content   is 'Ordered block list (jsonb). Whole-doc LWW — concurrent offline edits collide; acceptable single-user.';
comment on column pages.sort_key  is 'Fractional order key among siblings (base-36 midpoint string; sorts identically in SQL and JS).';

comment on table sessions is 'Claude Code work sessions — the kanban cards. Upserted by /project:track via repo_path+branch among open sessions.';
comment on column sessions.status       is 'active | paused | blocked | done — the board columns.';
comment on column sessions.objective_id is 'LEGACY twin of page_id (no FK since the pages migration). Dual-written until the frontend is fully off it.';
comment on column sessions.page_id      is 'The page this session ladders up to. Attaching promotes a plain page to kind=''project''.';
comment on column sessions.next_step    is 'One imperative line — what to do next.';
comment on column sessions.summary      is 'Last "what happened" blurb; also written to session_events as the worklog.';
comment on column sessions.last_touched is 'Activity clock for board ordering (distinct from updated_at, the LWW clock).';

comment on table session_events is 'Append-only worklog per session (kind: track | log | status …).';
comment on column session_events.at   is 'Event time (updated_at is the sync clock, not the event time).';
comment on column session_events.kind is 'track (from /project:track) | log (manual) | status changes.';

comment on table reports is 'Claude-published HTML reports, browsable in Explore. html is the full self-contained document.';
comment on column reports.page_id is 'Project page this report belongs to (replaces objective_id).';

comment on table udb_databases is 'User-defined databases (Notion-style): the definition row. User schemas are DATA in udb_* — fixed physical tables so the sync TABLES list never changes.';
comment on column udb_databases.icon    is 'Emoji glyph, or an image URL / data URI (sidebar + header).';
comment on column udb_databases.page_id is 'Page this database lives under (sidebar child of that page).';
comment on column udb_databases.views   is 'Future board/chart view configs (jsonb array); unused in v1, reserved to dodge the no-migration problem.';

comment on table udb_properties is 'Typed columns of a user database. type: title|text|number|select|multi_select|date|url|checkbox|relation|formula|rollup.';
comment on column udb_properties.config is 'Per-type config (jsonb): select options {id,name,color}; relation {target_db,pair,owner}; formula {expr — raw SQL over sibling columns}; rollup {relation_prop,target_prop,agg,date_prop}; number {format,precision}; date {end}.';
comment on column udb_properties.sort_key is 'Fractional column-order key (base-36 midpoint string).';
comment on column udb_properties.width    is 'Column width in px (drag-resized); null = per-type default.';

comment on table udb_rows is 'Rows of user databases. Values live in one jsonb keyed by PROPERTY ID (rename-safe). Derived values (formula/rollup) are computed on read, never stored.';
comment on column udb_rows.icon     is 'Emoji glyph, or an image URL / data URI.';
comment on column udb_rows.vals     is '{ "<property uuid>": value } — number: number; select: option id; multi_select: option-id array; date: {start,end?}; checkbox: bool; text/url/title: string. Readable join: jsonb_object_agg(p.name, r.vals->p.id::text).';
comment on column udb_rows.sort_key is 'Fractional row-order key (base-36 midpoint string).';

comment on table udb_links is 'Relation instances (m2m). Stored ONLY under the owner side''s property; the reverse property queries with from/to swapped. No unique constraint (LWW upserts by id) — readers dedupe.';
comment on column udb_links.prop_id  is 'The OWNER-side relation property (config.owner = true).';
comment on column udb_links.from_row is 'Row in the owner property''s database.';
comment on column udb_links.to_row   is 'Row in the target database.';

comment on table sync_state is 'Local-only LWW watermarks (singleton id=1). Stores the max updated_at actually seen, not now() — robust to clock skew.';
comment on column sync_state.last_pulled_at is 'Remote-clock watermark: pull fetches remote rows newer than this.';
comment on column sync_state.last_pushed_at is 'Local-clock watermark: push sends own-origin rows newer than this.';

-- The LWW quartet is on every synced table — document once, apply everywhere.
do $$
declare t text;
begin
  foreach t in array array['clients','objectives','pages','sessions','session_events','reports',
                           'udb_databases','udb_properties','udb_rows','udb_links'] loop
    execute format('comment on column %I.id is %L', t, 'PK. uuidv7() on newer tables (time-ordered), gen_random_uuid() v4 on the originals — minted per node, no sequence (offline multi-writer).');
    execute format('comment on column %I.origin is %L', t, 'NODE_ID that wrote the row — push only sends own-origin rows (not ones just pulled).');
    execute format('comment on column %I.updated_at is %L', t, 'LWW clock: on conflict the newer updated_at wins, on both ends of the sync.');
    execute format('comment on column %I.deleted is %L', t, 'Soft delete so deletions propagate through sync; readers filter "not deleted".');
  end loop;
end $$;
