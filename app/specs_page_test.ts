const tmp = await Deno.makeTempDir({ prefix: "trame-specs-page-test-" });
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "specs-page-test");
Deno.env.set("TRACKER_OUTBOX", `${tmp}/outbox.jsonl`);
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_PORT_FILE", `${tmp}/port.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL(".", import.meta.url).pathname);

import { assert, assertEquals, assertRejects } from "@std/assert";

Deno.test("ensureSpecsPage: deterministic subpage of the story, idempotent, resurrects", async () => {
  const { db, ensureSpecsPage, resolveClient, specsPageId, upsertSession } = await import("./db.ts");
  const { createPage, deletePage, getPage } = await import("./pages.ts");
  const pg = await db();

  const clientId = await resolveClient("Acme");
  const storyId = await createPage({ title: "Ship it", kind: "story", parent_id: clientId });
  const id = await upsertSession({
    title: "acme api — auth",
    client_id: clientId,
    page_id: storyId,
    repo_path: "/repos/acme-api",
  });

  const pid = await ensureSpecsPage(id);
  assertEquals(pid, await specsPageId(id)); // deterministic — nodes converge
  assertEquals(await ensureSpecsPage(id), pid); // idempotent
  const page = await getPage(pid) as unknown as { title: string; parent_id: string | null; kind: string };
  assertEquals(page.parent_id, storyId);
  assertEquals(page.kind, "page");
  assert(page.title.includes("acme api — auth"));
  const linked = (await pg.query(`select specs_page_id from sessions where id=$1`, [id]))
    .rows[0] as { specs_page_id: string };
  assertEquals(linked.specs_page_id, pid);

  // deleting the spec page and asking again resurrects the SAME row
  await deletePage(pid);
  assertEquals(await ensureSpecsPage(id), pid);
  const revived = (await pg.query(`select deleted from pages where id=$1`, [pid]))
    .rows[0] as { deleted: boolean };
  assertEquals(revived.deleted, false);

  // no story → falls back to the project page; neither → detached
  const onProject = await upsertSession({ title: "loose", client_id: clientId, repo_path: "/repos/a" });
  const onProjectPage = await getPage(await ensureSpecsPage(onProject)) as unknown as { parent_id: string | null };
  assertEquals(onProjectPage.parent_id, clientId);
  const detached = await upsertSession({ title: "orphan", repo_path: "/repos/b" });
  const detachedPage = await getPage(await ensureSpecsPage(detached)) as unknown as { parent_id: string | null };
  assertEquals(detachedPage.parent_id, null);

  await assertRejects(() => ensureSpecsPage(crypto.randomUUID()), Error, "unknown session");
});
