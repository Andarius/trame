const tmp = await Deno.makeTempDir({ prefix: "trame-page-create-test-" });
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "page-create-test");
Deno.env.set("TRACKER_OUTBOX", `${tmp}/outbox.jsonl`);
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_PORT_FILE", `${tmp}/port.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL(".", import.meta.url).pathname);

import { assert, assertEquals } from "@std/assert";

Deno.test("createPage stores content in the initial insert", async () => {
  const { createPage, getPage } = await import("./pages.ts");
  const content = [
    { type: "heading", text: "Plan", id: crypto.randomUUID() },
    { type: "todo", text: "Ship it", done: false, id: crypto.randomUUID() },
  ];

  const id = await createPage({
    title: "Atomic page",
    kind: "page",
    content,
  });

  const page = await getPage(id) as unknown as {
    title: string;
    content: unknown[];
  };
  assertEquals(page.title, "Atomic page");
  assertEquals(page.content, content);
});

// A page an agent creates from a repo must land under that repo's project, never in the
// Unfiled inbox — the session that owns the path decides, then a project named in the path.
Deno.test("createPage files an agent page under the repo's project", async () => {
  const { createPage, getPage } = await import("./pages.ts");
  const { resolveClient, upsertSession } = await import("./db.ts");

  const clientId = await resolveClient("Acme");
  await upsertSession({
    title: "acme api",
    status: "active",
    client_id: clientId,
    repo_path: "/repos/acme-api",
  });

  const bySession = await createPage({
    title: "Plan: session repo",
    repo_path: "/repos/acme-api/worktrees/feature",
  });
  assertEquals(
    ((await getPage(bySession)) as unknown as { parent_id: string }).parent_id,
    clientId,
  );

  // no session owns this path, but a project title is one of its segments
  const byPath = await createPage({
    title: "Plan: path segment",
    repo_path: "/home/dev/Acme/other-repo",
  });
  assertEquals(
    ((await getPage(byPath)) as unknown as { parent_id: string }).parent_id,
    clientId,
  );

  // a sibling directory sharing a prefix is not inside the repo
  const sibling = await createPage({
    title: "Plan: sibling",
    repo_path: "/repos/acme-api-docs",
  });
  const siblingParent =
    ((await getPage(sibling)) as unknown as { parent_id: string }).parent_id;
  assert(
    siblingParent !== clientId,
    "prefix match must respect path boundaries",
  );
  assertEquals(
    ((await getPage(siblingParent)) as unknown as { title: string }).title,
    "Side-projects",
  );

  // an explicit null parent still means a root page
  const root = await createPage({
    title: "Cross-project note",
    parent_id: null,
    repo_path: "/repos/acme-api",
  });
  assertEquals(
    ((await getPage(root)) as unknown as { parent_id: null }).parent_id,
    null,
  );
});
