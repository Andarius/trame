// Local database = PGlite (embedded Postgres, persisted to DATA_DIR).
// Same SQL as the hub's Postgres — no dialect translation.
import { PGlite } from "@electric-sql/pglite";
import { v5 } from "@std/uuid";
import { APP_ROOT, DATA_DIR, NODE_ID, OUTBOX } from "./config.ts";
import { pageBlocksToMarkdown } from "./page-markdown.ts";
import { midKey } from "./udb.ts";

// Memoize a single init PROMISE so concurrent callers all await the same fully-initialized
// instance (waitReady + schema applied) — otherwise an early query races the schema exec
// and hits "relation does not exist".
let _pg: Promise<PGlite> | null = null;

const OK_MARKER = `${DATA_DIR}/.trame-ok`;

async function openPg(): Promise<PGlite> {
  const pg = new PGlite(DATA_DIR);
  await pg.waitReady;
  // dev: schema from the repo; bundled installs: embedded copy
  const schema = await Deno.readTextFile(`${APP_ROOT}/../db/schema.sql`)
    .catch(async () => (await import("./embed.ts")).SCHEMA);
  await pg.exec(schema);
  // claim the device→user mapping as part of init (with the handle — db() would deadlock
  // on its own memoized promise) so any first db touch, not just server startup, claims.
  const { claimDevice } = await import("./identity.ts");
  await claimDevice(pg).catch(console.error);
  await Deno.writeTextFile(OK_MARKER, "1"); // init completed — dir is real data from now on
  return pg;
}

export function db(): Promise<PGlite> {
  if (!_pg) {
    _pg = (async () => {
      // PGlite data dirs are not portable across major PG versions (0.5.x = PG 18).
      // Check BEFORE any open/recovery so an old dir is never opened in place or
      // mistaken for a half-initialized one and wiped.
      const pgVersion = await Deno.readTextFile(`${DATA_DIR}/PG_VERSION`).then((s) => s.trim()).catch(() => null);
      if (pgVersion && pgVersion !== "18") {
        throw new Error(`data dir ${DATA_DIR} is Postgres ${pgVersion} format — this build needs 18`);
      }
      // PGlite's mkdir isn't recursive — ensure the parent exists first.
      await Deno.mkdir(DATA_DIR.replace(/\/[^/]+\/?$/, ""), { recursive: true }).catch(() => {});
      try {
        return await openPg();
      } catch (e) {
        // A crashed first init leaves a half-written dir that aborts every open.
        // Only auto-recover when init never completed (no marker) — never wipe real data.
        const initialized = await Deno.stat(OK_MARKER).then(() => true).catch(() => false);
        if (initialized) throw e;
        console.error("PGlite init failed on a half-initialized dir — recreating it.");
        await Deno.remove(DATA_DIR, { recursive: true }).catch(() => {});
        return await openPg();
      }
    })().catch((e) => {
      _pg = null; // don't cache a failed init — allow a retry
      throw e;
    });
  }
  return _pg;
}

export async function getBoard() {
  const pg = await db();
  // Project > Story > Session. "projects" = top-level Project pages (shape {id,name,color}
  // for the chip/sidebar); "stories" = Story pages (what sessions ladder to).
  const projects = (await pg.query(
    `select id, title as name, color, icon from pages where kind='project' and not deleted order by title`,
  )).rows;
  const stories = (await pg.query(`select * from pages where kind='story' and not deleted order by title`)).rows;
  const sessions = (await pg.query(`select * from sessions where not deleted order by last_touched desc`)).rows;
  const pages = (await pg.query(
    `select id, parent_id, kind, title, icon, client_id, color from pages where not deleted order by title`,
  )).rows;
  const statuses = (await pg.query(
    `select id, key, label, color, terminal, sort_key from statuses where not deleted order by sort_key`,
  )).rows;
  return { projects, stories, sessions, pages, statuses };
}

const PALETTE = ["#7a9ee7", "#b590e7", "#c98a63", "#7bd88f", "#e3c567"];

