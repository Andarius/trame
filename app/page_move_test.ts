import { expect, test } from "bun:test";
import { testTempDir } from "./test_tmp.ts";
const tmp = testTempDir("trame-page-move-test-");
process.env.TRACKER_DATA_DIR = `${tmp}/pglite`;
process.env.TRACKER_NODE_ID = "page-move-test";
process.env.TRACKER_OUTBOX = `${tmp}/outbox.jsonl`;
process.env.TRACKER_SETTINGS_FILE = `${tmp}/settings.json`;
process.env.TRACKER_PORT_FILE = `${tmp}/port.json`;
process.env.TRACKER_APP_ROOT = new URL(".", import.meta.url).pathname;
const { APP_CTX } = await import("./ctx.ts");


test("movePage re-homes a story's client_id to the target project", async () => {
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
  expect(page.parent_id).toStrictEqual(b);
  expect(page.client_id).toStrictEqual(b);

  // nested target: the story lands under a sub-page but the chip points at the
  // project owning that subtree
  const sub = await createPage(APP_CTX, { title: "Sub", kind: "page", parent_id: a });
  await movePage(APP_CTX, s, { parent_id: sub });
  page = await getPage(APP_CTX, s) as unknown as {
    parent_id: string;
    client_id: string | null;
  };
  expect(page.parent_id).toStrictEqual(sub);
  expect(page.client_id).toStrictEqual(a);

  // unfiling clears the chip
  await movePage(APP_CTX, s, { parent_id: null });
  page = await getPage(APP_CTX, s) as unknown as {
    parent_id: string | null;
    client_id: string | null;
  };
  expect(page.parent_id).toStrictEqual(null);
  expect(page.client_id).toStrictEqual(null);
});

test("movePage leaves a plain page's client_id alone", async () => {
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
  expect(page.parent_id).toStrictEqual(b);
  expect(page.client_id).toStrictEqual(a);
});

// a client sending `?page=null` must get a 404, not a uuid cast error
test("getPage on a non-uuid id is not found", async () => {
  const { getPage } = await import("../core/pages.ts");
  expect(await getPage(APP_CTX, "null")).toStrictEqual(null);
});
