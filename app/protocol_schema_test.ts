import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { testTempDir } from "./test_tmp.ts";
// Isolated PGlite in a temp dir — set the env BEFORE importing any app module.
const tmp = testTempDir("trame-proto-test-");
process.env.TRACKER_DATA_DIR = `${tmp}/pglite`;
process.env.TRACKER_NODE_ID = "proto-test";
process.env.TRACKER_OUTBOX = `${tmp}/outbox.jsonl`;
process.env.TRACKER_SETTINGS_FILE = `${tmp}/settings.json`;
process.env.TRACKER_PORT_FILE = `${tmp}/port.json`;
process.env.TRACKER_APP_ROOT = new URL(".", import.meta.url).pathname;
const { APP_CTX } = await import("./ctx.ts");

import { ENTITIES } from "../protocol/entities.ts";

/**
 * The wire contract and the schema are two files that must agree, and nothing
 * makes them. `pages.color` once existed in the schema but was missing from
 * `cols`, so it silently never synced — no error, just a column that never
 * left the laptop. This walks the real database and checks every declared
 * column exists.
 */
test("every synced column exists in the database", async () => {
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

  expect(missing, "declared in protocol/entities.ts but not in db/schema.sql").toStrictEqual([]);
});

test("a page keeps its tags through create and update", async () => {
  const { createPage, getPage, updatePage } = await import("../core/pages.ts");
  // getPage spreads an untyped row, so the column is not on the inferred type.
  const tagsOf = async (id: string) =>
    (await getPage(APP_CTX, id) as unknown as { tags: string[] }).tags;

  const id = await createPage(APP_CTX, { title: "Tagged", tags: ["devops"] });
  expect(await tagsOf(id), "untouched by an unrelated patch").toStrictEqual(["devops"]);

  // The conditional-write trap: a patch that does not mention tags must leave
  // them alone, exactly like icon and color.
  await updatePage(APP_CTX, id, { title: "Renamed" });
  expect(await tagsOf(id)).toStrictEqual(["devops"]);

  await updatePage(APP_CTX, id, { tags: ["devops", "mobile"] });
  expect(await tagsOf(id)).toStrictEqual(["devops", "mobile"]);

  await updatePage(APP_CTX, id, { tags: [] });
  expect(await tagsOf(id), "clearing is possible").toStrictEqual([]);
});

test("session tags survive tracking, replacement, clearing, and schema reapplication", async () => {
  const { db } = await import("./db.ts");
const { getSession, upsertSession } = await import("../core/sessions.ts");
  const pg = await db();
  // labels slug to keys on the way in, so `priority:P1` and `priority-p1` are one tag
  const id = await upsertSession(APP_CTX, { title: "Tagged session", tags: ["priority:P1", "priority-p1", "infra"] });
  const otherId = await upsertSession(APP_CTX, { title: "Untagged session" });
  expect((await getSession(APP_CTX, id))?.tags).toStrictEqual(["priority-p1", "infra"]);
  expect((await getSession(APP_CTX, otherId))?.tags).toStrictEqual([]);

  await upsertSession(APP_CTX, { id, title: "Renamed session", summary: "Tracking update" });
  await pg.exec(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  expect((await getSession(APP_CTX, id))?.tags).toStrictEqual(["priority-p1", "infra"]);

  await upsertSession(APP_CTX, { id, title: "Renamed session", tags: ["priority-p2"] });
  expect((await getSession(APP_CTX, id))?.tags).toStrictEqual(["priority-p2"]);
  expect((await getSession(APP_CTX, otherId))?.tags).toStrictEqual([]);
  await upsertSession(APP_CTX, { id, title: "Renamed session", tags: [] });
  expect((await getSession(APP_CTX, id))?.tags).toStrictEqual([]);
});

for (const [name, tags] of [
  ["null", null],
  ["string", "priority-p1"],
  ["non-string key", [42]],
  ["blank key", [" "]],
] as const) {
  test(`invalid session tags (${name}) cannot mutate a session`, async () => {
    const { getSession, SessionTagsError, upsertSession } = await import("../core/sessions.ts");
    const id = await upsertSession(APP_CTX, { title: "Original", tags: ["priority-p1"] });
    await expect(upsertSession(APP_CTX, { id, title: "Invalid update", tags })).rejects.toThrow(SessionTagsError);
    const session = await getSession(APP_CTX, id);
    expect(session?.title).toStrictEqual("Original");
    expect(session?.tags).toStrictEqual(["priority-p1"]);
  });
}
