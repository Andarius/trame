import { testTempDir } from "@trame/plugin-test";
const tmp = testTempDir("trame-cockpit-store-test-");
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "cockpit-store-test");
Deno.env.set("TRACKER_OUTBOX", `${tmp}/outbox.jsonl`);
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_PORT_FILE", `${tmp}/port.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL("../..", import.meta.url).pathname);
const { APP_CTX } = await import("@trame/plugin-api");

import { assertEquals } from "@std/assert";

const TAG = "cockpit-devops";
const mapping = (pageId: string) => ({
  pageId,
  tagKey: TAG,
  tagLabel: "cockpit:devops",
});

// A story filed under another story (a mirrored ticket, say) belongs to the
// project above them both — the filer must see it, file it under that
// project's mapping, and the next mirror pass must find it again instead of
// creating a second page for the same ticket.
Deno.test("a story nested under a story is owned by the project above both", async () => {
  const { createPage } = await import("@trame/plugin-api");
  const { adoptAsMirror, loadMirrorPages, loadPendingPages, mappedProjectOf } =
    await import(
      "./mirror-store.ts"
    );
  const project = await createPage(APP_CTX, { title: "Soren", kind: "project" });
  const ticket = await createPage(APP_CTX, {
    title: "GEN-1 — Infra",
    kind: "story",
    parent_id: project,
  });
  await adoptAsMirror(ticket, "GEN-1");
  const nested = await createPage(APP_CTX, {
    title: "Tooling hardening",
    kind: "page",
    parent_id: ticket,
    tags: [TAG],
  });
  await Promise.resolve(APP_CTX.q).then((pg) =>
    pg.query(`update pages set kind='story' where id=$1`, [nested])
  );
  const loose = await createPage(APP_CTX, {
    title: "Loose story",
    kind: "story",
    tags: [TAG],
  });

  const pending = await loadPendingPages([mapping(project)]);
  assertEquals(pending.map((p) => p.pageId), [nested]);
  assertEquals(pending[0].parentTitle, "GEN-1 — Infra");
  assertEquals(await mappedProjectOf(nested, [project]), project);
  assertEquals(await mappedProjectOf(ticket, [project]), project);
  assertEquals(await mappedProjectOf(loose, [project]), null);

  // filed → stamped → the reconcile sees it where it lives, so no duplicate
  await adoptAsMirror(nested, "GEN-2");
  assertEquals((await loadPendingPages([mapping(project)])).length, 0);
  assertEquals(
    (await loadMirrorPages(project)).map((m) => [m.id, m.ref]),
    [[nested, "GEN-2"], [ticket, "GEN-1"]],
  );
});

Deno.test("a blank mapping id is skipped, not sent to the uuid cast", async () => {
  const { createPage } = await import("@trame/plugin-api");
  const { loadPendingPages, mappedProjectOf } = await import(
    "./mirror-store.ts"
  );
  const project = await createPage(APP_CTX, {
    title: "Blank-neighbour",
    kind: "project",
  });
  const story = await createPage(APP_CTX, {
    title: "S",
    kind: "story",
    parent_id: project,
    tags: [TAG],
  });
  assertEquals(
    (await loadPendingPages([mapping(""), mapping(project)])).map((p) =>
      p.pageId
    ),
    [story],
  );
  assertEquals(await mappedProjectOf(story, ["", project]), project);
  assertEquals(await mappedProjectOf(story, [""]), null);
});

Deno.test("a mapped project mapped inside another owns its own subtree", async () => {
  const { createPage } = await import("@trame/plugin-api");
  const { adoptAsMirror, loadMirrorPages, loadPendingPages, mappedProjectOf } =
    await import(
      "./mirror-store.ts"
    );
  const outer = await createPage(APP_CTX, { title: "Outer", kind: "project" });
  const inner = await createPage(APP_CTX, {
    title: "Inner",
    kind: "project",
    parent_id: outer,
  });
  const story = await createPage(APP_CTX, {
    title: "Deep",
    kind: "story",
    parent_id: inner,
    tags: [TAG],
  });
  const pending = await loadPendingPages([mapping(outer), mapping(inner)]);
  assertEquals(pending.map((p) => p.pageId), [story]);
  assertEquals(await mappedProjectOf(story, [outer, inner]), inner);
  await adoptAsMirror(story, "GEN-3");
  assertEquals(
    (await loadMirrorPages(inner, [outer, inner])).map((m) => m.id),
    [story],
  );
  assertEquals(await loadMirrorPages(outer, [outer, inner]), []);
  // without the boundary the outer project would claim it — the caller passes every mapping
  assertEquals((await loadMirrorPages(outer)).map((m) => m.id), [story]);
});