// owner_id for page inserts, resolved from the origin param already in the statement
// (a subquery, not identity.ts, to keep db.ts free of an import cycle). Null while
// the device is unclaimed.
const OWNER_ID_SQL = (originParam: number) =>
  `(select user_id from devices where node_id=$${originParam} and not deleted limit 1)`;

// "client" is now the top-level Project page — find-or-create by title.
export async function resolveClient(name: string, color?: string): Promise<string> {
  const pg = await db();
  const hit = (await pg.query(
    `select id from pages where kind='project' and title=$1 and not deleted limit 1`,
    [name],
  )).rows[0] as { id: string } | undefined;
  if (hit) return hit.id;
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  const col = color ?? PALETTE[Math.abs(h) % PALETTE.length];
  const row = (await pg.query(
    `insert into pages (kind, title, color, origin, owner_id)
     values ('project',$1,$2,$3,${OWNER_ID_SQL(3)}) returning id`,
    [name, col, NODE_ID],
  )).rows[0] as { id: string };
  return row.id;
}

// Home project for a page an agent creates from a repo: the project of the session that
// owns this path, else a project whose title is a path segment, else Side-projects. Keeps
// agent-authored pages out of the Unfiled inbox.
export async function resolveHomeProject(repoPath: string): Promise<string | null> {
  const path = repoPath.replace(/\/+$/, "");
  if (!path) return null;
  const pg = await db();
  const bySession = (await pg.query(
    `select client_id from sessions
      where not deleted and client_id is not null and repo_path is not null
        and starts_with($1 || '/', repo_path || '/')
      order by length(repo_path) desc, last_touched desc limit 1`,
    [path],
  )).rows[0] as { client_id: string } | undefined;
  if (bySession) return bySession.client_id;
  const byPath = (await pg.query(
    `select id from pages where kind='project' and not deleted and position('/' || title || '/' in $1) > 0
     order by length(title) desc limit 1`,
    [path + "/"],
  )).rows[0] as { id: string } | undefined;
  return byPath ? byPath.id : await resolveClient("Side-projects");
}

// A Story is a kind='story' page nested under its Project (clientId). Find-or-create by
// title — trimmed, case- and whitespace-insensitive, so wording drift does not mint a
// duplicate. Another project's stories are off-limits; an unfiled plain page is still
// reused (and promoted on attach) rather than duped. Exact spelling, then a story, then
// the caller's own project win the tie.
export async function resolveStory(title: string, clientId: string | null): Promise<string> {
  const clean = title.trim().replace(/\s+/g, " ");
  if (!clean) throw new Error("a story needs a title");
  const pg = await db();
  const hit = (await pg.query(
    `select id from pages
      where kind in ('story','page') and not deleted
        and lower(regexp_replace(trim(title), '\\s+', ' ', 'g')) = lower($1)
        and ($2::uuid is null or client_id = $2 or client_id is null)
      order by (title = $1) desc, (kind='story') desc,
               (client_id is not distinct from $2::uuid) desc, updated_at desc
      limit 1`,
    [clean, clientId],
  )).rows[0] as { id: string } | undefined;
  if (hit) return hit.id;
  const row = (await pg.query(
    `insert into pages (kind, title, client_id, parent_id, origin, owner_id)
     values ('story',$1,$2,$2,$3,${OWNER_ID_SQL(3)}) returning id`,
    [clean, clientId, NODE_ID],
  )).rows[0] as { id: string };
  return row.id;
}

export async function createStory(o: { title: string; brief?: string; client?: string }): Promise<string> {
  const pg = await db();
  const clientId = o.client ? await resolveClient(o.client) : null;
  const row = (await pg.query(
    `insert into pages (kind, title, brief, client_id, parent_id, origin, owner_id)
     values ('story',$1,$2,$3,$3,$4,${OWNER_ID_SQL(4)}) returning id`,
    [o.title, o.brief ?? "", clientId, NODE_ID],
  )).rows[0] as { id: string };
  return row.id;
}

