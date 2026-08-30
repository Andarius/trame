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

Deno.test("backfillSpecsPages converts legacy specs text once, idempotently", async () => {
  const { backfillSpecsPages, db, specsPageId, upsertSession } = await import("./db.ts");
  const { getPage } = await import("./pages.ts");
  const pg = await db();

  const id = await upsertSession({ title: "legacy", repo_path: "/repos/legacy" });
  // simulate a pre-protocol-4 row: specs text, no spec page yet
  await pg.query(`update sessions set specs=$2, specs_page_id=null where id=$1`, [
    id,
    "## Goal\nToken exchange\n\n- [ ] wire the callback",
  ]);

  await backfillSpecsPages(pg);
  const pid = await specsPageId(id);
  const page = await getPage(pid) as unknown as { content: { type: string; text?: string; id: string }[] };
  assertEquals(page.content.map((b) => b.type), ["heading", "text", "todo"]);
  assertEquals(page.content[2].text, "wire the callback");

  // running again must not duplicate or rewrite (guard: specs_page_id set)
  const before = JSON.stringify(page.content);
  await backfillSpecsPages(pg);
  const again = await getPage(pid) as unknown as { content: unknown[] };
  assertEquals(JSON.stringify(again.content), before);
  // block ids are deterministic — a second node would produce identical rows
  assertEquals(new Set(page.content.map((b) => b.id)).size, page.content.length);
});
