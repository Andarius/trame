import { testTempDir } from "./test_tmp.ts";
// Isolated PGlite in a temp dir — set the env BEFORE importing any app module.
const tmp = testTempDir("trame-proto-test-");
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "proto-test");
Deno.env.set("TRACKER_OUTBOX", `${tmp}/outbox.jsonl`);
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_PORT_FILE", `${tmp}/port.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL(".", import.meta.url).pathname);

import { assertEquals, assertRejects } from "@std/assert";
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

Deno.test("session tags survive tracking, replacement, clearing, and schema reapplication", async () => {
  const { db, getSession, upsertSession } = await import("./db.ts");
  const pg = await db();
  // labels slug to keys on the way in, so `priority:P1` and `priority-p1` are one tag
  const id = await upsertSession({ title: "Tagged session", tags: ["priority:P1", "priority-p1", "infra"] });
  const otherId = await upsertSession({ title: "Untagged session" });
  assertEquals((await getSession(id))?.tags, ["priority-p1", "infra"]);
  assertEquals((await getSession(otherId))?.tags, []);

  await upsertSession({ id, title: "Renamed session", summary: "Tracking update" });
  await pg.exec(await Deno.readTextFile(new URL("../db/schema.sql", import.meta.url)));
  assertEquals((await getSession(id))?.tags, ["priority-p1", "infra"]);

  await upsertSession({ id, title: "Renamed session", tags: ["priority-p2"] });
  assertEquals((await getSession(id))?.tags, ["priority-p2"]);
  assertEquals((await getSession(otherId))?.tags, []);
  await upsertSession({ id, title: "Renamed session", tags: [] });
  assertEquals((await getSession(id))?.tags, []);
});

for (const [name, tags] of [
  ["null", null],
  ["string", "priority-p1"],
  ["non-string key", [42]],
  ["blank key", [" "]],
] as const) {
  Deno.test(`invalid session tags (${name}) cannot mutate a session`, async () => {
    const { getSession, SessionTagsError, upsertSession } = await import("./db.ts");
    const id = await upsertSession({ title: "Original", tags: ["priority-p1"] });
    await assertRejects(
      () => upsertSession({ id, title: "Invalid update", tags }),
      SessionTagsError,
    );
    const session = await getSession(id);
    assertEquals(session?.title, "Original");
    assertEquals(session?.tags, ["priority-p1"]);
  });
}