Deno.test("a deleted or missing mapped ancestor owns nothing", async () => {
  const { createPage, deletePage } = await import("@trame/plugin-api");
  const { loadPendingPages, mappedProjectOf } = await import(
    "./mirror-store.ts"
  );
  const project = await createPage(APP_CTX, { title: "Gone", kind: "project" });
  const mid = await createPage(APP_CTX, {
    title: "Mid",
    kind: "page",
    parent_id: project,
  });
  const story = await createPage(APP_CTX, {
    title: "Orphaned",
    kind: "story",
    parent_id: mid,
    tags: [TAG],
  });
  // delete only the project row: parent_id has no FK, so the subtree can outlive it
  await APP_CTX.q.query(`update pages set deleted = true where id = $1`, [
    project,
  ]);
  assertEquals(await loadPendingPages([mapping(project)]), []);
  assertEquals(await mappedProjectOf(story, [project]), null);
  const ghost = crypto.randomUUID();
  await APP_CTX.q.query(`update pages set parent_id = $2 where id = $1`, [
    mid,
    ghost,
  ]);
  assertEquals(await loadPendingPages([mapping(ghost)]), []);
  assertEquals(await mappedProjectOf(story, [ghost]), null);
  await deletePage(APP_CTX, story);
});

Deno.test("a parent cycle terminates and owns nothing", async () => {
  const { createPage } = await import("@trame/plugin-api");
  const { loadPendingPages, mappedProjectOf } = await import(
    "./mirror-store.ts"
  );
  const project = await createPage(APP_CTX, { title: "Cyclic", kind: "project" });
  const a = await createPage(APP_CTX, { title: "A", kind: "story", tags: [TAG] });
  const b = await createPage(APP_CTX, {
    title: "B",
    kind: "story",
    parent_id: project,
    tags: [TAG],
  });
  await APP_CTX.q.query(`update pages set parent_id = $2 where id = $1`, [
    b,
    a,
  ]);
  await APP_CTX.q.query(`update pages set parent_id = $2 where id = $1`, [
    a,
    b,
  ]);
  assertEquals(await loadPendingPages([mapping(project)]), []);
  assertEquals(await mappedProjectOf(a, [project]), null);
});

Deno.test("all sessions under a tagged filed user story are pending, once", async () => {
  const { createPage, getPage } = await import("@trame/plugin-api");
  const { upsertSession } = await import("@trame/plugin-api");
  const { adoptAsUserStory, adoptSessionAsFiled, loadPendingSessions } =
    await import(
      "./mirror-store.ts"
    );
  const project = await createPage(APP_CTX, { title: "US-land", kind: "project" });
  const story = await createPage(APP_CTX, {
    title: "Hardening",
    kind: "story",
    parent_id: project,
    tags: [TAG],
  });
  const tagged = await upsertSession(APP_CTX, {
    title: "sre — R01",
    page_id: story,
    tags: [TAG],
    next_step: "Restrict the identity.",
  });
  const untagged = await upsertSession(APP_CTX, {
    title: "sre — untagged",
    page_id: story,
  });

  // no user story yet: nothing to file under
  assertEquals(await loadPendingSessions([mapping(project)]), []);

  await adoptAsUserStory(story, "US-9");
  const pending = await loadPendingSessions([mapping(project)]);
  assertEquals(
    pending.map((p) => [p.sessionId, p.userStory, p.storyTitle]).sort(),
    [
      [tagged, "US-9", "Hardening"],
      [untagged, "US-9", "Hardening"],
    ].sort(),
  );
  // the story itself is no longer a pending page either
  const { loadPendingPages } = await import("./mirror-store.ts");
  assertEquals(await loadPendingPages([mapping(project)]), []);

  await adoptSessionAsFiled(tagged, "GEN-42");
  await adoptSessionAsFiled(untagged, "GEN-43");
  assertEquals(await loadPendingSessions([mapping(project)]), []);
  const { getSession } = await import("@trame/plugin-api");
  const specsId = (await getSession(APP_CTX, tagged))!.specs_page_id as string;
  const specs = await getPage(APP_CTX, specsId) as unknown as { content: unknown[] };
  assertEquals(
    JSON.stringify(specs.content).includes("cockpit_ref=GEN-42"),
    true,
  );
});

