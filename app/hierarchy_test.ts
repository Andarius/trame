import { testTempDir } from "./test_tmp.ts";
const tmp = testTempDir("trame-hierarchy-test-");
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "hierarchy-test");
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL(".", import.meta.url).pathname);

import { assertEquals, assertRejects } from "@std/assert";
const { createPage, getPage, movePage } = await import("./pages.ts");
const pageMeta = async (id: string) =>
  await getPage(id) as unknown as { kind: string; parent_id: string | null };
const { db, upsertSession } = await import("./db.ts");
const { stampRef, stampMark, US_MARK } = await import(
  "./plugins/cockpit/mirror.ts"
);
const {
  loadPendingPages,
  loadPendingSessions,
  loadPageRoutes,
  adoptSessionAsFiled,
  adoptAsMirror,
} = await import("./plugins/cockpit/mirror-store.ts");

Deno.test("hierarchy rejects nested US creation and moves but preserves documents and legacy tickets", async () => {
  const project = await createPage({ title: "Hierarchy", kind: "project" });
  const us = await createPage({
    title: "Infra",
    kind: "story",
    parent_id: project,
  });
  const doc = await createPage({ title: "Plan", parent_id: us });
  const deep = await createPage({ title: "Notes", parent_id: doc });
  for (const parent_id of [us, deep]) {
    await assertRejects(
      () => createPage({ title: "Nested US", kind: "story", parent_id }),
      Error,
      "cannot be nested",
    );
  }
  const other = await createPage({
    title: "Other US",
    kind: "story",
    parent_id: project,
  });
  await assertRejects(
    () => movePage(other, { parent_id: deep }),
    Error,
    "cannot be nested",
  );
  const folder = await createPage({ title: "Folder", parent_id: project });
  await movePage(other, { parent_id: folder });
  await assertRejects(
    () => movePage(folder, { parent_id: us }),
    Error,
    "cannot be nested",
  );
  assertEquals((await pageMeta(folder)).parent_id, project);
  const legacy = await createPage({
    title: "Legacy ticket",
    kind: "story",
    parent_id: us,
    content: stampRef([], "GEN-900"),
  });
  const id = await upsertSession({ title: "New ticket", page_id: deep });
  const pg = await db();
  assertEquals(
    ((await pg.query(`select page_id from sessions where id=$1`, [id]))
      .rows[0] as { page_id: string }).page_id,
    us,
  );
  assertEquals((await pageMeta(deep)).kind, "page");
  await movePage(deep, { parent_id: legacy });
  assertEquals((await pageMeta(deep)).parent_id, legacy);
});

Deno.test("legacy nested work inherits the nearest linked US, preserves references, and rejects conflicts", async () => {
  const project = await createPage({
    title: "Sync hierarchy",
    kind: "project",
  });
  const maps = [{
    pageId: project,
    tagKey: "cockpit-devops",
    tagLabel: "cockpit:devops",
  }, { pageId: project, tagKey: "cockpit-client", tagLabel: "cockpit:client" }];
  const us = await createPage({
    title: "Nouvelle infra",
    kind: "story",
    parent_id: project,
    tags: ["cockpit-devops"],
    content: stampMark([], US_MARK, "US-21"),
  });
  const legacy = await createPage({
    title: "Monitoring",
    kind: "story",
    parent_id: us,
    content: stampRef([], "GEN-7148"),
  });
  const doc = await createPage({ title: "Notes", parent_id: legacy });
  const nested = await createPage({
    title: "Grafana alerts",
    parent_id: doc,
    brief: "Monitor the new infrastructure",
  });
  const pg = await db();
  // Seed the old structure directly; new writes now reject this hierarchy.
  await pg.query(`update pages set kind='story' where id=$1`, [nested]);
  const session = await upsertSession({
    title: "Telemetry isolation",
    page_id: us,
    next_step: "Isolate prod telemetry",
  });
  await pg.query(`update sessions set page_id=$2 where id=$1`, [session, doc]);
  assertEquals((await loadPendingPages(maps)).map((p) => p.pageId), [nested]);
  assertEquals(
    (await loadPendingSessions(maps)).map((s) => [s.sessionId, s.userStory]),
    [[session, "US-21"]],
  );
  const conflict = await upsertSession({
    title: "Conflicting route",
    page_id: us,
    tags: ["cockpit-client"],
  });
  await pg.query(`update sessions set page_id=$2 where id=$1`, [conflict, doc]);
  const skipped: { title: string; reason: string }[] = [];
  assertEquals(
    (await loadPendingSessions(maps, skipped)).map((s) => s.sessionId),
    [session],
  );
  assertEquals(skipped.length, 1);
  await adoptSessionAsFiled(session, "GEN-999");
  await adoptAsMirror(nested, "GEN-998");
  assertEquals(await loadPendingSessions(maps), []);
  assertEquals(await loadPendingPages(maps), []);
  const nearer = await createPage({
    title: "Old nested US",
    parent_id: legacy,
    tags: ["cockpit-devops"],
  });
  await pg.query(`update pages set kind='story', content=$2 where id=$1`, [
    nearer,
    JSON.stringify(stampMark(stampRef([], "GEN-888"), US_MARK, "US-22")),
  ]);
  const child = await createPage({ title: "Deep notes", parent_id: nearer });
  assertEquals((await loadPageRoutes(maps)).get(child), {
    mappingIndex: 0,
    userStory: "US-22",
    storyTitle: "Old nested US",
  });
  await pg.query(`update pages set tags='["cockpit-client"]' where id=$1`, [
    child,
  ]);
  assertEquals("error" in (await loadPageRoutes(maps)).get(child)!, true);
  const boundary = await createPage({
    title: "Other project",
    kind: "project",
    parent_id: us,
  });
  const outside = await createPage({
    title: "Outside notes",
    parent_id: boundary,
  });
  assertEquals((await loadPageRoutes(maps)).has(outside), false);
  await pg.query(`update pages set deleted=true where id=$1`, [doc]);
  assertEquals((await loadPageRoutes(maps)).has(nested), false);
});

Deno.test("filing a legacy nested page creates a ticket once and keeps its page origin", async () => {
  const { filePage } = await import("./plugins/cockpit/mod.ts");
  const project = await createPage({ title: "Import test", kind: "project" });
  const us = await createPage({
    title: "Import US",
    kind: "story",
    parent_id: project,
    tags: ["cockpit-devops"],
    content: stampMark([], US_MARK, "US-25"),
  });
  const page = await createPage({
    title: "New alert rules",
    parent_id: us,
    brief: "Monitor prod",
  });
  await (await db()).query(`update pages set kind='story' where id=$1`, [page]);
  const maps = [{ pageId: project, product: "devops" }];
  const originalFetch = globalThis.fetch;
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Promise.resolve(
      Response.json({ reference: "GEN-777", created: true }),
    );
  };
  try {
    assertEquals(
      await filePage("https://cockpit.test", "test-token", maps, page),
      { reference: "GEN-777", created: true },
    );
    assertEquals(requests.length, 1);
    assertEquals(
      requests[0].url,
      "https://cockpit.test/api/sync/tickets/create?product=devops",
    );
    assertEquals(requests[0].body.origin_id, page);
    assertEquals(requests[0].body.user_story, "US-25");
    assertEquals(
      await filePage("https://cockpit.test", "test-token", maps, page),
      { reference: "GEN-777", created: false },
    );
    const doc = await createPage({
      title: "Supporting notes",
      parent_id: page,
    });
    assertEquals(
      "error" in
        await filePage("https://cockpit.test", "test-token", maps, doc),
      true,
    );
    assertEquals(requests.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
