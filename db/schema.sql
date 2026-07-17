-- Shared schema. Runs on BOTH the hub's Postgres and each laptop's local PGlite,
-- so the SQL is identical everywhere (that's the whole point of PGlite over SQLite).
-- Requires Postgres 18+ (uuidv7() on the udb_* tables) = PGlite 0.5.x and the
-- postgres:18 hub image. Older tables keep gen_random_uuid() (v4) — changing a
-- default rewrites nothing and existing ids stay valid; new udb ids are time-ordered v7.

-- Every synced row carries: id (uuid), updated_at (LWW clock), origin (which node
-- wrote it), deleted (soft-delete so deletions propagate). The custom sync uses these.

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text,
  origin text not null default 'seed',
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);

-- LEGACY: superseded by pages (kind='project'). Kept as the frozen migration
-- source — nothing reads or writes it anymore. Drop once every machine migrated.
create table if not exists objectives (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  story text not null default '',
  client_id uuid references clients (id),
  status text not null default 'open',      -- open | done | archived
  origin text not null default 'seed',
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);

-- Pages (Notion-style): one nestable tree for everything. kind='project' pages are
-- the former objectives — migrated with the SAME ids, so session/report links carry
-- over as a value copy. Body = ordered block list in `content`; databases live on a
-- page via udb_databases.page_id (sidebar child) or inline as a {type:'database'} block.
create table if not exists pages (
  id uuid primary key default uuidv7(),
  parent_id uuid,                           -- null = top level; no FK: LWW pull is updated_at-ordered, so a child can arrive before its parent — readers tolerate orphans
  kind text not null default 'page',   -- page | project
  title text not null default '',
  icon text,
  story text not null default '',       -- project blurb, shown as the page description
  client_id uuid references clients (id),
  status text not null default 'open',   -- open | done | archived (projects)
  content jsonb not null default '[]',    -- ordered blocks (LWW whole-doc; fine single-user)
  sort_key text not null default 'a0',     -- fractional key: order among siblings
  origin text not null default 'seed',
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);
create index if not exists pages_parent on pages (parent_id);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  status text not null default 'active',  -- active | paused | blocked | done
  client_id uuid references clients (id),
  objective_id uuid references objectives (id),
  repo_path text,
  branch text,
  next_step text,
  pr_url text,
  summary text not null default '',
  last_touched timestamptz not null default now(),
  origin text not null default 'seed',
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);

-- Kanban statuses (the board columns). User-editable: add/rename/recolor/reorder/delete.
-- sessions.status stores the `key` (a stable slug), NOT the id, so existing rows and the
-- (repo,branch) upsert keep working. `terminal` marks done-like statuses (collapses the
-- card, ends the active-session lookup). Built-ins are seeded below with FIXED ids so every
-- node inserts the same rows and LWW sync dedupes them instead of forking four copies.
create table if not exists statuses (
  id uuid primary key default uuidv7(),
  key text not null,                    -- stable slug stored on sessions.status
  label text not null,
  color text not null,                    -- hex
  terminal boolean not null default false,   -- done-like: collapses cards, ends the active-session lookup
  sort_key text not null default 'a0',       -- fractional key: column order
  origin text not null default 'seed',
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);
insert into statuses (id, key, label, color, terminal, sort_key) values
('00000000-0000-4000-8000-000000000001', 'active', 'Active', '#7bd88f', false, 'a0'),
('00000000-0000-4000-8000-000000000002', 'paused', 'Paused', '#e3c567', false, 'a1'),
('00000000-0000-4000-8000-000000000003', 'blocked', 'Blocked', '#e06c75', false, 'a2'),
('00000000-0000-4000-8000-000000000004', 'done', 'Done', '#6b7280', true, 'a3')
on conflict (id) do nothing;