Deno.test("two mappings on one project: the story's tag decides which scope its sessions file into", async () => {
  const { createPage } = await import("@trame/plugin-api");
  const { upsertSession } = await import("@trame/plugin-api");
  const { adoptAsUserStory, loadPendingSessions } = await import(
    "./mirror-store.ts"
  );
  const project = await createPage(APP_CTX, {
    title: "Two-scope project",
    kind: "project",
  });
  const story = await createPage(APP_CTX, {
    title: "Billing lock",
    kind: "story",
    parent_id: project,
    tags: ["cockpit-client"],
  });
  await adoptAsUserStory(story, "US-24");
  const client = await upsertSession(APP_CTX, {
    title: "billing — lock",
    page_id: story,
    tags: ["cockpit-client"],
    next_step: "Review.",
  });
  await upsertSession(APP_CTX, {
    title: "billing — devops-tagged",
    page_id: story,
    tags: ["cockpit-devops"],
    next_step: "Nope.",
  });
  const maps = [
    { pageId: project, tagKey: "cockpit-devops", tagLabel: "cockpit:devops" },
    { pageId: project, tagKey: "cockpit-client", tagLabel: "cockpit:client" },
  ];
  assertEquals(
    (await loadPendingSessions(maps)).map((p) => [p.sessionId, p.tagLabel]),
    [[client, "cockpit:client"]],
  );
});

Deno.test("standalone selection requires an explicit tag and a live mapped project", async () => {
  const { createPage } = await import("@trame/plugin-api");
const { upsertSession } = await import("@trame/plugin-api");
  const { loadPendingSessions } = await import("./mirror-store.ts");
  const project = await createPage(APP_CTX, { title: "Standalone", kind: "project" });
  const elsewhere = await createPage(APP_CTX, { title: "Elsewhere", kind: "project" });
  const unfiled = await createPage(APP_CTX, {
    title: "Unfiled US",
    kind: "story",
    parent_id: project,
    tags: [TAG],
  });
  const cases = [
    { title: "tagged", client_id: project, tags: [TAG], expected: true },
    { title: "untagged", client_id: project, tags: [], expected: false },
    {
      title: "done",
      client_id: project,
      tags: [TAG],
      status: "done",
      expected: false,
    },
    { title: "unmapped", client_id: elsewhere, tags: [TAG], expected: false },
    {
      title: "unfiled parent",
      client_id: project,
      page_id: unfiled,
      tags: [TAG],
      expected: false,
    },
    {
      title: "conflicting tags",
      client_id: project,
      tags: [TAG, "cockpit-client"],
      expected: false,
    },
  ];
  const expected: string[] = [];
  for (const { expected: include, ...fields } of cases) {
    const id = await upsertSession(APP_CTX, fields);
    if (include) expected.push(id);
  }
  const skipped: { title: string; reason: string }[] = [];
  const pending = await loadPendingSessions(
    [mapping(""), mapping(project)],
    skipped,
  );
  assertEquals(pending.map((p) => p.sessionId), expected);
  assertEquals(pending.map((p) => [p.userStory, p.mappingIndex]), [[null, 1]]);
  assertEquals(skipped.map((p) => p.title), ["conflicting tags"]);
  await APP_CTX.q.query("update pages set deleted = true where id = $1", [
    project,
  ]);
  assertEquals(await loadPendingSessions([mapping(project)]), []);
});

