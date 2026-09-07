import { testTempDir } from "../../test_tmp.ts";
const tmp = testTempDir("trame-cockpit-store-test-");
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "cockpit-store-test");
Deno.env.set("TRACKER_OUTBOX", `${tmp}/outbox.jsonl`);
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_PORT_FILE", `${tmp}/port.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL("../..", import.meta.url).pathname);

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
  const { createPage } = await import("../../pages.ts");
  const { adoptAsMirror, loadMirrorPages, loadPendingPages, mappedProjectOf } =
    await import(
      "./mirror-store.ts"
    );
  const project = await createPage({ title: "Soren", kind: "project" });
  const ticket = await createPage({
    title: "GEN-1 — Infra",
    kind: "story",
    parent_id: project,
  });
  const nested = await createPage({
    title: "Tooling hardening",
    kind: "story",
    parent_id: ticket,
    tags: [TAG],
  });
  const loose = await createPage({
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
    [[nested, "GEN-2"]],
  );
});

Deno.test("a blank mapping id is skipped, not sent to the uuid cast", async () => {
  const { createPage } = await import("../../pages.ts");
  const { loadPendingPages, mappedProjectOf } = await import(
    "./mirror-store.ts"
  );
  const project = await createPage({
    title: "Blank-neighbour",
    kind: "project",
  });
  const story = await createPage({
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
  const { createPage } = await import("../../pages.ts");
  const { adoptAsMirror, loadMirrorPages, loadPendingPages, mappedProjectOf } =
    await import(
      "./mirror-store.ts"
    );
  const outer = await createPage({ title: "Outer", kind: "project" });
  const inner = await createPage({
    title: "Inner",
    kind: "project",
    parent_id: outer,
  });
  const story = await createPage({
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
  const { createPage, deletePage } = await import("../../pages.ts");
  const { db } = await import("../../db.ts");
  const { loadPendingPages, mappedProjectOf } = await import(
    "./mirror-store.ts"
  );
  const project = await createPage({ title: "Gone", kind: "project" });
  const mid = await createPage({
    title: "Mid",
    kind: "story",
    parent_id: project,
  });
  const story = await createPage({
    title: "Orphaned",
    kind: "story",
    parent_id: mid,
    tags: [TAG],
  });
  // delete only the project row: parent_id has no FK, so the subtree can outlive it
  await (await db()).query(`update pages set deleted = true where id = $1`, [
    project,
  ]);
  assertEquals(await loadPendingPages([mapping(project)]), []);
  assertEquals(await mappedProjectOf(story, [project]), null);
  const ghost = crypto.randomUUID();
  await (await db()).query(`update pages set parent_id = $2 where id = $1`, [
    mid,
    ghost,
  ]);
  assertEquals(await loadPendingPages([mapping(ghost)]), []);
  assertEquals(await mappedProjectOf(story, [ghost]), null);
  await deletePage(story);
});

Deno.test("a parent cycle terminates and owns nothing", async () => {
  const { createPage } = await import("../../pages.ts");
  const { db } = await import("../../db.ts");
  const { loadPendingPages, mappedProjectOf } = await import(
    "./mirror-store.ts"
  );
  const project = await createPage({ title: "Cyclic", kind: "project" });
  const a = await createPage({ title: "A", kind: "story", tags: [TAG] });
  const b = await createPage({
    title: "B",
    kind: "story",
    parent_id: a,
    tags: [TAG],
  });
  await (await db()).query(`update pages set parent_id = $2 where id = $1`, [
    a,
    b,
  ]);
  assertEquals(await loadPendingPages([mapping(project)]), []);
  assertEquals(await mappedProjectOf(a, [project]), null);
});

Deno.test("a tagged session under a filed user story is pending, once", async () => {
  const { createPage, getPage } = await import("../../pages.ts");
  const { upsertSession } = await import("../../db.ts");
  const { adoptAsUserStory, adoptSessionAsFiled, loadPendingSessions } =
    await import(
      "./mirror-store.ts"
    );
  const project = await createPage({ title: "US-land", kind: "project" });
  const story = await createPage({
    title: "Hardening",
    kind: "story",
    parent_id: project,
    tags: [TAG],
  });
  const tagged = await upsertSession({
    title: "sre — R01",
    page_id: story,
    tags: [TAG],
    next_step: "Restrict the identity.",
  });
  await upsertSession({ title: "sre — untagged", page_id: story });

  // no user story yet: nothing to file under
  assertEquals(await loadPendingSessions([mapping(project)]), []);

  await adoptAsUserStory(story, "US-9");
  const pending = await loadPendingSessions([mapping(project)]);
  assertEquals(pending.map((p) => [p.sessionId, p.userStory, p.storyTitle]), [
    [tagged, "US-9", "Hardening"],
  ]);
  // the story itself is no longer a pending page either
  const { loadPendingPages } = await import("./mirror-store.ts");
  assertEquals(await loadPendingPages([mapping(project)]), []);

  await adoptSessionAsFiled(tagged, "GEN-42");
  assertEquals(await loadPendingSessions([mapping(project)]), []);
  const { getSession } = await import("../../db.ts");
  const specsId = (await getSession(tagged))!.specs_page_id as string;
  const specs = await getPage(specsId) as unknown as { content: unknown[] };
  assertEquals(
    JSON.stringify(specs.content).includes("cockpit_ref=GEN-42"),
    true,
  );
});

Deno.test("two mappings on one project: the story's tag decides which scope its sessions file into", async () => {
  const { createPage } = await import("../../pages.ts");
  const { upsertSession } = await import("../../db.ts");
  const { adoptAsUserStory, loadPendingSessions } = await import(
    "./mirror-store.ts"
  );
  const project = await createPage({
    title: "Two-scope project",
    kind: "project",
  });
  const story = await createPage({
    title: "Billing lock",
    kind: "story",
    parent_id: project,
    tags: ["cockpit-client"],
  });
  await adoptAsUserStory(story, "US-24");
  const client = await upsertSession({
    title: "billing — lock",
    page_id: story,
    tags: ["cockpit-client"],
    next_step: "Review.",
  });
  await upsertSession({
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