// Attaching a session promotes a plain page to a Story (one-way), nesting it under its
// Project if one was given. Projects themselves are never demoted to stories.
async function promoteToProject(pageId: string, clientId: string | null): Promise<void> {
  const pg = await db();
  await pg.query(
    `update pages set kind='story', client_id=coalesce(client_id,$2), parent_id=coalesce(parent_id,$2),
       origin=$3, updated_at=now()
      where id=$1 and kind='page' and not deleted`,
    [pageId, clientId, NODE_ID],
  );
}

// Deterministic per-session spec-page id: independent nodes find-or-create the SAME
// row, so whole-row LWW converges without coordination (same trick as statusId).
const SPECS_NS = "b2f6c1d8-4e5a-4b7c-8f1d-2a9e6c3b0d47";
export const specsPageId = (sessionId: string) =>
  v5.generate(SPECS_NS, new TextEncoder().encode(sessionId));

// Find-or-create the session's spec page: a subpage of the story (fallback: the
// project page, else detached), titled after the session. Resurrects a deleted one.
export async function ensureSpecsPage(sessionId: string): Promise<string> {
  const pg = await db();
  const s = (await pg.query(
    `select title, client_id, page_id, specs_page_id from sessions where id=$1 and not deleted`,
    [sessionId],
  )).rows[0] as {
    title: string;
    client_id: string | null;
    page_id: string | null;
    specs_page_id: string | null;
  } | undefined;
  if (!s) throw new Error(`unknown session ${sessionId}`);
  if (s.specs_page_id) {
    const live = (await pg.query(`select 1 from pages where id=$1 and not deleted`, [s.specs_page_id])).rows[0];
    if (live) return s.specs_page_id;
  }
  const id = await specsPageId(sessionId);
  await pg.query(
    `insert into pages (id, kind, title, client_id, parent_id, origin, owner_id)
     values ($1,'page',$2,$3,$4,$5,${OWNER_ID_SQL(5)})
     on conflict (id) do update set deleted=false, origin=$5, updated_at=now()
     where pages.deleted`,
    [id, `Specs — ${s.title}`, s.client_id, s.page_id ?? s.client_id, NODE_ID],
  );
  await pg.query(
    `update sessions set specs_page_id=$2, origin=$3, updated_at=now() where id=$1`,
    [sessionId, id, NODE_ID],
  );
  return id;
}

// Columns are user-editable, but the session default, the importers and the tracking
// skills all still emit fixed keys ('active'…) — park an unknown one on a surviving
// column, else the card renders in no column at all.
async function resolveStatusKey(pg: PGlite, key: unknown): Promise<string> {
  const want = typeof key === "string" && key ? key : "active";
  const rows = (await pg.query(
    `select key from statuses where not deleted order by terminal, sort_key`,
  )).rows as { key: string }[];
  if (!rows.length) return want; // not seeded yet — keep the caller's key
  return rows.some((r) => r.key === want) ? want : rows[0].key;
}

