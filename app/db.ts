// Local database: PGlite by default, Rust-owned PostgreSQL via a private socket.
// Same SQL as the hub's Postgres — no dialect translation.
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import schema from "../db/schema.sql" with { type: "text" };
import { DATA_DIR } from "./config.ts";
import { type Database, socketPg } from "./pg.ts";

// Memoize a single init PROMISE so concurrent callers all await the same fully-initialized
// instance (waitReady + schema applied) — otherwise an early query races the schema exec
// and hits "relation does not exist".
let _pg: Promise<Database> | null = null;

const OK_MARKER = `${DATA_DIR}/.trame-ok`;

async function initSchema(pg: Database): Promise<void> {
  await pg.exec(schema);
  // Use this handle: db() would await its own initialization promise.
  const { claimDevice } = await import("./identity.ts");
  await claimDevice(pg).catch(console.error);
}

async function openPg(): Promise<PGlite> {
  const pg = new PGlite(DATA_DIR);
  await pg.waitReady;
  await initSchema(pg);
  await writeFile(OK_MARKER, "1"); // init completed — dir is real data from now on
  return pg;
}

export function db(): Promise<Database> {
  if (!_pg) {
    _pg = (async () => {
      const socket = process.env.TRAME_PG_SOCKET;
      if (socket) {
        const pg = socketPg(socket);
        // the plugin host shares the native app's live database: the app owns its schema
        if (process.env.TRAME_PG_SCHEMA_OWNED === "1") return pg;
        try {
          await initSchema(pg);
          return pg;
        } catch (e) {
          await pg.close();
          throw e;
        }
      }
      // PGlite data dirs are not portable across major PG versions (0.5.x = PG 18).
      // Check BEFORE any open/recovery so an old dir is never opened in place or
      // mistaken for a half-initialized one and wiped.
      const pgVersion = await readFile(`${DATA_DIR}/PG_VERSION`, "utf8").then((s) => s.trim()).catch(() => null);
      if (pgVersion && pgVersion !== "18") {
        throw new Error(`data dir ${DATA_DIR} is Postgres ${pgVersion} format — this build needs 18`);
      }
      // PGlite's mkdir isn't recursive — ensure the parent exists first.
      await mkdir(DATA_DIR.replace(/\/[^/]+\/?$/, ""), { recursive: true }).catch(() => {});
      try {
        return await openPg();
      } catch (e) {
        // A crashed first init leaves a half-written dir that aborts every open.
        // Only auto-recover when init never completed (no marker) — never wipe real data.
        const initialized = await stat(OK_MARKER).then(() => true).catch(() => false);
        if (initialized) throw e;
        console.error("PGlite init failed on a half-initialized dir — recreating it.");
        await rm(DATA_DIR, { recursive: true }).catch(() => {});
        return await openPg();
      }
    })().catch((e) => {
      _pg = null; // don't cache a failed init — allow a retry
      throw e;
    });
  }
  return _pg;
}

// Close the shared handle, if one was opened (tests: an open PGlite makes bun exit 99).
export async function closeDb(): Promise<void> {
  const pending = _pg;
  _pg = null;
  await (await pending?.catch(() => null))?.close();
}