-- Users: profile only — credentials come with the hub API (Phase 3) and stay hub-only,
-- so no secrets ever ride the laptop sync. Synced so every node renders authors offline.
-- The initial user is seeded with a FIXED id (same reason as the statuses seed): every
-- node inserts the identical row and LWW dedupes it instead of forking one per node.
-- Name is empty on purpose (display falls back to the node id) — set it via ⚙ Settings.
create table if not exists users (
  id uuid primary key default uuidv7(),
  name text not null default '',
  avatar text not null default '',        -- image URL or (downscaled) data URI
  origin text not null default 'seed',
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);
insert into users (id) values
('00000000-0000-4000-8000-000000000101')
on conflict (id) do nothing;
-- member sees the whole workspace (the original single-user behavior); guest sees
-- only subtrees shared to them — enforced by the hub API, not the schema.
alter table users add column if not exists role text not null default 'member';

-- Per-page shares (hub-API migration, phase 7): grants a user access to a page's
-- whole subtree incl. attached databases. role: viewer (pull only) | editor (can
-- write pages/comments/db rows in the subtree). Normal synced rows — created from
-- the app UI, enforced by the hub API on /sync. Soft-deleting revokes: the API
-- sends tombstones so the guest's replica masks the subtree on next sync.
create table if not exists page_shares (
  id uuid primary key default uuidv7(),
  page_id uuid not null,   -- no FK: LWW pull order
  user_id uuid not null,   -- no FK: LWW pull order
  role text not null default 'editor',   -- viewer | editor
  origin text not null default 'seed',
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);
create index if not exists page_shares_page on page_shares (page_id);
create index if not exists page_shares_user on page_shares (user_id);

-- Public share links: a capability URL for a read-only browser view of a page's
-- subtree, served by the hub's separate public listener (no account, no app).
-- Only the sha-256 of the token is stored (and synced); the raw link is shown once
-- at creation. Soft-delete revokes it. Comments are never rendered on link views.
create table if not exists page_links (
  id uuid primary key default uuidv7(),
  page_id uuid not null,   -- no FK: LWW pull order
  token_hash text not null,
  origin text not null default 'seed',
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);
create index if not exists page_links_page on page_links (page_id);
create index if not exists page_links_token on page_links (token_hash);

-- Devices: NODE_ID -> user mapping ("which user am I" for a node). Rows are claimed
-- at app startup with id = uuidv5(node_id) so concurrent claims converge on one row
-- (see app/identity.ts). No unique(node_id): LWW upserts by id — deterministic ids
-- make duplicates structurally impossible.
create table if not exists devices (
  id uuid primary key default uuidv7(),
  node_id text not null,
  user_id uuid not null,   -- no FK: LWW pull order (see pages.parent_id)
  origin text not null default 'seed',
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);
create index if not exists devices_node on devices (node_id);

