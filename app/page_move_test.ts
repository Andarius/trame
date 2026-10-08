import { testTempDir } from "./test_tmp.ts";
const tmp = testTempDir("trame-page-move-test-");
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "page-move-test");
Deno.env.set("TRACKER_OUTBOX", `${tmp}/outbox.jsonl`);
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_PORT_FILE", `${tmp}/port.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL(".", import.meta.url).pathname);
const { APP_CTX } = await import("./ctx.ts");

import { assertEquals } from "@std/assert";

Deno.test("movePage re-homes a story's client_id to the target project", async () => {
  const { createPage, getPage, movePage } = await import("../core/pages.ts");
  const a = await createPage(APP_CTX, { title: "Proj A", kind: "project" });
  const b = await createPage(APP_CTX, { title: "Proj B", kind: "project" });
  const s = await createPage(APP_CTX, {
    title: "Story",
    kind: "story",
    parent_id: a,
    client_id: a,
  });

  await movePage(APP_CTX, s, { parent_id: b });
  let page = await getPage(APP_CTX, s) as unknown as {
    parent_id: string | null;
    client_id: string | null;
  };
  assertEquals(page.parent_id, b);
  assertEquals(page.client_id, b);

  // nested target: the story lands under a sub-page but the chip points at the
  // project owning that subtree
  const sub = await createPage(APP_CTX, { title: "Sub", kind: "page", parent_id: a });
  await movePage(APP_CTX, s, { parent_id: sub });
  page = await getPage(APP_CTX, s) as unknown as {
    parent_id: string;
    client_id: string | null;
  };
  assertEquals(page.parent_id, sub);
  assertEquals(page.client_id, a);

  // unfiling clears the chip
  await movePage(APP_CTX, s, { parent_id: null });
  page = await getPage(APP_CTX, s) as unknown as {
    parent_id: string | null;
    client_id: string | null;
  };
  assertEquals(page.parent_id, null);
  assertEquals(page.client_id, null);
});

Deno.test("movePage leaves a plain page's client_id alone", async () => {
  const { createPage, getPage, movePage } = await import("../core/pages.ts");
  const a = await createPage(APP_CTX, { title: "Proj C", kind: "project" });
  const b = await createPage(APP_CTX, { title: "Proj D", kind: "project" });
  const p = await createPage(APP_CTX, {
    title: "Doc",
    kind: "page",
    parent_id: a,
    client_id: a,
  });
  await movePage(APP_CTX, p, { parent_id: b });
  const page = await getPage(APP_CTX, p) as unknown as {
    parent_id: string;
    client_id: string | null;
  };
  assertEquals(page.parent_id, b);
  assertEquals(page.client_id, a);
});

// a client sending `?page=null` must get a 404, not a uuid cast error
Deno.test("getPage on a non-uuid id is not found", async () => {
  const { getPage } = await import("../core/pages.ts");
  assertEquals(await getPage(APP_CTX, "null"), null);
});
