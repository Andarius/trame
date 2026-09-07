const tmp = await Deno.makeTempDir({ prefix: "trame-cockpit-store-test-" });
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "cockpit-store-test");
Deno.env.set("TRACKER_OUTBOX", `${tmp}/outbox.jsonl`);
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_PORT_FILE", `${tmp}/port.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL("../..", import.meta.url).pathname);

import { assertEquals } from "@std/assert";

// A story filed under another story (a mirrored ticket, say) belongs to the
// project above them both — the filer must see it, and file it under that
// project's mapping, instead of silently ignoring anything not one level deep.
Deno.test("a story nested under a story is pending for the project above both", async () => {
  const { createPage } = await import("../../pages.ts");
  const { loadPendingPages, mappedProjectOf } = await import(
    "./mirror-store.ts"
  );
  const project = await createPage({ title: "Soren", kind: "project" });
  const ticket = await createPage({
    title: "GEN-1 — Infra",
    kind: "story",
    parent_id: project,
  });
  const nested = await createPage({
    title: "Tooling hardening",
    kind: "story",
    parent_id: ticket,
    tags: ["cockpit-devops"],
  });
  const elsewhere = await createPage({
    title: "Loose story",
    kind: "story",
    tags: ["cockpit-devops"],
  });
  const mappings = [
    { pageId: project, tagKey: "cockpit-devops", tagLabel: "cockpit:devops" },
  ];

  const pending = await loadPendingPages(mappings);
  assertEquals(pending.map((p) => p.pageId), [nested]);
  assertEquals(pending[0].parentTitle, "GEN-1 — Infra");

  assertEquals(await mappedProjectOf(nested, [project]), project);
  assertEquals(await mappedProjectOf(ticket, [project]), project);
  assertEquals(await mappedProjectOf(elsewhere, [project]), null);
});