-- Inline page comments (Notion-style, block-level). Anchored to a block by its stable
-- id inside pages.content; no FK on page_id/block_id (LWW pull is updated_at-ordered, a
-- comment can arrive before its page — readers tolerate orphans and keep `anchor` as a
-- text snapshot to still show a removed block's note). One row = one note + resolve toggle.
create table if not exists page_comments (
  id uuid primary key default uuidv7(),
  page_id uuid not null,
  block_id text not null,                    -- Block.id within pages.content
  anchor text not null default '',         -- snapshot of the block text when commented
  body text not null default '',
  author text not null default '',          -- display name of who wrote it (settings.json authorName, else node id)
  author_avatar text not null default '',        -- optional avatar of the author: image URL or (downscaled) data URI
  resolved boolean not null default false,
  origin text not null default 'seed',
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);
create index if not exists page_comments_page on page_comments (page_id);
-- idempotent guard: dirs that created page_comments before these columns existed
alter table page_comments add column if not exists author text not null default '';
alter table page_comments add column if not exists author_avatar text not null default '';

-- Identity links (hub-API migration, phase 1). author/author_avatar stay as the
-- denormalized write-time snapshot; author_id/owner_id are the durable identity.
alter table page_comments add column if not exists author_id uuid;   -- no FK: LWW pull order
alter table pages add column if not exists owner_id uuid;            -- creating user; no FK

-- Optional generation stats on an agent answer (comment watcher): JSON string
-- {model, in, out, ms}. Null on human comments. Rendered as a dim footer.
alter table page_comments add column if not exists meta text;

-- Backfill to the seeded user (sole user today). Agent comments are exempt: they
-- carry the reserved sentinel 00000000-0000-4000-8000-0000000000aa, never null.
-- Fills nulls only and deliberately
-- leaves updated_at/origin untouched: every replica runs this same deterministic
-- backfill locally, so nothing rides the sync and no node claims the rows as its own.
-- Guarded to the single-user era (same rule as the startup device claim) so a second
-- user's not-yet-attributed rows are never misassigned by a later re-run.
-- (pages backfill sits after the legacy pages migrations below, to catch their copies.)
update page_comments set author_id = '00000000-0000-4000-8000-000000000101'
where author_id is null and (
  select count(*) from users
  where not deleted
) = 1;

-- Watcher status for human replies on agent threads (comment watcher). One row per
-- watched reply, written ONLY by the watcher daemon — deliberately not columns on
-- page_comments: sync is whole-row LWW, so a status write on the reply row could
-- clobber a concurrent body edit from another node. page_id is denormalized so the
-- hub ACL gates it like page_comments. body_hash pins the reply text the status
-- refers to: an edited reply re-triggers the watcher, a resolve toggle does not.
create table if not exists comment_agent_status (
  id uuid primary key default uuidv7(),
  comment_id uuid not null,             -- page_comments.id; no FK: LWW pull order
  page_id uuid not null,                -- denormalized for ACL/pruning; no FK
  status text not null default 'seen',  -- seen | answering | failed
  agent text not null default '',       -- codex | claude (who is handling it)
  body_hash text not null default '',   -- md5(reply body) when the status was set
  origin text not null default 'seed',
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);
create index if not exists comment_agent_status_comment on comment_agent_status (comment_id);
create index if not exists comment_agent_status_page on comment_agent_status (page_id);

create table if not exists session_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions (id),
  at timestamptz not null default now(),
  summary text,
  kind text not null default 'track',
  origin text not null default 'seed',
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);

create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  html text not null default '',
  client_id uuid references clients (id),
  objective_id uuid references objectives (id),
  created_at timestamptz not null default now(),
  origin text not null default 'seed',
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);

-- User-defined databases (Notion-style). Fixed physical tables; user schemas are
-- data inside them. Derived values (formula/rollup) are computed on read, never stored.

create table if not exists udb_databases (
  id uuid primary key default uuidv7(),
  name text not null,
  icon text,
  sort_key text not null default 'a0',    -- fractional key: sidebar order
  views jsonb not null default '[]',   -- future board/chart view configs; unused in v1
  origin text not null default 'seed',
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);

create table if not exists udb_properties (
  id uuid primary key default uuidv7(),
  db_id uuid not null references udb_databases (id),
  name text not null,
  type text not null,   -- title|text|number|select|multi_select|date|url|checkbox|relation|formula|rollup
  config jsonb not null default '{}',   -- per-type config (options, relation pair, formula expr, rollup agg…)
  sort_key text not null,                 -- fractional key: column order
  width int,                           -- optional column width (px)
  origin text not null default 'seed',
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);
create index if not exists udb_properties_db on udb_properties (db_id);

create table if not exists udb_rows (
  id uuid primary key default uuidv7(),
  db_id uuid not null references udb_databases (id),
  icon text,                          -- emoji glyph, or an image URL / data URI
  vals jsonb not null default '{}',   -- { "<property uuid>": <typed value> } — id-keyed = rename-safe
  sort_key text not null,                 -- fractional key: row order
  origin text not null default 'seed',
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);
-- idempotent guard: dirs created before the icon column existed (no migration system)
alter table udb_rows add column if not exists icon text;
create index if not exists udb_rows_db on udb_rows (db_id);

