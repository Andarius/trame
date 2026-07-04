// Local database = PGlite (embedded Postgres, persisted to DATA_DIR).
// Same SQL as the hub's Postgres — no dialect translation.
import { PGlite } from "@electric-sql/pglite";
import { APP_ROOT, DATA_DIR, NODE_ID, OUTBOX } from "./config.ts";

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
        throw new Error(
          `data dir ${DATA_DIR} is Postgres ${pgVersion} format — run \`deno task migrate:pg18\` (from app/) first`,
        );
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
  const clients = (await pg.query(`select * from clients where not deleted order by name`)).rows;
  // "objectives" are project pages since the pages merge — same shape, same ids
  const objectives = (await pg.query(`select * from pages where kind='project' and not deleted order by title`)).rows;
  const sessions = (await pg.query(`select * from sessions where not deleted order by last_touched desc`)).rows;
  return { clients, objectives, sessions };
}

const PALETTE = ["#7a9ee7", "#b590e7", "#c98a63", "#7bd88f", "#e3c567"];

export async function resolveClient(name: string, color?: string): Promise<string> {
  const pg = await db();
  const hit = (await pg.query(`select id from clients where name=$1 and not deleted limit 1`, [name])).rows[0] as
    | { id: string }
    | undefined;
  if (hit) return hit.id;
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  const col = color ?? PALETTE[Math.abs(h) % PALETTE.length];
  const row = (await pg.query(
    `insert into clients (name, color, origin) values ($1,$2,$3) returning id`,
    [name, col, NODE_ID],
  )).rows[0] as { id: string };
  return row.id;
}

export async function resolveObjective(title: string, clientId: string | null): Promise<string> {
  const pg = await db();
  const hit = (await pg.query(
    `select id from pages where kind='project' and title=$1 and not deleted limit 1`,
    [title],
  )).rows[0] as { id: string } | undefined;
  if (hit) return hit.id;
  const row = (await pg.query(
    `insert into pages (kind, title, client_id, origin) values ('project',$1,$2,$3) returning id`,
    [title, clientId, NODE_ID],
  )).rows[0] as { id: string };
  return row.id;
}

export async function createObjective(o: { title: string; story?: string; client?: string }): Promise<string> {
  const pg = await db();
  const clientId = o.client ? await resolveClient(o.client) : null;
  const row = (await pg.query(
    `insert into pages (kind, title, story, client_id, origin) values ('project',$1,$2,$3,$4) returning id`,
    [o.title, o.story ?? "", clientId, NODE_ID],
  )).rows[0] as { id: string };
  return row.id;
}

export async function upsertSession(s: Record<string, unknown>): Promise<string> {
  const pg = await db();
  // Accept human names (from the CLI/MCP) and resolve them to ids.
  if (typeof s.client === "string" && !s.client_id) s.client_id = await resolveClient(s.client);
  if (typeof s.page === "string" && !s.page_id) s.page_id = await resolveObjective(s.page, (s.client_id as string) ?? null);
  if (typeof s.objective === "string" && !s.objective_id) {
    s.objective_id = await resolveObjective(s.objective, (s.client_id as string) ?? null);
  }
  // objective_id ↔ page_id are the same id since the pages merge; keep both filled
  // until the frontend is fully off objective_id.
  s.page_id ??= s.objective_id;
  s.objective_id ??= s.page_id;
  // Upsert by (repo_path, branch) among open sessions when no id is given.
  if (!s.id && s.repo_path) {
    const hit = (await pg.query(
      `select id from sessions where repo_path=$1 and coalesce(branch,'')=$2 and status <> 'done' and not deleted
       order by last_touched desc limit 1`,
      [s.repo_path, (s.branch as string) ?? ""],
    )).rows[0] as { id: string } | undefined;
    if (hit) s.id = hit.id;
  }
  const id = (s.id as string) ?? crypto.randomUUID();
  await pg.query(
    `insert into sessions
       (id,title,status,client_id,objective_id,page_id,repo_path,branch,next_step,pr_url,summary,last_touched,origin,updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),$12,now())
     on conflict (id) do update set
       title=$2,status=$3,client_id=$4,objective_id=$5,page_id=$6,repo_path=$7,branch=$8,
       next_step=$9,pr_url=$10,summary=$11,last_touched=now(),origin=$12,updated_at=now()`,
    [id, s.title, s.status ?? "active", s.client_id ?? null, s.objective_id ?? null, s.page_id ?? null,
      s.repo_path ?? null, s.branch ?? null, s.next_step ?? null, s.pr_url ?? null, s.summary ?? "", NODE_ID],
  );
  return id;
}

export async function setSessionStatus(id: string, status: string): Promise<void> {
  const pg = await db();
  await pg.query(`update sessions set status=$2, origin=$3, updated_at=now() where id=$1`, [id, status, NODE_ID]);
}

export async function deleteSession(id: string): Promise<void> {
  const pg = await db();
  await pg.query(`update sessions set deleted=true, origin=$2, updated_at=now() where id=$1`, [id, NODE_ID]);
}

export async function listEvents(sessionId: string) {
  const pg = await db();
  return (await pg.query(
    `select id, at, summary, kind from session_events where session_id=$1 and not deleted order by at desc`,
    [sessionId],
  )).rows;
}

export async function addEvent(sessionId: string, summary: string, kind = "log"): Promise<void> {
  const pg = await db();
  await pg.query(
    `insert into session_events (session_id, summary, kind, origin) values ($1,$2,$3,$4)`,
    [sessionId, summary, kind, NODE_ID],
  );
  await pg.query(`update sessions set last_touched=now(), origin=$2, updated_at=now() where id=$1`, [sessionId, NODE_ID]);
}

export async function updateObjective(o: { id: string; title?: string; story?: string; status?: string }): Promise<void> {
  const pg = await db();
  await pg.query(
    `update pages set
       title = coalesce($2, title),
       story = coalesce($3, story),
       status = coalesce($4, status),
       origin = $5, updated_at = now()
     where id = $1`,
    [o.id, o.title ?? null, o.story ?? null, o.status ?? null, NODE_ID],
  );
}

export async function listReports() {
  const pg = await db();
  return (await pg.query(
    `select id, title, client_id, objective_id, created_at from reports where not deleted order by created_at desc`,
  )).rows;
}

export async function getReport(id: string) {
  const pg = await db();
  return (await pg.query(`select * from reports where id=$1 and not deleted`, [id])).rows[0] ?? null;
}

export async function createReport(r: { title: string; html: string; client?: string; objective?: string }) {
  const pg = await db();
  const clientId = r.client ? await resolveClient(r.client) : null;
  const objectiveId = r.objective ? await resolveObjective(r.objective, clientId) : null;
  const row = (await pg.query(
    `insert into reports (title, html, client_id, objective_id, page_id, origin) values ($1,$2,$3,$4,$4,$5) returning id`,
    [r.title, r.html, clientId, objectiveId, NODE_ID],
  )).rows[0] as { id: string };
  return row.id;
}

// Drain writes made by /project:track while the app was closed/offline.
// NOTE (scaffold): the outbox stores session fields only; client/objective-by-name
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
