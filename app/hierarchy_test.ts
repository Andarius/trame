import { testTempDir } from "./test_tmp.ts";
const tmp = testTempDir("trame-hierarchy-test-");
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "hierarchy-test");
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL(".", import.meta.url).pathname);
const { APP_CTX } = await import("./ctx.ts");

import { assertEquals, assertRejects } from "@std/assert";
const { createPage, getPage, movePage } = await import("../core/pages.ts");
const pageMeta = async (id: string) =>
  await getPage(APP_CTX, id) as unknown as { kind: string; parent_id: string | null };
const { db } = await import("./db.ts");
const { upsertSession } = await import("../core/sessions.ts");

Deno.test("hierarchy rejects nested US creation and moves but preserves documents and legacy tickets", async () => {
  const project = await createPage(APP_CTX, { title: "Hierarchy", kind: "project" });
  const us = await createPage(APP_CTX, {
    title: "Infra",
    kind: "story",
    parent_id: project,
  });
  const doc = await createPage(APP_CTX, { title: "Plan", parent_id: us });
  const deep = await createPage(APP_CTX, { title: "Notes", parent_id: doc });
  for (const parent_id of [us, deep]) {
    await assertRejects(
      () => createPage(APP_CTX, { title: "Nested US", kind: "story", parent_id }),
      Error,
      "cannot be nested",
    );
  }
  const other = await createPage(APP_CTX, {
    title: "Other US",
    kind: "story",
    parent_id: project,
  });
  await assertRejects(
    () => movePage(APP_CTX, other, { parent_id: deep }),
    Error,
    "cannot be nested",
  );
  const folder = await createPage(APP_CTX, { title: "Folder", parent_id: project });
  await movePage(APP_CTX, other, { parent_id: folder });
  await assertRejects(
    () => movePage(APP_CTX, folder, { parent_id: us }),
    Error,
    "cannot be nested",
  );
  assertEquals((await pageMeta(folder)).parent_id, project);
  const legacy = await createPage(APP_CTX, {
    title: "Legacy ticket",
    kind: "story",
    parent_id: us,
    content: [{ id: crypto.randomUUID(), type: "text", text: "{{trame:cockpit_ref=GEN-900}}" }],
  });
  const id = await upsertSession(APP_CTX, { title: "New ticket", page_id: deep });
  const pg = await db();
  assertEquals(
    ((await pg.query(`select page_id from sessions where id=$1`, [id]))
      .rows[0] as { page_id: string }).page_id,
    us,
  );
  assertEquals((await pageMeta(deep)).kind, "page");
  await movePage(APP_CTX, deep, { parent_id: legacy });
  assertEquals((await pageMeta(deep)).parent_id, legacy);
});