-- Relation links, stored ONLY under the owner side of a relation pair; the reverse
-- property queries with from/to swapped. No unique constraint (LWW sync upserts by
-- id, cross-node duplicates possible) — dedupe on read.
create table if not exists udb_links (
  id uuid primary key default uuidv7(),
  prop_id uuid not null references udb_properties (id),
  from_row uuid not null references udb_rows (id),
  to_row uuid not null references udb_rows (id),
  origin text not null default 'seed',
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);
create index if not exists udb_links_from on udb_links (prop_id, from_row);
create index if not exists udb_links_to on udb_links (prop_id, to_row);

-- Coding-agent linkage. claude_id keeps its legacy name for a compatible migration,
-- but stores either a Claude or Codex transcript UUID; agent identifies the provider.
alter table sessions add column if not exists claude_id uuid;
alter table sessions add column if not exists agent text;

-- Objectives → pages migration (idempotent: copy is conflict-do-nothing, backfills
-- only fill nulls, and the dual-write in upsertSession keeps both columns equal
-- until the frontend is fully off objective_id).
alter table sessions add column if not exists page_id uuid references pages (id);
alter table reports add column if not exists page_id uuid references pages (id);
alter table udb_databases add column if not exists page_id uuid references pages (id);
-- new project pages exist only in pages, so the objectives FKs must go
alter table sessions drop constraint if exists sessions_objective_id_fkey;
alter table reports drop constraint if exists reports_objective_id_fkey;
insert into pages (id, kind, title, story, client_id, status, origin, updated_at, deleted)
select
  id,
  'project',
  title,
  story,
  client_id,
  status,
  origin,
  updated_at,
  deleted
from objectives
on conflict (id) do nothing;
update sessions set page_id = objective_id
where page_id is null and objective_id is not null;
update reports set page_id = objective_id
where page_id is null and objective_id is not null;

-- Project → Story fold: clients become top-level kind='project' pages (Project),
-- former project pages become kind='story' nested under them. Reusing the client id
-- as the Project page id means every existing client_id reference (sessions, stories)
-- already points at the right Project — no re-pointing needed. Idempotent: the insert
-- is conflict-do-nothing, and the update no-ops once old projects are already stories
-- (a real client id can never match the `id not in (select id from clients)` guard).
alter table pages add column if not exists color text;
-- client_id now holds a Project *page* id, not a clients-table id — the old FKs must go
alter table pages drop constraint if exists pages_client_id_fkey;
alter table sessions drop constraint if exists sessions_client_id_fkey;
alter table reports drop constraint if exists reports_client_id_fkey;
insert into pages (id, kind, title, color, origin, updated_at, deleted)
select
  id,
  'project',
  name,
  color,
  origin,
  updated_at,
  deleted
from clients
on conflict (id) do nothing;
update pages set kind = 'story', parent_id = coalesce(parent_id, client_id)
where kind = 'project' and client_id is not null and id not in (select id from clients);

-- Identity backfill for pages — after the legacy migrations so their copies are covered
-- in the same pass. Same rules and single-user guard as the page_comments backfill above.
update pages set owner_id = '00000000-0000-4000-8000-000000000101'
where owner_id is null and (
  select count(*) from users
  where not deleted
) = 1;

-- Local-only sync bookkeeping (harmless if it also exists on the hub).
create table if not exists sync_state (
  id int primary key default 1,
  last_pulled_at timestamptz not null default 'epoch',
  last_pushed_at timestamptz not null default 'epoch'
);
insert into sync_state (id) values (1) on conflict do nothing;
-- Hub-API sync cursor (phase 3): last change_log rev consumed. Null = never synced
-- through the API → next pass does a full snapshot. Independent of the timestamp
-- watermarks so either transport can take over without a re-pull storm.
alter table sync_state add column if not exists api_cursor bigint;

