import { testTempDir } from "./test_tmp.ts";
const tmp = testTempDir("trame-specs-page-test-");
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "specs-page-test");
Deno.env.set("TRACKER_OUTBOX", `${tmp}/outbox.jsonl`);
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_PORT_FILE", `${tmp}/port.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL(".", import.meta.url).pathname);
const { APP_CTX } = await import("./ctx.ts");

import { assert, assertEquals, assertRejects } from "@std/assert";

Deno.test("ensureSpecsPage: deterministic subpage of the story, idempotent, resurrects", async () => {
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
  assertEquals(pid, await specsPageId(id)); // deterministic — nodes converge
  assertEquals(await ensureSpecsPage(APP_CTX, id), pid); // idempotent
  const page = await getPage(APP_CTX, pid) as unknown as { title: string; parent_id: string | null; kind: string };
  assertEquals(page.parent_id, storyId);
  assertEquals(page.kind, "page");
  assert(page.title.includes("acme api — auth"));
  const linked = (await pg.query(`select specs_page_id from sessions where id=$1`, [id]))
    .rows[0] as { specs_page_id: string };
  assertEquals(linked.specs_page_id, pid);

  // deleting the spec page and asking again resurrects the SAME row
  await deletePage(APP_CTX, pid);
  assertEquals(await ensureSpecsPage(APP_CTX, id), pid);
  const revived = (await pg.query(`select deleted from pages where id=$1`, [pid]))
    .rows[0] as { deleted: boolean };
  assertEquals(revived.deleted, false);

  // no story → falls back to the project page; neither → detached
  const onProject = await upsertSession(APP_CTX, { title: "loose", client_id: clientId, repo_path: "/repos/a" });
  const onProjectPage = await getPage(APP_CTX, await ensureSpecsPage(APP_CTX, onProject)) as unknown as { parent_id: string | null };
  assertEquals(onProjectPage.parent_id, clientId);
  const detached = await upsertSession(APP_CTX, { title: "orphan", repo_path: "/repos/b" });
  const detachedPage = await getPage(APP_CTX, await ensureSpecsPage(APP_CTX, detached)) as unknown as { parent_id: string | null };
  assertEquals(detachedPage.parent_id, null);

  await assertRejects(() => ensureSpecsPage(APP_CTX, crypto.randomUUID()), Error, "unknown session");
});