export async function upsertSession(s: Record<string, unknown>): Promise<string> {
  const pg = await db();
  // claude_id is the column name; the public writer says agent_id (Claude or Codex).
  s.claude_id ??= s.agent_id;
  if (s.claude_id && !s.agent) s.agent = "claude";
  // Accept human names (from the CLI/MCP) and resolve them to ids.
  if (typeof s.client === "string" && !s.client_id) s.client_id = await resolveClient(s.client);
  // One coding-agent transcript maps to one card, regardless of import vs skill tracking —
  // but only within a branch and among open cards. A session that moves on to another
  // branch earns its own card instead of retitling the one it just finished, and a card
  // the user marked done is never resurrected. An unbranched card (a fresh import) still
  // adopts the first branch it is tracked with.
  if (!s.id && s.claude_id) {
    const hit = (await pg.query(
      `select id from sessions where (claude_id=$1 or id=$1) and not deleted
         and status not in (select key from statuses where terminal and not deleted)
         and ($2 = '' or coalesce(branch,'') in ('', $2))
       order by last_touched desc limit 1`,
      [s.claude_id, (s.branch as string) ?? ""],
    )).rows[0] as { id: string } | undefined;
    if (hit) s.id = hit.id;
  }
  // Upsert by (repo_path, branch) among open sessions when no id is given. "Open" = any
  // non-terminal status (done-like statuses are user-defined, so ask the statuses table).
  if (!s.id && s.repo_path) {
    const hit = (await pg.query(
      `select id from sessions where repo_path=$1 and coalesce(branch,'')=$2 and not deleted
         and status not in (select key from statuses where terminal and not deleted)
       order by last_touched desc limit 1`,
      [s.repo_path, (s.branch as string) ?? ""],
    )).rows[0] as { id: string } | undefined;
    if (hit) s.id = hit.id;
  }
  // Resolve the story name only now, with the session KNOWN: an attached session keeps
  // its page whatever the wording — only an explicit page_id (the drawer) retargets.
  // Resolving before the lookup minted a fresh story on every rewording and orphaned
  // the old one.
  if (s.page_id === undefined && typeof s.story === "string" && s.story.trim()) {
    const cur = s.id
      ? (await pg.query(`select page_id from sessions where id=$1 and not deleted`, [s.id]))
        .rows[0] as { page_id: string | null } | undefined
      : undefined;
    if (!cur?.page_id) s.page_id = await resolveStory(s.story, (s.client_id as string) ?? null);
  }
  // project = a page that has sessions: attaching promotes a plain page (one-way)
  if (s.page_id) await promoteToProject(s.page_id as string, (s.client_id as string) ?? null);
  const id = (s.id as string) ?? crypto.randomUUID();
  // Transcript linkage: null never clobbers (UI edits omit it); a fresh value wins.
  // page_id is tri-state: absent = keep (a track call is not a detach), null = detach.
  await pg.query(
    `insert into sessions
       (id,title,status,client_id,page_id,repo_path,branch,next_step,pr_url,summary,claude_id,agent,last_touched,origin,updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$12,$13,now(),$11,now())
     on conflict (id) do update set
       title=$2,status=$3,client_id=$4,repo_path=$6,branch=$7,
       page_id=case when $14 then $5 else sessions.page_id end,
       next_step=$8,pr_url=$9,summary=$10,claude_id=coalesce($12,sessions.claude_id),
       agent=coalesce($13,sessions.agent),
       last_touched=now(),origin=$11,updated_at=now()`,
    [id, s.title, await resolveStatusKey(pg, s.status), s.client_id ?? null, s.page_id ?? null,
      s.repo_path ?? null, s.branch ?? null, s.next_step ?? null, s.pr_url ?? null, s.summary ?? "", NODE_ID,
      s.claude_id ?? null, s.agent ?? null, s.page_id !== undefined],
  );
  return id;
}

// Quick-find (Ctrl+P): one ranked list across sessions, pages, and databases.
// Empty query = "recently touched" (title ilike '%%' is true for non-null titles).
// kind 'client' = a Project page (opens the client view); 'page' covers stories/pages.
export async function searchAll(q: string) {
  const pg = await db();
  const pat = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  return (await pg.query(
    `select * from (
       select 'session' as kind, id::text as id, title, coalesce(summary,'') as sub,
              '' as icon, status as meta, '' as color, last_touched as at
         from sessions
        where not deleted and (title ilike $1 or summary ilike $1 or coalesce(next_step,'') ilike $1)
       union all
       select case when kind='project' then 'client' else 'page' end, id::text, title,
              coalesce(brief,''), coalesce(icon,''), kind, coalesce(color,''), updated_at
         from pages
        where not deleted and (title ilike $1 or brief ilike $1 or content::text ilike $1)
       union all
       select 'database', id::text, name, '', coalesce(icon,''), 'database', '', updated_at
         from udb_databases
        where not deleted and name ilike $1
     ) hits
     order by at desc
     limit 20`,
    [pat],
  )).rows;
}

export async function setSessionStatus(id: string, status: string): Promise<void> {
  const pg = await db();
  await pg.query(`update sessions set status=$2, origin=$3, updated_at=now() where id=$1`, [id, status, NODE_ID]);
}

// tags (free labels on pages)

const TAG_NS = "3c9e0b71-2f45-4d18-a6c3-8e5417b9d0aa";
export const tagId = (key: string) => v5.generate(TAG_NS, new TextEncoder().encode(key));

