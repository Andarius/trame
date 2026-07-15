// Round-trip tests for the page-share bundle (export → import). Runs against an
// isolated PGlite in a temp dir — set the env BEFORE importing any app module (config
// reads it at load), so the app code is pulled in via dynamic import inside each test.
//
//   deno test -A share_test.ts   (or `just test`)
const tmp = await Deno.makeTempDir({ prefix: "trame-share-test-" });
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "share-test");
Deno.env.set("TRACKER_OUTBOX", `${tmp}/outbox.jsonl`);
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_PORT_FILE", `${tmp}/port.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL(".", import.meta.url).pathname);

import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";

const app = {
  db: () => import("./db.ts").then((m) => m.db()),
  createPage: (p: Record<string, unknown>) => import("./pages.ts").then((m) => m.createPage(p)),
  createUdb: (n: string) => import("./udb.ts").then((m) => m.createUdb(n)),
  createProperty: (id: string, p: Record<string, unknown>) => import("./udb.ts").then((m) => m.createProperty(id, p as never)),
  createRow: (id: string, vals: Record<string, unknown>) => import("./udb.ts").then((m) => m.createRow(id, vals)),
  attach: (dbId: string, pageId: string | null) => import("./pages.ts").then((m) => m.attachUdbToPage(dbId, pageId)),
  exportPage: (id: string) => import("./share.ts").then((m) => m.exportPage(id)),
  importPage: (b: unknown, parent: string | null) => import("./share.ts").then((m) => m.importPage(b, parent)),
};

async function titleProp(dbId: string): Promise<string> {
  const pg = await app.db();
  const r = await pg.query<{ id: string }>(`select id from udb_properties where db_id=$1 and type='title'`, [dbId]);
  return r.rows[0].id;
}

Deno.test("exportPage → importPage recreates the subtree with fresh ids", async () => {
  const root = await app.createPage({ title: "Shared root", kind: "page" });
  await app.createPage({ title: "Child note", kind: "page", parent_id: root });
  const dbId = await app.createUdb("Shared DB");
  await app.attach(dbId, root);
  const tp = await titleProp(dbId);
  await app.createRow(dbId, { [tp]: "row-a" });
  await app.createRow(dbId, { [tp]: "row-b" });

  const bundle = await app.exportPage(root);
  assert(bundle, "export returned a bundle");
  assertEquals(bundle!.root, root);
  assertEquals(bundle!.pages.map((p) => p.title).sort(), ["Child note", "Shared root"]);
  assertEquals(bundle!.databases.map((d) => d.name), ["Shared DB"]);
  assertEquals(bundle!.rows.length, 2);

  const newRoot = await app.importPage(bundle, null);
  assertNotEquals(newRoot, root, "import mints a fresh root id");

  const pg = await app.db();
  // both copies now exist; the import is a full, independent duplicate
  const roots = await pg.query<{ id: string; origin: string }>(
    `select id, origin from pages where title='Shared root' and not deleted`,
  );
  assertEquals(roots.rows.length, 2);
  const imported = roots.rows.find((r) => r.id === newRoot)!;
  assertEquals(imported.origin, "share-test");

  // the imported child is reparented under the NEW root, not the old one
  const kids = await pg.query<{ parent_id: string }>(
    `select parent_id from pages where title='Child note' and not deleted`,
  );
  assertEquals(kids.rows.length, 2);
  assert(kids.rows.some((k) => k.parent_id === newRoot), "imported child reparented under the imported root");
  assert(kids.rows.some((k) => k.parent_id === root), "original child still under the original root");

  // the imported db is a distinct row, attached to the imported root, with both rows
  const dbs = await pg.query<{ id: string; page_id: string }>(
    `select id, page_id from udb_databases where name='Shared DB' and not deleted`,
  );
  assertEquals(dbs.rows.length, 2);
  const importedDb = dbs.rows.find((d) => d.id !== dbId)!;
  assertEquals(importedDb.page_id, newRoot);
  const rowCount = await pg.query<{ n: number }>(
    `select count(*)::int as n from udb_rows where db_id=$1 and not deleted`,
    [importedDb.id],
  );
  assertEquals(rowCount.rows[0].n, 2);
});

Deno.test("a relation whose target db did not travel is dropped on import", async () => {
  // db1 lives OUTSIDE the exported subtree; db2 (inside it) relates to db1
  const outsidePage = await app.createPage({ title: "Outside", kind: "page" });
  const db1 = await app.createUdb("Target DB");
  await app.attach(db1, outsidePage);
  const relRoot = await app.createPage({ title: "Rel root", kind: "page" });
  const db2 = await app.createUdb("Owner DB");
  await app.attach(db2, relRoot);
  await app.createProperty(db2, { name: "Ref", type: "relation", config: { target_db: db1 } });

  const bundle = await app.exportPage(relRoot);
  assert(bundle);
  assertEquals(bundle!.databases.map((d) => d.name), ["Owner DB"]); // db1 stayed behind
  assert(bundle!.properties.some((p) => p.type === "relation"), "the owner relation prop is in the bundle");

  const newRoot = await app.importPage(bundle, null);
  const pg = await app.db();
  const importedDb = (await pg.query<{ id: string }>(
    `select d.id from udb_databases d join pages p on p.id=d.page_id
      where d.name='Owner DB' and p.id=$1 and not d.deleted`,
    [newRoot],
  )).rows[0].id;
  const rels = await pg.query<{ n: number }>(
    `select count(*)::int as n from udb_properties where db_id=$1 and type='relation' and not deleted`,
    [importedDb],
  );
  assertEquals(rels.rows[0].n, 0, "the dangling relation was dropped");
});

Deno.test("importPage rejects a non-bundle", async () => {
  await assertRejects(() => app.importPage({ nope: true }, null), Error, "not a Trame page bundle");
});
