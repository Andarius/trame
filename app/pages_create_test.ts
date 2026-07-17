const tmp = await Deno.makeTempDir({ prefix: "trame-page-create-test-" });
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "page-create-test");
Deno.env.set("TRACKER_OUTBOX", `${tmp}/outbox.jsonl`);
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_PORT_FILE", `${tmp}/port.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL(".", import.meta.url).pathname);

import { assertEquals } from "@std/assert";

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