export const tagKey = (label: string) =>
  label.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// Find-or-create a tag by label. Unlike a status, a clash is the POINT: two people
// typing "DevOps" must land on ONE tag, not on `devops-2`. The id falls out of the key
// (same reason schema.sql seeds the built-in statuses with fixed ids), so two offline
// nodes converge instead of forking; `do update` revives one deleted earlier.
export async function ensureTag(t: { label: string; color?: string }): Promise<{ id: string; key: string }> {
  const pg = await db();
  const key = tagKey(t.label) || "tag";
  const id = await tagId(key);
  const last = (await pg.query(`select max(sort_key) as k from tags where not deleted`)).rows[0] as { k: string | null };
  await pg.query(
    `insert into tags (id, key, label, color, sort_key, origin)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (id) do update set
       label=excluded.label, deleted=false, origin=excluded.origin, updated_at=now()`,
    [id, key, t.label, t.color ?? "#6b7280", midKey(last.k ?? "", ""), NODE_ID],
  );
  return { id, key };
}

export async function listTags() {
  const pg = await db();
  return (await pg.query(
    `select id, key, label, color, sort_key from tags where not deleted order by sort_key, label`,
  )).rows;
}

// key is immutable (pages.tags references it) — only label/color are patchable
export async function updateTag(id: string, patch: { label?: string; color?: string }): Promise<void> {
  const pg = await db();
  await pg.query(
    `update tags set label=coalesce($2,label), color=coalesce($3,color), origin=$4, updated_at=now() where id=$1`,
    [id, patch.label ?? null, patch.color ?? null, NODE_ID],
  );
}

// Soft-delete the vocabulary row. Pages keep the key and render it plainly.
export async function deleteTag(id: string): Promise<void> {
  const pg = await db();
  await pg.query(`update tags set deleted=true, origin=$2, updated_at=now() where id=$1`, [id, NODE_ID]);
}

// statuses (kanban columns)