-- Change log (hub-API migration, phase 2). Per-replica, NOT synced. One mechanism,
-- three jobs: rev is the future pull cursor (server-issued, monotonic — client clocks
-- never order delivery), the triggers capture every write in the same transaction
-- (on the hub: coexistence capture of legacy direct-SQL pushes; locally: the durable
-- outbox source), and NOTIFY 'changes' is the future WS-nudge fan-out signal.
create table if not exists change_log (
  rev bigint generated always as identity primary key,
  entity text not null,               -- table name
  row_id uuid not null,
  op text not null,                   -- upsert | delete (soft-deletes log as delete)
  at timestamptz not null default now(),
  actor uuid,                         -- users.id; null until the API sets trame.actor (phase 3)
  source text                         -- 'api' | … ; null = legacy direct SQL / local write
);

create or replace function trame_log_change() returns trigger
language plpgsql as $fn$
begin
  insert into change_log (entity, row_id, op, actor, source)
  values (
    tg_table_name,
    case when tg_op = 'DELETE' then old.id else new.id end,
    case
      when tg_op = 'DELETE' then 'delete'
      when new.deleted then 'delete'
      else 'upsert'
    end,
    nullif(current_setting('trame.actor', true), '')::uuid,
    nullif(current_setting('trame.source', true), '')
  );
  perform pg_notify('changes', '');
  return null;
end;
$fn$;

do $$
declare t text;
begin
  foreach t in array array['users','devices','clients','pages','page_shares','page_links','page_comments','comment_agent_status','statuses','sessions',
                           'session_events','reports','udb_databases','udb_properties','udb_rows','udb_links'] loop
    execute format(
      'create or replace trigger %I after insert or update or delete on %I for each row execute function trame_log_change()',
      t || '_change_log', t
    );
  end loop;
end $$;

-- Compaction: this file re-runs on every local start and every hub deploy, so this
-- IS the scheduled cleanup. Safe: poll + cursor self-heal; a device offline >30 days
-- re-syncs from scratch.
delete from change_log
where at < now() - interval '30 days';

-- Catalog documentation (COMMENT ON is idempotent — safe to re-run every startup).
-- Shows up in \d+ / \dt+ so the schema is self-describing from psql on the hub too.

comment on table clients is 'Who the work is for (one per client/company). Referenced by sessions, pages, reports.';
comment on column clients.name is 'Display name; find-or-create key used by the CLI/MCP (resolveClient).';
comment on column clients.color is 'Chip color (hex); null = deterministic hash pick from the app palette.';

comment on table objectives is 'LEGACY — superseded by pages (kind=''project''), same ids. Frozen migration source; drop once every machine has migrated.';

comment on table pages is 'Notion-style page tree: one nestable hierarchy for everything. kind=''project'' pages are the former objectives (migrated with identical ids).';
comment on column pages.parent_id is 'Parent page; null = top level. Deliberately NO FK: LWW pull is updated_at-ordered so a child can arrive before its parent — readers tolerate orphans.';
comment on column pages.kind is 'page | project. Behavioral: a page becomes a project (one-way) when a session attaches. Projects carry story/status and are what sessions ladder up to.';
comment on column pages.icon is 'Emoji glyph, or an image URL / data URI.';
comment on column pages.story is 'Project blurb, shown as the page description.';
comment on column pages.status is 'open | done | archived (meaningful for kind=''project'').';
comment on column pages.content is 'Ordered block list (jsonb). Whole-doc LWW — concurrent offline edits collide; acceptable single-user.';
comment on column pages.sort_key is 'Fractional order key among siblings (base-36 midpoint string; sorts identically in SQL and JS).';
comment on column pages.owner_id is 'users.id of the creator (no FK: LWW pull order). Ownership semantics only — ACL enforcement is a later phase.';