Deno.test("session routing keeps nested ownership and mapping identity despite stale client ids", async () => {
  const { createPage } = await import("@trame/plugin-api");
const { upsertSession } = await import("@trame/plugin-api");
  const { adoptAsUserStory, loadPendingSessions } = await import(
    "./mirror-store.ts"
  );
  const outer = await createPage(APP_CTX, { title: "Session outer", kind: "project" });
  const inner = await createPage(APP_CTX, {
    title: "Session inner",
    kind: "project",
    parent_id: outer,
  });
  const story = await createPage(APP_CTX, {
    title: "Inner story",
    kind: "story",
    parent_id: inner,
    tags: [TAG],
  });
  await adoptAsUserStory(story, "US-40");
  const id = await upsertSession(APP_CTX, {
    title: "Inherited",
    page_id: story,
    client_id: outer,
  });
  const maps = [mapping(outer), mapping(inner)];
  assertEquals(
    (await loadPendingSessions(maps)).map((p) => [p.sessionId, p.mappingIndex]),
    [[id, 1]],
  );
  assertEquals(
    await loadPendingSessions([mapping(outer), {
      ...mapping(inner),
      tagKey: "cockpit-client",
    }]),
    [],
  );
  await APP_CTX.q.query("update pages set deleted = true where id = $1", [
    story,
  ]);
  assertEquals(await loadPendingSessions(maps), []);
});