// slug a label into a key, unique among non-deleted statuses (append -2, -3, … on clash)
async function uniqueStatusKey(pg: PGlite, label: string): Promise<string> {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "status";
  const taken = new Set(
    ((await pg.query(`select key from statuses where not deleted`)).rows as { key: string }[]).map((r) => r.key),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

// Two offline nodes adding the same label must converge on ONE column: derive the id from
// the key, the same reason schema.sql seeds the built-ins with fixed ids. `do update` also
// revives a status whose key was deleted earlier.
const STATUS_NS = "6f1d4a2e-8c3b-4f9a-9d2e-5b7c1a0e3f84";
export const statusId = (key: string) => v5.generate(STATUS_NS, new TextEncoder().encode(key));

export async function createStatus(s: { label: string; color: string; terminal?: boolean }): Promise<string> {
  const pg = await db();
  const key = await uniqueStatusKey(pg, s.label);
  const last = (await pg.query(`select max(sort_key) as k from statuses where not deleted`)).rows[0] as { k: string | null };
  const id = await statusId(key);
  await pg.query(
    `insert into statuses (id, key, label, color, terminal, sort_key, origin)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (id) do update set
       label=$3, color=$4, terminal=$5, sort_key=$6, deleted=false, origin=$7, updated_at=now()`,
    [id, key, s.label, s.color, s.terminal ?? false, midKey(last.k ?? "", ""), NODE_ID],
  );
  return id;
}

// key is immutable (sessions reference it) — only label/color/terminal are patchable
export async function updateStatus(
  id: string,
  patch: { label?: string; color?: string; terminal?: boolean },
): Promise<void> {
  const pg = await db();
  await pg.query(
    `update statuses set label=coalesce($2,label), color=coalesce($3,color),
       terminal=coalesce($4,terminal), origin=$5, updated_at=now() where id=$1`,
    [id, patch.label ?? null, patch.color ?? null, patch.terminal ?? null, NODE_ID],
  );
}

// reorder by one slot: swap sort_keys with the adjacent neighbor
export async function moveStatus(id: string, dir: -1 | 1): Promise<void> {
  const pg = await db();
  const rows = (await pg.query(
    `select id, sort_key from statuses where not deleted order by sort_key`,
  )).rows as { id: string; sort_key: string }[];
  const i = rows.findIndex((r) => r.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= rows.length) return;
  await pg.query(
    `update statuses set sort_key = case id when $1 then $4 when $2 then $3 else sort_key end,
       origin=$5, updated_at=now() where id in ($1,$2)`,
    [rows[i].id, rows[j].id, rows[i].sort_key, rows[j].sort_key, NODE_ID],
  );
}

// soft-delete; reassign any sessions on this status to a fallback so no card is orphaned.
// refuses to delete the last remaining status.
export async function deleteStatus(id: string): Promise<void> {
  const pg = await db();
  const all = (await pg.query(
    `select id, key, terminal from statuses where not deleted order by (terminal) asc, sort_key`,
  )).rows as { id: string; key: string; terminal: boolean }[];
  const victim = all.find((s) => s.id === id);
  if (!victim) return;
  if (all.length <= 1) throw new Error("cannot delete the last status");
  const fallback = all.find((s) => s.id !== id); // first non-terminal by the ordering above
  await pg.query(
    `update sessions set status=$2, origin=$3, updated_at=now() where status=$1 and not deleted`,
    [victim.key, fallback!.key, NODE_ID],
  );
  await pg.query(`update statuses set deleted=true, origin=$2, updated_at=now() where id=$1`, [id, NODE_ID]);
}

export async function deleteSession(id: string): Promise<void> {
  const pg = await db();
  await pg.query(`update sessions set deleted=true, origin=$2, updated_at=now() where id=$1`, [id, NODE_ID]);
}

export async function listEvents(sessionId: string, limit?: number) {
  const pg = await db();
  return (await pg.query(
    `select id, at, summary, kind, agent from session_events where session_id=$1 and not deleted
     order by at desc${limit ? " limit $2" : ""}`,
    limit ? [sessionId, limit] : [sessionId],
  )).rows;
}

export async function countEvents(sessionId: string): Promise<number> {
  const pg = await db();
  const row = (await pg.query(
    `select count(*)::int as n from session_events where session_id=$1 and not deleted`,
    [sessionId],
  )).rows[0] as { n: number };
  return row.n;
}

export async function addEvent(sessionId: string, summary: string, kind = "log", agent: string | null = null): Promise<void> {
  const pg = await db();
  await pg.query(
    `insert into session_events (session_id, summary, kind, origin, agent) values ($1,$2,$3,$4,$5)`,
    [sessionId, summary, kind, NODE_ID, agent],
  );
  await pg.query(`update sessions set last_touched=now(), origin=$2, updated_at=now() where id=$1`, [sessionId, NODE_ID]);
}

// A track repeating the last one is a no-op (upsertSession already touched the card); manual logs always append.
export async function addTrackEvent(sessionId: string, summary: string, agent: string | null = null): Promise<void> {
  const pg = await db();
  const last = (await pg.query(
    `select summary, agent from session_events where session_id=$1 and kind='track' and not deleted
     order by at desc, id desc limit 1`,
    [sessionId],
  )).rows[0] as { summary: string | null; agent: string | null } | undefined;
  if (last && (last.summary ?? "").trim() === summary.trim() && (last.agent ?? null) === agent) return;
  await addEvent(sessionId, summary, "track", agent);
}

export async function linksForSession(sessionId: string) {
  const pg = await db();
  return (await pg.query(
    `select l.id, l.page_id, l.block_id, l.anchor, p.title as page_title
       from session_links l join pages p on p.id = l.page_id and not p.deleted
      where l.session_id=$1 and not l.deleted order by l.updated_at`,
    [sessionId],
  )).rows;
}

export async function addSessionLink(
  sessionId: string,
  pageId: string,
  blockId: string | null,
  anchor: string,
): Promise<string> {
  const pg = await db();
  const row = (await pg.query(
    `insert into session_links (session_id, page_id, block_id, anchor, origin)
     values ($1,$2,$3,$4,$5) returning id`,
    [sessionId, pageId, blockId, anchor, NODE_ID],
  )).rows[0] as { id: string };
  return row.id;
}

// One session as the drawer shows it: the ids it joins (project, story) resolved to
// names, plus the worklog and backlinks /api/board leaves out. Null when unknown/deleted.
export async function getSession(id: string, eventLimit = 20) {
  const pg = await db();
  const s = (await pg.query(`select * from sessions where id=$1 and not deleted`, [id]))
    .rows[0] as Record<string, unknown> | undefined;
  if (!s) return null;
  const one = async (pageId: unknown, kind?: string) => {
    if (typeof pageId !== "string") return null;
    return (await pg.query(
      `select id, title, kind from pages where id=$1 and not deleted${kind ? ` and kind='${kind}'` : ""}`,
      [pageId],
    )).rows[0] ?? null;
  };
  const project = await one(s.client_id, "project") as { id: string; title: string } | null;
  // the story slot accepts any page, not just kind='story' — matches the drawer's picker
  const story = await one(s.page_id) as { id: string; title: string; kind: string } | null;
  // specs are read-only here, rendered from the spec page; write via ensureSpecsPage
  const specPage = typeof s.specs_page_id === "string"
    ? (await pg.query(`select content from pages where id=$1 and not deleted`, [s.specs_page_id]))
      .rows[0] as { content: unknown[] } | undefined
    : undefined;
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    agent: s.agent,
    repo_path: s.repo_path,
    branch: s.branch,
    pr_url: s.pr_url,
    next_step: s.next_step,
    specs_page_id: s.specs_page_id ?? null,
    specs: specPage ? pageBlocksToMarkdown(specPage.content ?? []) : null,
    project: project && { id: project.id, name: project.title },
    story,
    links: await linksForSession(id),
    activity: await listEvents(id, eventLimit),
    activity_total: await countEvents(id),
    last_touched: s.last_touched,
    updated_at: s.updated_at,
  };
}

export async function deleteSessionLink(id: string): Promise<void> {
  const pg = await db();
  await pg.query(
    `update session_links set deleted=true, updated_at=now(), origin=$2 where id=$1`,
    [id, NODE_ID],
  );
}

export async function updateStory(o: { id: string; title?: string; brief?: string; status?: string }): Promise<void> {
  const pg = await db();
  await pg.query(
    `update pages set
       title = coalesce($2, title),
       brief = coalesce($3, brief),
       status = coalesce($4, status),
       origin = $5, updated_at = now()
     where id = $1`,
    [o.id, o.title ?? null, o.brief ?? null, o.status ?? null, NODE_ID],
  );
}

export async function listReports() {
  const pg = await db();
  return (await pg.query(
    `select id, title, client_id, page_id, created_at from reports where not deleted order by created_at desc`,
  )).rows;
}

export async function getReport(id: string) {
  const pg = await db();
  return (await pg.query(`select * from reports where id=$1 and not deleted`, [id])).rows[0] ?? null;
}

export async function createReport(r: { title: string; html: string; client?: string; story?: string }) {
  const pg = await db();
  const clientId = r.client ? await resolveClient(r.client) : null;
  const pageId = r.story ? await resolveStory(r.story, clientId) : null;
  const row = (await pg.query(
    `insert into reports (title, html, client_id, page_id, origin) values ($1,$2,$3,$4,$5) returning id`,
    [r.title, r.html, clientId, pageId, NODE_ID],
  )).rows[0] as { id: string };
  return row.id;
}

// Drain writes made by /trame:track while the app was closed/offline.
// NOTE (scaffold): the outbox stores session fields only; client/story-by-name
// resolution done by the online CLI path is skipped here. Good enough for v0.
export async function drainOutbox(): Promise<number> {
  let text: string;
  try { text = await Deno.readTextFile(OUTBOX); } catch { return 0; }
  const lines = text.split("\n").filter((l) => l.trim());
  for (const line of lines) {
    try { await upsertSession(JSON.parse(line)); } catch (e) { console.error("outbox line failed:", e); }
  }
  await Deno.remove(OUTBOX).catch(() => {});
  return lines.length;
}
