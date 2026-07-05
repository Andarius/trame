// PG16 (PGlite 0.2.x) → PG18 (PGlite 0.5.x) data-dir migration. Called automatically
// by db() when it finds an old dir (packaged apps have no way to run a repo task), and
// by `deno task migrate:pg18` for manual runs. Dumps every synced table with the OLD
// engine, moves the dir aside as a .bak, re-creates it with the new engine + schema,
// restores the rows, and rolls back on failure.
// Old dirs predate newer columns/tables (pages, page_id, icons…): the dump takes
// whatever exists (`select *`) and the restore writes the intersection with today's
// schema — schema.sql's idempotent backfills (objectives → pages) do the rest.
// deno-lint-ignore no-import-prefix -- the OLD engine, pinned: the only build able to read a PG16 dir
import { PGlite as PGliteOld } from "npm:@electric-sql/pglite@0.2.17";
import { PGlite } from "@electric-sql/pglite";
import { APP_ROOT, DATA_DIR } from "./config.ts";
import { TABLES } from "./sync.ts";

// Legacy tables that are no longer synced but are the SOURCE of schema.sql's
// backfills (objectives → pages) — they must ride along or the backfill runs empty.
const LEGACY = [
  { name: "objectives", cols: ["id", "title", "story", "client_id", "status", "origin", "updated_at", "deleted"] },
] as const;

export async function dataDirPgVersion(): Promise<string | null> {
  return await Deno.readTextFile(`${DATA_DIR}/PG_VERSION`).then((s) => s.trim()).catch(() => null);
}

export async function migrateDataDir(): Promise<{ rows: number; backup: string }> {
  const version = await dataDirPgVersion();
  if (version === null || version === "18") throw new Error(`nothing to migrate (PG_VERSION=${version})`);
  console.log(`migrating ${DATA_DIR}: PG ${version} → PG 18`);

  // 1. Dump with the OLD engine (the only one able to read the dir). `select *`:
  //    old dirs may lack columns/tables added since — restore intersects with today's cols.
  const old = new PGliteOld(DATA_DIR);
  await old.waitReady;
  const migrTables = [TABLES[0], ...LEGACY, ...TABLES.slice(1)]; // clients, objectives, pages, …
  const dump: Record<string, Record<string, unknown>[]> = {};
  for (const t of migrTables) {
    try {
      dump[t.name] = (await old.query(`select * from ${t.name}`)).rows as Record<string, unknown>[];
    } catch {
      dump[t.name] = []; // table didn't exist yet in this dir
    }
  }
  const syncState = (await old.query(`select last_pulled_at, last_pushed_at from sync_state where id=1`)).rows[0] as
    | { last_pulled_at: string; last_pushed_at: string }
    | undefined;
  await old.close();
  const total = Object.values(dump).reduce((n, rows) => n + rows.length, 0);
  console.log(`dumped ${total} rows from ${Object.keys(dump).length} tables`);

  // 2. Move the old dir aside (kept as a backup — delete manually once satisfied).
  const backup = `${DATA_DIR}.pg${version}.bak`;
  await Deno.remove(backup, { recursive: true }).catch(() => {});
  await Deno.rename(DATA_DIR, backup);

  // 3. Re-create with the NEW engine and restore. On any failure, roll the old dir back.
  try {
    const pg = new PGlite(DATA_DIR);
    await pg.waitReady;
    const schema = await Deno.readTextFile(`${APP_ROOT}/../db/schema.sql`)
      .catch(async () => (await import("./embed.ts")).SCHEMA);
    await pg.exec(schema);
    for (const t of migrTables) {
      const rows = dump[t.name];
      if (!rows.length) continue;
      // only the columns that existed in the old dir AND still exist today
      const cols = t.cols.filter((c) => c in rows[0]);
      const ph = cols.map((_, i) => `$${i + 1}`).join(",");
      for (const row of rows) {
        await pg.query(
          `insert into ${t.name} (${cols.join(",")}) values (${ph}) on conflict (id) do nothing`,
          cols.map((c) => {
            const v = row[c];
            // jsonb values come back as objects from the old engine; PGlite params want text
            return v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v;
          }),
        );
      }
      console.log(`  ${t.name}: ${rows.length} rows`);
    }
    // re-run the schema so its idempotent backfills see the restored rows
    // (objectives → pages copy, page_id backfills)
    await pg.exec(schema);
    if (syncState) {
      await pg.query(
        `update sync_state set last_pulled_at=$1, last_pushed_at=$2 where id=1`,
        [syncState.last_pulled_at, syncState.last_pushed_at],
      );
    }
    await Deno.writeTextFile(`${DATA_DIR}/.trame-ok`, "1");
    await pg.close();
  } catch (e) {
    console.error("restore failed — rolling back to the old dir:", e);
    await Deno.remove(DATA_DIR, { recursive: true }).catch(() => {});
    await Deno.rename(backup, DATA_DIR);
    throw e;
  }
  console.log(`done — ${DATA_DIR} is now PG 18 (backup: ${backup})`);
  return { rows: total, backup };
}
