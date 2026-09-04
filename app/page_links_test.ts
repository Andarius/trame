const tmp = await Deno.makeTempDir({ prefix: "trame-page-links-test-" });
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "page-links-test");
Deno.env.set("TRACKER_OUTBOX", `${tmp}/outbox.jsonl`);
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_PORT_FILE", `${tmp}/port.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL(".", import.meta.url).pathname);

import { assert, assertEquals } from "@std/assert";
import { entityByName } from "../protocol/entities.ts";

Deno.test("share links: create keeps the raw token locally, revoke removes it", async () => {
  const { createLink, createPage, listLinks, revokeLink } = await import(
    "./pages.ts"
  );
  const pageId = await createPage({ title: "Shared plan" });

  const { id, token } = await createLink(pageId);
  assert(token.length > 20, "token is a real capability string");

  // the app can re-show the URL: the raw token comes back from the list
  const links = await listLinks(pageId);
  assertEquals(links.map((l) => ({ id: l.id, token: l.token })), [
    { id, token },
  ]);

  // only the hash syncs — the raw token is not a wire column
  assert(
    !(entityByName.get("page_links")!.cols as readonly string[])
      .includes("token"),
    "raw token must never sync to the hub",
  );

  // revoke soft-deletes: the link disappears from the list (regression for the
  // /api/links/:id/delete route collision that made revoke a silent no-op)
  await revokeLink(id);
  assertEquals(await listLinks(pageId), []);
});