Deno.test("legacy migration verifies origin, preserves page identity, and resumes after a remote conflict", async () => {
  const { createPage, getPage, updatePage } = await import("@trame/plugin-api");
  const { upsertSession, getSession } = await import("@trame/plugin-api");
  const { legacyParents, migrateLegacyParent } = await import("./migration.ts");
  const { adoptAsMirror } = await import("./mirror-store.ts");
  const { refOfContent, usOfContent } = await import("./marks.ts");
  const fixture = JSON.parse(
    await Deno.readTextFile(new URL("fixture.sample.json", import.meta.url)),
  );
  const project = await createPage(APP_CTX, { title: "Migration", kind: "project" });
  const pageId = await createPage(APP_CTX, {
    title: "GEN-90 — Legacy parent",
    kind: "story",
    parent_id: project,
    tags: [TAG],
    content: [{ type: "text", id: "original-block", text: "Original notes" }],
  });
  const sessionId = await upsertSession(APP_CTX, {
    title: "Original child",
    page_id: pageId,
  });
  await adoptAsMirror(pageId, "GEN-90");
  const remote = {
    ...fixture.tickets[0],
    reference: "GEN-90",
    objective: "Preserve this work",
    user_story_id: null,
    updated_at: "2026-09-07T12:00:00Z",
    meta: { sync: { origin_id: "wrong-page" } },
  };
  const originalFetch = globalThis.fetch;
  let createCalls = 0;
  let patchCalls = 0;
  let conflict = true;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/user-stories/create")) {
      createCalls++;
      const body = await new Response(String(init?.body)).json();
      assertEquals(body.origin_id, pageId);
      assertEquals(body.title, "Legacy parent");
      assertEquals(body.description.includes("Preserve this work"), true);
      return Response.json({
        id: "us-90-id",
        reference: "US-90",
        updated_at: remote.updated_at,
        created: createCalls === 1,
      });
    }
    if (init?.method === "PATCH") {
      patchCalls++;
      const body = await new Response(String(init.body)).json();
      assertEquals(body.expected_updated_at, remote.updated_at);
      assertEquals(body.fields, { user_story_id: "US-90" });
      if (conflict) {
        return Response.json({ error: "conflict" }, { status: 409 });
      }
      Object.assign(remote, {
        user_story_id: "us-90-id",
        meta: { ...remote.meta, ...body.meta },
      });
      return Response.json({
        reference: remote.reference,
        updated_at: remote.updated_at,
      });
    }
    return Response.json({
      now: remote.updated_at,
      has_more: false,
      next_since: null,
      tickets: [remote],
    });
  };
  try {
    const maps = [{ product: "devops", pageId: project }];
    assertEquals(await legacyParents(maps, "https://cockpit.test", "test"), []);
    remote.meta.sync.origin_id = pageId;
    const [parent] = await legacyParents(maps, "https://cockpit.test", "test");
    for (
      const snapshot of [
        { ...parent, scope: { kind: "product" as const, slug: "other" } },
        { ...parent, page: { ...parent.page, updated_at: "2000-01-01" } },
        { ...parent, ticket: { ...parent.ticket, updated_at: "2000-01-01" } },
      ]
    ) {
      let refused = false;
      try {
        await migrateLegacyParent(
          parent,
          "https://cockpit.test",
          "test",
          snapshot,
        );
      } catch {
        refused = true;
      }
      assertEquals(refused, true);
    }
    assertEquals(createCalls, 0);
    let failed = false;
    try {
      await migrateLegacyParent(parent, "https://cockpit.test", "test");
    } catch {
      failed = true;
    }
    assertEquals(failed, true);
    const converted = await getPage(APP_CTX, pageId) as unknown as {
      title: string;
      content: unknown[];
    };
    assertEquals(converted.title, "Legacy parent");
    assertEquals(refOfContent(converted.content), "GEN-90");
    assertEquals(usOfContent(converted.content), "US-90");
    assertEquals((converted.content[0] as { id: string }).id, "original-block");
    assertEquals((await getSession(APP_CTX, sessionId))?.story?.id, pageId);
    conflict = false;
    const [retry] = await legacyParents(maps, "https://cockpit.test", "test");
    assertEquals(
      await migrateLegacyParent(retry, "https://cockpit.test", "test"),
      "US-90",
    );
    const [finished] = await legacyParents(
      maps,
      "https://cockpit.test",
      "test",
    );
    assertEquals(
      await migrateLegacyParent(finished, "https://cockpit.test", "test"),
      "US-90",
    );
    assertEquals([createCalls, patchCalls], [3, 2]);
    for (
      const altered of [
        { ...finished, userStory: "US-91" },
        { ...finished, ticket: { ...finished.ticket, user_story_id: null } },
        {
          ...finished,
          ticket: { ...finished.ticket, user_story_id: "different-us" },
        },
      ]
    ) {
      let refused = false;
      try {
        await migrateLegacyParent(altered, "https://cockpit.test", "test");
      } catch {
        refused = true;
      }
      assertEquals(refused, true);
    }
    assertEquals(patchCalls, 2);
    await updatePage(APP_CTX, pageId, { title: "Local edit after migration" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("tag sync resolves labels, excludes routing tags, and follows session ownership after filing", async () => {
const { upsertSession, ensureTag, updateTag, deleteTag } = await import("@trame/plugin-api");
  const { createPage, updatePage } = await import("@trame/plugin-api");
  const { adoptAsUserStory, adoptSessionAsFiled, loadTagSyncItems } =
    await import("./mirror-store.ts");
  const project = await createPage(APP_CTX, {
    title: "Tag sync project",
    kind: "project",
  });
  const other = await createPage(APP_CTX, { title: "Other project", kind: "project" });
  const story = await createPage(APP_CTX, {
    title: "Infra tag story",
    kind: "story",
    parent_id: project,
    tags: [TAG, "priority-p1"],
  });
  await ensureTag(APP_CTX, { label: "cockpit:devops" });
  await ensureTag(APP_CTX, { label: "priority:P1" });
  await ensureTag(APP_CTX, { label: "Customer label" });
  await adoptAsUserStory(story, "US-810");
  const session = await upsertSession(APP_CTX, {
    title: "Tagged exported ticket",
    status: "done",
    page_id: story,
    client_id: other,
    tags: ["customer-label"],
  });
  await adoptSessionAsFiled(session, "GEN-811");
  const foreign = await createPage(APP_CTX, {
    title: "Foreign",
    kind: "story",
    parent_id: other,
    tags: [TAG],
  });
  await adoptAsUserStory(foreign, "US-812");
  const items = await loadTagSyncItems([mapping(project)]);
  assertEquals(items.map((item) => [item.reference, item.tags]).sort(), [[
    "GEN-811",
    ["Customer label", "trame"],
  ], ["US-810", ["priority:P1", "trame"]]]);
  const pg = APP_CTX.q;
  const tag = (await pg.query(`select id from tags where key='customer-label'`))
    .rows[0] as { id: string };
  await updateTag(APP_CTX, tag.id, { label: "Renamed label" });
  assertEquals(
    (await loadTagSyncItems([mapping(project)])).find((item) =>
      item.reference === "GEN-811"
    )?.tags,
    ["Renamed label", "trame"],
  );
  await deleteTag(APP_CTX, tag.id);
  assertEquals(
    (await loadTagSyncItems([mapping(project)])).find((item) =>
      item.reference === "GEN-811"
    )?.tags,
    ["trame"],
  );
  await updatePage(APP_CTX, story, { tags: [TAG] });
  assertEquals(
    (await loadTagSyncItems([mapping(project)])).find((item) =>
      item.reference === "US-810"
    )?.tags,
    ["trame"],
  );
});

Deno.test("tag sync rejects ambiguous scopes and respects the nearest mapped project", async () => {
  const { upsertSession, ensureTag } = await import("@trame/plugin-api");
  const { createPage } = await import("@trame/plugin-api");
  const { adoptAsUserStory, adoptSessionAsFiled, loadTagSyncItems } =
    await import("./mirror-store.ts");
  const outer = await createPage(APP_CTX, {
    title: "Outer tag project",
    kind: "project",
  });
  const inner = await createPage(APP_CTX, {
    title: "Inner tag project",
    kind: "project",
    parent_id: outer,
  });
  const story = await createPage(APP_CTX, {
    title: "Inner story",
    kind: "story",
    parent_id: inner,
    tags: ["cockpit-client"],
  });
  await ensureTag(APP_CTX, { label: "cockpit:client" });
  await ensureTag(APP_CTX, { label: "area:frontend" });
  await adoptAsUserStory(story, "US-820");
  const session = await upsertSession(APP_CTX, {
    title: "Conflicting routing tag",
    status: "active",
    client_id: outer,
    page_id: story,
    tags: [TAG, "area-frontend"],
  });
  await adoptSessionAsFiled(session, "GEN-821");
  const maps = [mapping(outer), {
    pageId: inner,
    tagKey: "cockpit-client",
    tagLabel: "cockpit:client",
  }, mapping(inner)];
  const items = await loadTagSyncItems(maps);
  assertEquals(items.map((item) => [item.reference, item.mappingIndex]), [[
    "US-820",
    1,
  ]]);
  assertEquals(await loadTagSyncItems([]), []);
});

Deno.test("an assigned card is keyed on its ref: re-creating it adds nothing, other holders are held", async () => {
  const { createPage } = await import("@trame/plugin-api");
  const { adoptAsMirror, createAssignedCard, ensureAssignedStory, loadAssignedCards } = await import(
    "./mirror-store.ts"
  );
  const project = await createPage(APP_CTX, { title: "Assigned-land", kind: "project" });
  const story = await ensureAssignedStory(project);
  assertEquals(await ensureAssignedStory(project), story);

  const fields = { title: "GEN-50 — Fix", next_step: "Fix it.", summary: "" };
  const id = await createAssignedCard("GEN-50", fields, story, null);
  assertEquals(await createAssignedCard("GEN-50", fields, story, null), id);
  const pg = APP_CTX.q;
  const n = (await pg.query(
    `select count(*)::int as n from sessions where id=$1`,
    [id],
  )).rows[0] as { n: number };
  assertEquals(n.n, 1);

  const mirrored = await createPage(APP_CTX, { title: "GEN-51", kind: "story", parent_id: project });
  await adoptAsMirror(mirrored, "GEN-51");
  const { cards, held } = await loadAssignedCards(["GEN-51"]);
  assertEquals(cards.get("GEN-50"), { id, deleted: false, terminal: false });
  assertEquals(cards.has("GEN-51"), false);
  assertEquals(held.has("GEN-51") && !held.has("GEN-50"), true);
});
