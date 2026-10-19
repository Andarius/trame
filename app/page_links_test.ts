import { expect, test } from "bun:test";
import { testTempDir } from "./test_tmp.ts";
const tmp = testTempDir("trame-page-links-test-");
process.env.TRACKER_DATA_DIR = `${tmp}/pglite`;
process.env.TRACKER_NODE_ID = "page-links-test";
process.env.TRACKER_OUTBOX = `${tmp}/outbox.jsonl`;
process.env.TRACKER_SETTINGS_FILE = `${tmp}/settings.json`;
process.env.TRACKER_PORT_FILE = `${tmp}/port.json`;
process.env.TRACKER_APP_ROOT = new URL(".", import.meta.url).pathname;
const { APP_CTX } = await import("./ctx.ts");

import { entityByName } from "../protocol/entities.ts";

test("share links: create keeps the raw token locally, revoke removes it", async () => {
  const { createLink, createPage, listLinks, revokeLink } = await import(
    "../core/pages.ts"
  );
  const pageId = await createPage(APP_CTX, { title: "Shared plan" });

  const { id, token } = await createLink(APP_CTX, pageId);
  expect(token.length > 20, "token is a real capability string").toBeTruthy();

  // the app can re-show the URL: the raw token comes back from the list
  const links = await listLinks(APP_CTX, pageId);
  expect(links.map((l) => ({ id: l.id, token: l.token }))).toStrictEqual([
    { id, token },
  ]);

  // only the hash syncs — the raw token is not a wire column
  expect(!(entityByName.get("page_links")!.cols as readonly string[])
      .includes("token"), "raw token must never sync to the hub").toBeTruthy();

  // revoke soft-deletes: the link disappears from the list (regression for the
  // /api/links/:id/delete route collision that made revoke a silent no-op)
  await revokeLink(APP_CTX, id);
  expect(await listLinks(APP_CTX, pageId)).toStrictEqual([]);
});
