// Isolated PGlite in a temp dir — set the env BEFORE importing any app module.
const tmp = await Deno.makeTempDir({ prefix: "trame-proto-test-" });
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "proto-test");
Deno.env.set("TRACKER_OUTBOX", `${tmp}/outbox.jsonl`);
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_PORT_FILE", `${tmp}/port.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL(".", import.meta.url).pathname);

import { assertEquals } from "@std/assert";
import { ENTITIES } from "../protocol/entities.ts";

/**
 * The wire contract and the schema are two files that must agree, and nothing
 * makes them. `pages.color` once existed in the schema but was missing from
 * `cols`, so it silently never synced — no error, just a column that never
 * left the laptop. This walks the real database and checks every declared
 * column exists.
 */
Deno.test("every synced column exists in the database", async () => {
  const { db } = await import("./db.ts");
  const pg = await db();

  const missing: string[] = [];
  for (const e of ENTITIES) {
    const rows = (await pg.query(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = $1`,
      [e.name],
    )).rows as { column_name: string }[];
    const have = new Set(rows.map((r) => r.column_name));
    if (have.size === 0) {
      missing.push(`${e.name} (table absent)`);
      continue;
    }
    for (const c of e.cols) if (!have.has(c)) missing.push(`${e.name}.${c}`);
  }

  assertEquals(
    missing,
    [],
    "declared in protocol/entities.ts but not in db/schema.sql",
  );
});

Deno.test("a page keeps its tags through create and update", async () => {
  const { createPage, getPage, updatePage } = await import("./pages.ts");
  // getPage spreads an untyped row, so the column is not on the inferred type.
  const tagsOf = async (id: string) =>
    (await getPage(id) as unknown as { tags: string[] }).tags;

  const id = await createPage({ title: "Tagged", tags: ["devops"] });
  assertEquals(await tagsOf(id), ["devops"]);

  // The conditional-write trap: a patch that does not mention tags must leave
  // them alone, exactly like icon and color.
  await updatePage(id, { title: "Renamed" });
  assertEquals(await tagsOf(id), ["devops"], "untouched by an unrelated patch");

  await updatePage(id, { tags: ["devops", "mobile"] });
  assertEquals(await tagsOf(id), ["devops", "mobile"]);

  await updatePage(id, { tags: [] });
  assertEquals(await tagsOf(id), [], "clearing is possible");
});
