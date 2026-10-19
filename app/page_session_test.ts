import { expect, test } from "bun:test";
import { testTempDir } from "./test_tmp.ts";
const tmp = testTempDir("trame-page-session-test-");
process.env.TRACKER_DATA_DIR = `${tmp}/pglite`;
process.env.TRACKER_NODE_ID = "page-session-test";
process.env.TRACKER_OUTBOX = `${tmp}/outbox.jsonl`;
process.env.TRACKER_SETTINGS_FILE = `${tmp}/settings.json`;
process.env.TRACKER_PORT_FILE = `${tmp}/port.json`;
process.env.TRACKER_APP_ROOT = new URL(".", import.meta.url).pathname;
const { APP_CTX } = await import("./ctx.ts");


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
test("sessionFromPage: the page becomes the card's specs, the story above is the anchor", async () => {
  const { ensureSpecsPage, resolveClient, sessionFromPage } = await import("../core/sessions.ts");
  const { createPage, getPage } = await import("../core/pages.ts");

  const clientId = await resolveClient(APP_CTX, "Convert Co");
  const storyId = await createPage(APP_CTX, { title: "Ship it", kind: "story", parent_id: clientId });
  const planId = await createPage(APP_CTX, { title: "  Star pages plan  ", parent_id: storyId });

  const { id, created } = await sessionFromPage(APP_CTX, planId);
  expect(created).toStrictEqual(true);

  const row = await card(id);
  expect(row.specs_page_id, "the page itself is the spec page").toStrictEqual(planId);
  expect(row.page_id, "anchored to the story above, not to the page").toStrictEqual(storyId);
  expect(row.client_id).toStrictEqual(clientId);

  const plan = await getPage(APP_CTX, planId) as unknown as { kind: string; title: string };
  expect(plan.kind, "converting must not promote the page to a story").toStrictEqual("page");

  // the card's title is the page's, trimmed
  const { getSession } = await import("../core/sessions.ts");
  const session = await getSession(APP_CTX, id) as unknown as { title: string; specs: string | null };
  expect(session.title).toStrictEqual("Star pages plan");

  // every downstream spec reader follows the adopted page instead of minting one
  expect(await ensureSpecsPage(APP_CTX, id)).toStrictEqual(planId);
});

test("sessionFromPage: one card per page, resurrected rather than forked", async () => {
  const { deleteSession, sessionFromPage } = await import("../core/sessions.ts");
  const { createPage } = await import("../core/pages.ts");

  const planId = await createPage(APP_CTX, { title: "Idempotent plan", parent_id: null });
  const first = await sessionFromPage(APP_CTX, planId);

  const again = await sessionFromPage(APP_CTX, planId);
  expect(again, "converting twice reuses the card").toStrictEqual({ id: first.id, created: false });

  // a deleted card is not a reason to fork a second one
  await deleteSession(APP_CTX, first.id);
  expect((await card(first.id)).deleted).toStrictEqual(true);
  const revived = await sessionFromPage(APP_CTX, planId);
  expect(revived.id).toStrictEqual(first.id);
  expect((await card(first.id)).deleted).toStrictEqual(false);
});

test("sessionFromPage: the id is a function of the page, so two nodes converge", async () => {
  const { db } = await import("./db.ts");
const { sessionFromPage } = await import("../core/sessions.ts");
  const { createPage } = await import("../core/pages.ts");
  const pg = await db();

  const planId = await createPage(APP_CTX, { title: "Converging plan", parent_id: null });
  const { id } = await sessionFromPage(APP_CTX, planId);

  // simulate the other node: same page id, a row that arrived by sync under that id
  await pg.query(`delete from sessions where id=$1`, [id]);
  const second = await sessionFromPage(APP_CTX, planId);
  expect(second.id, "the same page always mints the same card id").toStrictEqual(id);
});

test("sessionFromPage: anchorless pages still land on their project", async () => {
  const { resolveClient, sessionFromPage } = await import("../core/sessions.ts");
  const { createPage } = await import("../core/pages.ts");

  const clientId = await resolveClient(APP_CTX, "Anchorless Co");
  // directly under the project: storyAbove stops at the project boundary, so no anchor
  const underProject = await createPage(APP_CTX, { title: "Loose plan", parent_id: clientId });
  const onProject = await sessionFromPage(APP_CTX, underProject);
  const projectRow = await card(onProject.id);
  expect(projectRow.page_id, "no story above it to anchor to").toStrictEqual(null);
  expect(projectRow.client_id, "but the project is still walked for").toStrictEqual(clientId);

  const orphan = await createPage(APP_CTX, { title: "Top-level plan", parent_id: null });
  const detached = await card((await sessionFromPage(APP_CTX, orphan)).id);
  expect(detached.page_id).toStrictEqual(null);
  expect(detached.client_id).toStrictEqual(null);
});

test("sessionFromPage: only a plain page is a card's specs", async () => {
  const { resolveClient, sessionFromPage } = await import("../core/sessions.ts");
  const { createPage } = await import("../core/pages.ts");

  const clientId = await resolveClient(APP_CTX, "Guarded Co");
  const storyId = await createPage(APP_CTX, { title: "A story", kind: "story", parent_id: clientId });
  for (const [what, id] of [["story", storyId], ["project", clientId]] as const) {
    await expect(sessionFromPage(APP_CTX, id), `a ${what} page must not convert`).rejects.toThrow("not a card's specs");
  }
  await expect(sessionFromPage(APP_CTX, crypto.randomUUID())).rejects.toThrow("unknown page");
});

// The card anchors ABOVE the page, so without the specs_page_id arm of the query the
// page it is written on would read "no sessions yet".
test("getPage lists the card whose specs it holds", async () => {
  const { resolveClient, sessionFromPage } = await import("../core/sessions.ts");
  const { createPage, getPage } = await import("../core/pages.ts");

  const clientId = await resolveClient(APP_CTX, "Rollup Co");
  const storyId = await createPage(APP_CTX, { title: "Rollup story", kind: "story", parent_id: clientId });
  const planId = await createPage(APP_CTX, { title: "Visible plan", parent_id: storyId });
  const { id } = await sessionFromPage(APP_CTX, planId);

  const page = await getPage(APP_CTX, planId) as unknown as { sessions: { id: string }[] };
  expect(page.sessions.map((s) => s.id)).toStrictEqual([id]);
});
