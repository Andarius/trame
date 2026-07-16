import { expect, test } from "@playwright/test";

// Inline page comments: block-anchored notes with author stamped server-side from
// settings, resolve/unresolve, edit, delete, and orphan tolerance (a comment whose
// block text was removed still lists). Driven over /api/comments + /api/settings.
test.describe.configure({ mode: "serial" });

type Comment = { id: string; block_id: string; body: string; author: string; resolved: boolean; anchor: string };
const list = async (request: import("@playwright/test").APIRequestContext, pageId: string) =>
  (await (await request.get(`/api/comments?page=${pageId}`)).json()) as Comment[];

test("missing page param returns an empty list", async ({ request }) => {
  expect(await (await request.get("/api/comments")).json()).toEqual([]);
});

test("comment is stamped with the settings author and round-trips resolve/edit/delete", async ({ request }) => {
  await request.post("/api/settings", { data: { authorName: "E2E Reviewer" } });
  const { id: pageId } = await (await request.post("/api/pages", {
    data: { title: "Comments page", kind: "page" },
  })).json();

  const { id } = await (await request.post("/api/comments", {
    data: { page_id: pageId, block_id: "blk-1", anchor: "the first paragraph", body: "needs a source" },
  })).json();

  let [c] = await list(request, pageId);
  expect(c).toMatchObject({ id, block_id: "blk-1", body: "needs a source", author: "E2E Reviewer", resolved: false });

  // resolve, then edit the body
  await request.post(`/api/comments/${id}`, { data: { resolved: true } });
  await request.post(`/api/comments/${id}`, { data: { body: "source added ✓" } });
  [c] = await list(request, pageId);
  expect(c).toMatchObject({ resolved: true, body: "source added ✓" });

  // delete removes it from the list
  await request.post(`/api/comments/${id}/delete`);
  expect(await list(request, pageId)).toEqual([]);
});

test("a comment whose block was never in the page still lists (orphan tolerance)", async ({ request }) => {
  const { id: pageId } = await (await request.post("/api/pages", {
    data: { title: "Orphan comments page", kind: "page" },
  })).json();
  // anchor snapshots the (now-gone) text so the note is still meaningful
  await request.post("/api/comments", {
    data: { page_id: pageId, block_id: "removed-block", anchor: "text that got deleted", body: "was this on purpose?" },
  });
  const [c] = await list(request, pageId);
  expect(c).toMatchObject({ block_id: "removed-block", anchor: "text that got deleted" });
});
