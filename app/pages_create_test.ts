import { testTempDir } from "./test_tmp.ts";
const tmp = testTempDir("trame-page-create-test-");
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "page-create-test");
Deno.env.set("TRACKER_OUTBOX", `${tmp}/outbox.jsonl`);
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_PORT_FILE", `${tmp}/port.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL(".", import.meta.url).pathname);
const { APP_CTX } = await import("./ctx.ts");

import { assert, assertEquals } from "@std/assert";

Deno.test("createPage stores content in the initial insert", async () => {
  const { createPage, getPage } = await import("../core/pages.ts");
  const content = [
    { type: "heading", text: "Plan", id: crypto.randomUUID() },
    { type: "todo", text: "Ship it", done: false, id: crypto.randomUUID() },
  ];

  const id = await createPage(APP_CTX, {
    title: "Atomic page",
    kind: "page",
    content,
  });

  const page = await getPage(APP_CTX, id) as unknown as {
    title: string;
    content: unknown[];
  };
  assertEquals(page.title, "Atomic page");
  assertEquals(page.content, content);
});

// A page an agent creates from a repo must land under that repo's project, never in the
// Unfiled inbox — the session that owns the path decides, then a project named in the path.
Deno.test("createPage files an agent page under the repo's project", async () => {
  const { createPage, getPage } = await import("../core/pages.ts");
  const { resolveClient, upsertSession } = await import("../core/sessions.ts");

  const clientId = await resolveClient(APP_CTX, "Acme");
  await upsertSession(APP_CTX, {
    title: "acme api",
    status: "active",
    client_id: clientId,
    repo_path: "/repos/acme-api",
  });

  const bySession = await createPage(APP_CTX, {
    title: "Plan: session repo",
    repo_path: "/repos/acme-api/worktrees/feature",
  });
  assertEquals(
    ((await getPage(APP_CTX, bySession)) as unknown as { parent_id: string }).parent_id,
    clientId,
  );

  // no session owns this path, but a project title is one of its segments
  const byPath = await createPage(APP_CTX, {
    title: "Plan: path segment",
    repo_path: "/home/dev/Acme/other-repo",
  });
  assertEquals(
    ((await getPage(APP_CTX, byPath)) as unknown as { parent_id: string }).parent_id,
    clientId,
  );

  // a sibling directory sharing a prefix is not inside the repo
  const sibling = await createPage(APP_CTX, {
    title: "Plan: sibling",
    repo_path: "/repos/acme-api-docs",
  });
  const siblingParent =
    ((await getPage(APP_CTX, sibling)) as unknown as { parent_id: string }).parent_id;
  assert(
    siblingParent !== clientId,
    "prefix match must respect path boundaries",
  );
  assertEquals(
    ((await getPage(APP_CTX, siblingParent)) as unknown as { title: string }).title,
    "Side-projects",
  );

  // an explicit null parent still means a root page
  const root = await createPage(APP_CTX, {
    title: "Cross-project note",
    parent_id: null,
    repo_path: "/repos/acme-api",
  });
  assertEquals(
    ((await getPage(APP_CTX, root)) as unknown as { parent_id: null }).parent_id,
    null,
  );
});

// A goal's task line carries a chip for the session working on it: getPage must return
// the link anchored to that block, resolved to the session's title and status.
Deno.test("getPage resolves the session link anchored to a page item", async () => {
  const { createPage, getPage } = await import("../core/pages.ts");
  const { addSessionLink, upsertSession } = await import("../core/sessions.ts");

  const blockId = crypto.randomUUID();
  const pageId = await createPage(APP_CTX, {
    title: "70.3 goal",
    kind: "story",
    content: [{ type: "todo", text: "Restart the pool", done: false, id: blockId }],
  });
  const sessionId = await upsertSession(APP_CTX, {
    title: "pool block",
    status: "blocked",
    repo_path: "/repos/tri",
  });
  await addSessionLink(APP_CTX, sessionId, pageId, blockId, "Restart the pool");

  const page = await getPage(APP_CTX, pageId) as unknown as {
    links: { block_id: string; anchor: string; session_id: string; session_title: string; session_status: string }[];
  };
  assertEquals(page.links.length, 1);
  assertEquals(page.links[0].block_id, blockId);
  assertEquals(page.links[0].anchor, "Restart the pool");
  assertEquals(page.links[0].session_id, sessionId);
  assertEquals(page.links[0].session_title, "pool block");
  assertEquals(page.links[0].session_status, "blocked");
});
