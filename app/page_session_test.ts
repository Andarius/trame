import { testTempDir } from "./test_tmp.ts";
const tmp = testTempDir("trame-page-session-test-");
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "page-session-test");
Deno.env.set("TRACKER_OUTBOX", `${tmp}/outbox.jsonl`);
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_PORT_FILE", `${tmp}/port.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL(".", import.meta.url).pathname);

import { assertEquals, assertRejects } from "@std/assert";

const card = async (id: string) => {
  const { db } = await import("./db.ts");
  const pg = await db();
  return (await pg.query(
    `select page_id, client_id, specs_page_id, deleted from sessions where id=$1`,
    [id],
  )).rows[0] as {
    page_id: string | null;
    client_id: string | null;
    specs_page_id: string | null;
    deleted: boolean;
  };
};

// The whole point: a plan you wrote by hand becomes the card's specs, in place.
Deno.test("sessionFromPage: the page becomes the card's specs, the story above is the anchor", async () => {
  const { ensureSpecsPage, resolveClient, sessionFromPage } = await import("./db.ts");
  const { createPage, getPage } = await import("./pages.ts");

  const clientId = await resolveClient("Convert Co");
  const storyId = await createPage({ title: "Ship it", kind: "story", parent_id: clientId });
  const planId = await createPage({ title: "  Star pages plan  ", parent_id: storyId });

  const { id, created } = await sessionFromPage(planId);
  assertEquals(created, true);

  const row = await card(id);
  assertEquals(row.specs_page_id, planId, "the page itself is the spec page");
  assertEquals(row.page_id, storyId, "anchored to the story above, not to the page");
  assertEquals(row.client_id, clientId);

  const plan = await getPage(planId) as unknown as { kind: string; title: string };
  assertEquals(plan.kind, "page", "converting must not promote the page to a story");

  // the card's title is the page's, trimmed
  const { getSession } = await import("./db.ts");
  const session = await getSession(id) as unknown as { title: string; specs: string | null };
  assertEquals(session.title, "Star pages plan");

  // every downstream spec reader follows the adopted page instead of minting one
  assertEquals(await ensureSpecsPage(id), planId);
});

Deno.test("sessionFromPage: one card per page, resurrected rather than forked", async () => {
  const { deleteSession, sessionFromPage } = await import("./db.ts");
  const { createPage } = await import("./pages.ts");

  const planId = await createPage({ title: "Idempotent plan", parent_id: null });
  const first = await sessionFromPage(planId);

  const again = await sessionFromPage(planId);
  assertEquals(again, { id: first.id, created: false }, "converting twice reuses the card");

  // a deleted card is not a reason to fork a second one
  await deleteSession(first.id);
  assertEquals((await card(first.id)).deleted, true);
  const revived = await sessionFromPage(planId);
  assertEquals(revived.id, first.id);
  assertEquals((await card(first.id)).deleted, false);
});

Deno.test("sessionFromPage: the id is a function of the page, so two nodes converge", async () => {
  const { db, sessionFromPage } = await import("./db.ts");
  const { createPage } = await import("./pages.ts");
  const pg = await db();

  const planId = await createPage({ title: "Converging plan", parent_id: null });
  const { id } = await sessionFromPage(planId);

  // simulate the other node: same page id, a row that arrived by sync under that id
  await pg.query(`delete from sessions where id=$1`, [id]);
  const second = await sessionFromPage(planId);
  assertEquals(second.id, id, "the same page always mints the same card id");
});

Deno.test("sessionFromPage: anchorless pages still land on their project", async () => {
  const { resolveClient, sessionFromPage } = await import("./db.ts");
  const { createPage } = await import("./pages.ts");

  const clientId = await resolveClient("Anchorless Co");
  // directly under the project: storyAbove stops at the project boundary, so no anchor
  const underProject = await createPage({ title: "Loose plan", parent_id: clientId });
  const onProject = await sessionFromPage(underProject);
  const projectRow = await card(onProject.id);
  assertEquals(projectRow.page_id, null, "no story above it to anchor to");
  assertEquals(projectRow.client_id, clientId, "but the project is still walked for");

  const orphan = await createPage({ title: "Top-level plan", parent_id: null });
  const detached = await card((await sessionFromPage(orphan)).id);
  assertEquals(detached.page_id, null);
  assertEquals(detached.client_id, null);
});

Deno.test("sessionFromPage: only a plain page is a card's specs", async () => {
  const { resolveClient, sessionFromPage } = await import("./db.ts");
  const { createPage } = await import("./pages.ts");

  const clientId = await resolveClient("Guarded Co");
  const storyId = await createPage({ title: "A story", kind: "story", parent_id: clientId });
  for (const [what, id] of [["story", storyId], ["project", clientId]] as const) {
    await assertRejects(
      () => sessionFromPage(id),
      Error,
      "not a card's specs",
      `a ${what} page must not convert`,
    );
  }
  await assertRejects(() => sessionFromPage(crypto.randomUUID()), Error, "unknown page");
});

// The card anchors ABOVE the page, so without the specs_page_id arm of the query the
// page it is written on would read "no sessions yet".
Deno.test("getPage lists the card whose specs it holds", async () => {
  const { resolveClient, sessionFromPage } = await import("./db.ts");
  const { createPage, getPage } = await import("./pages.ts");

  const clientId = await resolveClient("Rollup Co");
  const storyId = await createPage({ title: "Rollup story", kind: "story", parent_id: clientId });
  const planId = await createPage({ title: "Visible plan", parent_id: storyId });
  const { id } = await sessionFromPage(planId);

  const page = await getPage(planId) as unknown as { sessions: { id: string }[] };
  assertEquals(page.sessions.map((s) => s.id), [id]);
});
