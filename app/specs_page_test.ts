import { expect, test } from "bun:test";
import { testTempDir } from "./test_tmp.ts";
const tmp = testTempDir("trame-specs-page-test-");
process.env.TRACKER_DATA_DIR = `${tmp}/pglite`;
process.env.TRACKER_NODE_ID = "specs-page-test";
process.env.TRACKER_OUTBOX = `${tmp}/outbox.jsonl`;
process.env.TRACKER_SETTINGS_FILE = `${tmp}/settings.json`;
process.env.TRACKER_PORT_FILE = `${tmp}/port.json`;
process.env.TRACKER_APP_ROOT = new URL(".", import.meta.url).pathname;
const { APP_CTX } = await import("./ctx.ts");


test("ensureSpecsPage: deterministic subpage of the story, idempotent, resurrects", async () => {
  const { db } = await import("./db.ts");
const { ensureSpecsPage, resolveClient, specsPageId, upsertSession } = await import("../core/sessions.ts");
  const { createPage, deletePage, getPage } = await import("../core/pages.ts");
  const pg = await db();

  const clientId = await resolveClient(APP_CTX, "Acme");
  const storyId = await createPage(APP_CTX, { title: "Ship it", kind: "story", parent_id: clientId });
  const id = await upsertSession(APP_CTX, {
    title: "acme api — auth",
    client_id: clientId,
    page_id: storyId,
    repo_path: "/repos/acme-api",
  });

  const pid = await ensureSpecsPage(APP_CTX, id);
  expect(pid).toStrictEqual(await specsPageId(id)); // deterministic — nodes converge
  expect(await ensureSpecsPage(APP_CTX, id)).toStrictEqual(pid); // idempotent
  const page = await getPage(APP_CTX, pid) as unknown as { title: string; parent_id: string | null; kind: string };
  expect(page.parent_id).toStrictEqual(storyId);
  expect(page.kind).toStrictEqual("page");
  expect(page.title.includes("acme api — auth")).toBeTruthy();
  const linked = (await pg.query(`select specs_page_id from sessions where id=$1`, [id]))
    .rows[0] as { specs_page_id: string };
  expect(linked.specs_page_id).toStrictEqual(pid);

  // deleting the spec page and asking again resurrects the SAME row
  await deletePage(APP_CTX, pid);
  expect(await ensureSpecsPage(APP_CTX, id)).toStrictEqual(pid);
  const revived = (await pg.query(`select deleted from pages where id=$1`, [pid]))
    .rows[0] as { deleted: boolean };
  expect(revived.deleted).toStrictEqual(false);

  // no story → falls back to the project page; neither → detached
  const onProject = await upsertSession(APP_CTX, { title: "loose", client_id: clientId, repo_path: "/repos/a" });
  const onProjectPage = await getPage(APP_CTX, await ensureSpecsPage(APP_CTX, onProject)) as unknown as { parent_id: string | null };
  expect(onProjectPage.parent_id).toStrictEqual(clientId);
  const detached = await upsertSession(APP_CTX, { title: "orphan", repo_path: "/repos/b" });
  const detachedPage = await getPage(APP_CTX, await ensureSpecsPage(APP_CTX, detached)) as unknown as { parent_id: string | null };
  expect(detachedPage.parent_id).toStrictEqual(null);

  await expect(ensureSpecsPage(APP_CTX, crypto.randomUUID())).rejects.toThrow("unknown session");
});