comment on table page_comments is 'Inline block-level page comments (Notion-style). Anchored by block_id to a block in pages.content; one row = one note + resolve toggle. No FK (LWW pull ordering); anchor keeps the block''s text so a removed block''s note still renders.';
comment on column page_comments.author_id is 'users.id of the writer (no FK: LWW pull order). author/author_avatar stay as the write-time display snapshot.';

comment on table users is 'User profiles (identity for authors/owners). Profile only — credentials are hub-side (phase 3), never synced. The initial user is seeded with a fixed id so LWW dedupes across nodes.';
comment on column users.role is 'member (whole workspace, the original behavior) | guest (only shared subtrees). Enforced by the hub API on /sync.';

comment on table page_shares is 'Per-page access grants (phase 7): user × page × role, covering the page''s subtree + attached databases. viewer = read; editor = also write. Enforced by the hub API; soft-delete revokes via tombstones on the guest''s next pull.';
comment on column page_shares.role is 'viewer | editor.';

comment on table page_links is 'Public share links: capability URLs for a read-only browser view of a page''s subtree, served by the hub''s public listener. Stores only the sha-256 of the token; soft-delete revokes.';
comment on column users.name is 'Display name shown on comments; empty = fall back to the device''s node id.';
comment on column users.avatar is 'Image URL or (downscaled) data URI.';

comment on table devices is 'NODE_ID -> user mapping. Claimed at app startup with id = uuidv5(node_id) so concurrent claims converge; unclaimed nodes wait for the hub-API claim flow (phase 3).';
comment on column devices.node_id is 'The device''s NODE_ID (TRACKER_NODE_ID env, else hostname) — same value rows carry as origin.';
comment on column devices.user_id is 'users.id this device writes as (no FK: LWW pull order).';

comment on table sessions is 'Coding-agent work sessions — the kanban cards. Upserted by the Trame tracking skill via transcript id or repo_path+branch.';
comment on column sessions.status is 'active | paused | blocked | done — the board columns.';
comment on column sessions.objective_id is 'LEGACY twin of page_id (no FK since the pages migration). Dual-written until the frontend is fully off it.';
comment on column sessions.page_id is 'The page this session ladders up to. Attaching promotes a plain page to kind=''project''.';
comment on column sessions.next_step is 'One imperative line — what to do next.';
comment on column sessions.claude_id is 'LEGACY NAME: Claude Code or Codex transcript UUID. Imported cards also carry it as their id.';
comment on column sessions.agent is 'Transcript provider: claude or codex. Null on older/manual cards; resume detects legacy Claude imports.';
comment on column sessions.summary is 'Last "what happened" blurb; also written to session_events as the worklog.';
comment on column sessions.last_touched is 'Activity clock for board ordering (distinct from updated_at, the LWW clock).';

comment on table statuses is 'Kanban board columns — user-editable. sessions.status stores statuses.key (a stable slug), not the id. terminal marks done-like columns. Built-ins (active/paused/blocked/done) are seeded with fixed ids so LWW sync dedupes them.';
comment on column statuses.key is 'Stable slug written to sessions.status; immutable after creation so existing sessions never orphan.';
comment on column statuses.terminal is 'Done-like: collapses the card and excludes the session from the (repo,branch) active-session lookup.';

comment on table session_events is 'Append-only worklog per session (kind: track | log | status …).';
comment on column session_events.at is 'Event time (updated_at is the sync clock, not the event time).';
comment on column session_events.kind is 'track (from /project:track) | log (manual) | status changes.';

comment on table reports is 'Claude-published HTML reports, browsable in Explore. html is the full self-contained document.';
comment on column reports.page_id is 'Project page this report belongs to (replaces objective_id).';

comment on table udb_databases is 'User-defined databases (Notion-style): the definition row. User schemas are DATA in udb_* — fixed physical tables so the sync TABLES list never changes.';
comment on column udb_databases.icon is 'Emoji glyph, or an image URL / data URI (sidebar + header).';
comment on column udb_databases.page_id is 'Page this database lives under (sidebar child of that page).';
comment on column udb_databases.views is 'Future board/chart view configs (jsonb array); unused in v1, reserved to dodge the no-migration problem.';

