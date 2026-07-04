// DESCRIPTION: one-time migration of the local PGlite data dir from the PG 16 format
// (PGlite 0.2.x) to PG 18 (PGlite 0.5.x). Dumps every synced table with the old engine,
// moves the old dir aside as a .bak, re-creates the dir with the new engine + schema,
// and restores the rows. Safe to re-run: exits early if the dir is already PG 18.
// USAGE: deno task migrate:pg18   (from app/, with the Trame app CLOSED)
import { PGlite as PGliteOld } from "npm:@electric-sql/pglite@0.2.17";
import { PGlite } from "@electric-sql/pglite";
import { APP_ROOT, DATA_DIR, PORT_FILE } from "./config.ts";
import { TABLES } from "./sync.ts";

const version = await Deno.readTextFile(`${DATA_DIR}/PG_VERSION`).then((s) => s.trim()).catch(() => null);
if (version === null) {
  console.log(`no data dir at ${DATA_DIR} — nothing to migrate`);
  Deno.exit(0);
}
if (version === "18") {
  console.log(`${DATA_DIR} is already PG 18 — nothing to do`);
  Deno.exit(0);
}

// Refuse to touch the dir while an app instance is holding it. Older builds don't
// report their dataDir — treat that as "could be this dir" and abort.
try {
  const { port } = JSON.parse(await Deno.readTextFile(PORT_FILE));
  const res = await fetch(`http://localhost:${port}/api/status`, { signal: AbortSignal.timeout(1500) });
  if (res.ok) {
    const status = await res.json().catch(() => ({}));
    if (!status.dataDir || status.dataDir === DATA_DIR) {
      console.error("the Trame app is running (and may hold this data dir) — close it first, then re-run");
      Deno.exit(1);
    }
  }
} catch { /* no port file or nothing listening — good */ }

console.log(`migrating ${DATA_DIR}: PG ${version} → PG 18`);

// 1. Dump with the OLD engine (the only one able to read the dir).
const old = new PGliteOld(DATA_DIR);
await old.waitReady;
const dump: Record<string, Record<string, unknown>[]> = {};
for (const t of TABLES) {
  // udb_* tables may not exist in a pre-migration dir — skip missing tables.
  try {
    dump[t.name] = (await old.query(`select ${t.cols.join(",")} from ${t.name}`)).rows as Record<string, unknown>[];
  } catch {
    dump[t.name] = [];
  }
}
const syncState = (await old.query(`select last_pulled_at, last_pushed_at from sync_state where id=1`)).rows[0] as
  | { last_pulled_at: string; last_pushed_at: string }
  | undefined;
await old.close();

const total = Object.values(dump).reduce((n, rows) => n + rows.length, 0);
console.log(`dumped ${total} rows from ${Object.keys(dump).length} tables`);

// 2. Move the old dir aside (kept as a backup — delete it manually once satisfied).
const bak = `${DATA_DIR}.pg${version}.bak`;
await Deno.remove(bak, { recursive: true }).catch(() => {});
await Deno.rename(DATA_DIR, bak);
console.log(`old dir kept at ${bak}`);

// 3. Re-create with the NEW engine and restore. On any failure, roll the old dir back.
try {
  const pg = new PGlite(DATA_DIR);
  await pg.waitReady;
  const schema = await Deno.readTextFile(`${APP_ROOT}/../db/schema.sql`)
    .catch(async () => (await import("./embed.ts")).SCHEMA);
  await pg.exec(schema);
  for (const t of TABLES) {
    for (const row of dump[t.name]) {
      const ph = t.cols.map((_, i) => `$${i + 1}`).join(",");
      await pg.query(
        `insert into ${t.name} (${t.cols.join(",")}) values (${ph}) on conflict (id) do nothing`,
        t.cols.map((c) => {
          const v = row[c];
          // jsonb values come back as objects from the old engine; PGlite params want text
          return v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v;
        }),
      );
    }
    if (dump[t.name].length) console.log(`  ${t.name}: ${dump[t.name].length} rows`);
  }
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
  await Deno.rename(bak, DATA_DIR);
  Deno.exit(1);
}

console.log(`done — ${DATA_DIR} is now PG 18 (backup: ${bak})`);
