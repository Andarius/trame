// Local database = PGlite (embedded Postgres, persisted to DATA_DIR).
// Same SQL as the hub's Postgres — no dialect translation.
import { PGlite } from "@electric-sql/pglite";
import { APP_ROOT, DATA_DIR, OUTBOX } from "./config.ts";
import { upsertSession } from "../core/sessions.ts";
import { APP_CTX } from "./ctx.ts";

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

// Drain writes made by trame-track while the app was closed/offline.
// NOTE (scaffold): the outbox stores session fields only; client/story-by-name
// resolution done by the online CLI path is skipped here. Good enough for v0.
export async function drainOutbox(): Promise<number> {
  let text: string;
  try { text = await Deno.readTextFile(OUTBOX); } catch { return 0; }
  const lines = text.split("\n").filter((l) => l.trim());
  for (const line of lines) {
    try { await upsertSession(APP_CTX, JSON.parse(line)); } catch (e) { console.error("outbox line failed:", e); }
  }
  await Deno.remove(OUTBOX).catch(() => {});
  return lines.length;
}
