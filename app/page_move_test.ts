const tmp = await Deno.makeTempDir({ prefix: "trame-page-move-test-" });
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "page-move-test");
Deno.env.set("TRACKER_OUTBOX", `${tmp}/outbox.jsonl`);
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_PORT_FILE", `${tmp}/port.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL(".", import.meta.url).pathname);

import { assertEquals } from "@std/assert";

Deno.test("movePage re-homes a story's client_id to the target project", async () => {
  const { createPage, getPage, movePage } = await import("./pages.ts");
  const a = await createPage({ title: "Proj A", kind: "project" });
  const b = await createPage({ title: "Proj B", kind: "project" });
  const s = await createPage({
    title: "Story",
    kind: "story",
    parent_id: a,
    client_id: a,
  });

  await movePage(s, { parent_id: b });
  let page = await getPage(s) as unknown as {
    parent_id: string | null;
    client_id: string | null;
  };
  assertEquals(page.parent_id, b);
  assertEquals(page.client_id, b);

  // nested target: the story lands under a sub-page but the chip points at the
  // project owning that subtree
  const sub = await createPage({ title: "Sub", kind: "page", parent_id: a });
  await movePage(s, { parent_id: sub });
  page = await getPage(s) as unknown as {
    parent_id: string;
    client_id: string | null;
  };
  assertEquals(page.parent_id, sub);
  assertEquals(page.client_id, a);

  // unfiling clears the chip
  await movePage(s, { parent_id: null });
  page = await getPage(s) as unknown as {
    parent_id: string | null;
    client_id: string | null;
  };
  assertEquals(page.parent_id, null);
  assertEquals(page.client_id, null);
});

Deno.test("movePage leaves a plain page's client_id alone", async () => {
  const { createPage, getPage, movePage } = await import("./pages.ts");
  const a = await createPage({ title: "Proj C", kind: "project" });
  const b = await createPage({ title: "Proj D", kind: "project" });
  const p = await createPage({
    title: "Doc",
    kind: "page",
    parent_id: a,
    client_id: a,
  });
  await movePage(p, { parent_id: b });
  const page = await getPage(p) as unknown as {
    parent_id: string;
    client_id: string | null;
  };
  assertEquals(page.parent_id, b);
  assertEquals(page.client_id, a);
});
