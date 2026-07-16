// Isolated PGlite in a temp dir — set the env BEFORE importing any app module (config
// reads it at load), so app code is pulled in via dynamic import inside the test.
const tmp = await Deno.makeTempDir({ prefix: "trame-changelog-test-" });
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "cl-test");
Deno.env.set("TRACKER_OUTBOX", `${tmp}/outbox.jsonl`);
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_PORT_FILE", `${tmp}/port.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL(".", import.meta.url).pathname);

import { assert, assertEquals } from "@std/assert";

type LogRow = { rev: number; entity: string; row_id: string; op: string };

// These run in order and clean up after themselves (one PGlite for the file).

Deno.test("writes append to change_log in order: upsert, upsert, delete", async () => {
  const { db } = await import("./db.ts");
  const { createPage, updatePage, deletePage } = await import("./pages.ts");
  const pg = await db();

  const id = await createPage({ title: "logged page" });
  await updatePage(id, { title: "renamed" });
  await deletePage(id); // soft delete — must log as 'delete'

  const log = (await pg.query(
    `select rev, entity, row_id, op from change_log where row_id=$1 order by rev`,
    [id],
  )).rows as LogRow[];
  assertEquals(log.map((l) => l.op), ["upsert", "upsert", "delete"]);
  assertEquals(log.map((l) => l.entity), ["pages", "pages", "pages"]);
  assert(log[0].rev < log[1].rev && log[1].rev < log[2].rev, "rev is monotonic");
});

Deno.test("foreign-origin upserts are captured too (coexistence)", async () => {
  const { db } = await import("./db.ts");
  const pg = await db();

  // what a hub receives from a legacy direct-SQL client / a laptop from a pull
  // (owner_id set so the schema re-run in the last test doesn't backfill — and log — it)
  await pg.query(
    `insert into pages (id, title, origin, owner_id)
     values ('00000000-0000-4000-8000-00000000cccc','pulled','other-node','00000000-0000-4000-8000-000000000101')`,
  );
  const log = (await pg.query(
    `select op, actor, source from change_log where row_id='00000000-0000-4000-8000-00000000cccc'`,
  )).rows as { op: string; actor: string | null; source: string | null }[];
  assertEquals(log.length, 1);
  assertEquals(log[0].op, "upsert");
  assertEquals(log[0].actor, null, "no actor until the API stamps trame.actor");
  assertEquals(log[0].source, null, "no source for direct SQL");
});

Deno.test("trame.actor/trame.source settings are stamped when set", async () => {
  const { db } = await import("./db.ts");
  const pg = await db();

  await pg.exec(`
    set trame.actor = '00000000-0000-4000-8000-000000000101';
    set trame.source = 'api';
    insert into pages (id, title, origin, owner_id)
    values ('00000000-0000-4000-8000-00000000dddd','via api','hub-api','00000000-0000-4000-8000-000000000101');
    reset trame.actor;
    reset trame.source;
  `);
  const row = (await pg.query(
    `select actor, source from change_log where row_id='00000000-0000-4000-8000-00000000dddd'`,
  )).rows[0] as { actor: string; source: string };
  assertEquals(row.actor, "00000000-0000-4000-8000-000000000101");
  assertEquals(row.source, "api");
});

Deno.test("schema re-run keeps triggers idempotent and compacts >30d rows", async () => {
  const { db } = await import("./db.ts");
  const { APP_ROOT } = await import("./config.ts");
  const pg = await db();

  await pg.query(
    `insert into change_log (entity, row_id, op, at)
     values ('pages','00000000-0000-4000-8000-00000000eeee','upsert', now() - interval '40 days')`,
  );
  const before = (await pg.query(`select count(*)::int as n from change_log`)).rows[0] as { n: number };

  await pg.exec(await Deno.readTextFile(`${APP_ROOT}/../db/schema.sql`));

  const old = (await pg.query(
    `select 1 from change_log where row_id='00000000-0000-4000-8000-00000000eeee'`,
  )).rows;
  assertEquals(old.length, 0, "40-day-old row compacted away");
  const after = (await pg.query(`select count(*)::int as n from change_log`)).rows[0] as { n: number };
  assertEquals(after.n, before.n - 1, "re-run only compacted — no duplicate trigger firings, no lost rows");

  // triggers still fire (create or replace left exactly one per table)
  await pg.query(
    `insert into pages (id, title, origin) values ('00000000-0000-4000-8000-00000000ffff','post rerun','cl-test')`,
  );
  const fresh = (await pg.query(
    `select count(*)::int as n from change_log where row_id='00000000-0000-4000-8000-00000000ffff'`,
  )).rows[0] as { n: number };
  assertEquals(fresh.n, 1);
});