comment on table udb_properties is 'Typed columns of a user database. type: title|text|number|select|multi_select|date|url|checkbox|relation|formula|rollup.';
comment on column udb_properties.config is 'Per-type config (jsonb): select options {id,name,color}; relation {target_db,pair,owner}; formula {expr — raw SQL over sibling columns}; rollup {relation_prop,target_prop,agg,date_prop}; number {format,precision}; date {end}.';
comment on column udb_properties.sort_key is 'Fractional column-order key (base-36 midpoint string).';
comment on column udb_properties.width is 'Column width in px (drag-resized); null = per-type default.';

comment on table udb_rows is 'Rows of user databases. Values live in one jsonb keyed by PROPERTY ID (rename-safe). Derived values (formula/rollup) are computed on read, never stored.';
comment on column udb_rows.icon is 'Emoji glyph, or an image URL / data URI.';
comment on column udb_rows.vals is '{ "<property uuid>": value } — number: number; select: option id; multi_select: option-id array; date: {start,end?}; checkbox: bool; text/url/title: string. Readable join: jsonb_object_agg(p.name, r.vals->p.id::text).';
comment on column udb_rows.sort_key is 'Fractional row-order key (base-36 midpoint string).';

comment on table udb_links is 'Relation instances (m2m). Stored ONLY under the owner side''s property; the reverse property queries with from/to swapped. No unique constraint (LWW upserts by id) — readers dedupe.';
comment on column udb_links.prop_id is 'The OWNER-side relation property (config.owner = true).';
comment on column udb_links.from_row is 'Row in the owner property''s database.';
comment on column udb_links.to_row is 'Row in the target database.';

comment on table change_log is 'Per-replica write log (NOT synced), trigger-fed in the mutation''s own txn. rev = the future server pull cursor; hub side captures legacy direct-SQL pushes during coexistence; local side is the durable outbox source. Compacted to 30 days on every schema run.';
comment on column change_log.rev is 'Monotonic, replica-issued. The ordering authority for the future changeset /sync — never a client clock.';
comment on column change_log.op is 'upsert | delete. Soft-deletes (deleted=true) log as delete; readers of the log never need the LWW envelope.';
comment on column change_log.actor is 'users.id of the writer; null until the API stamps trame.actor (phase 3+).';
comment on column change_log.source is 'Write channel (''api'' once it exists); null = legacy direct SQL or a local PGlite write.';

comment on table sync_state is 'Local-only LWW watermarks (singleton id=1). Stores the max updated_at actually seen, not now() — robust to clock skew.';
comment on column sync_state.last_pulled_at is 'Remote-clock watermark: pull fetches remote rows newer than this.';
comment on column sync_state.last_pushed_at is 'Local-clock watermark: push sends own-origin rows newer than this.';

-- The LWW quartet is on every synced table — document once, apply everywhere.
do $$
declare t text;
begin
  foreach t in array array['clients','objectives','pages','page_comments','comment_agent_status','statuses','sessions','session_events','reports',
                           'udb_databases','udb_properties','udb_rows','udb_links','users','devices','page_shares','page_links'] loop
    execute format('comment on column %I.id is %L', t, 'PK. uuidv7() on newer tables (time-ordered), gen_random_uuid() v4 on the originals — minted per node, no sequence (offline multi-writer).');
    execute format('comment on column %I.origin is %L', t, 'NODE_ID that wrote the row — push only sends own-origin rows (not ones just pulled).');
    execute format('comment on column %I.updated_at is %L', t, 'LWW clock: on conflict the newer updated_at wins, on both ends of the sync.');
    execute format('comment on column %I.deleted is %L', t, 'Soft delete so deletions propagate through sync; readers filter "not deleted".');
  end loop;
end $$;
