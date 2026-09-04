Deno.env.set(
  "TRACKER_CLIENTS",
  '{"Obitrain":"Obitrain","Work":{"project":"Soren","tags":["Infra"]}}',
);
const tmp = await Deno.makeTempDir({ prefix: "trame-client-map-test-" });
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "client-map-test");
Deno.env.set("TRACKER_OUTBOX", `${tmp}/outbox.jsonl`);
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_PORT_FILE", `${tmp}/port.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL(".", import.meta.url).pathname);

import { assertEquals } from "@std/assert";

const { clientFor } = await import("./claude-import.ts");

Deno.test("clientFor maps path segments, aliases included", () => {
  assertEquals(clientFor("/home/me/Projects/Obitrain/obiapp"), "Obitrain");
  assertEquals(clientFor("/home/me/Projects/Work/sre-config"), "Soren");
  assertEquals(clientFor("/home/me/Projects/trame"), "Side-projects");
});

Deno.test("clientFor matches dash-encoded scratchpad worktrees", () => {
  assertEquals(
    clientFor("/tmp/claude-1000/-home-me-Projects-Work-sops/abc/scratchpad/wt-x"),
    "Soren",
  );
  // the dashed rule stays scoped to /tmp/claude-…: a real path with a dashed
  // name must not alias ("/data/my-Work-notes" is not Soren's)
  assertEquals(clientFor("/data/my-Work-notes"), "Side-projects");
});

const { db, upsertSession } = await import("./db.ts");

Deno.test("a story minted for a mapped repo carries the default tags", async () => {
  const id = await upsertSession({
    title: "sre-config — probe",
    repo_path: "/home/me/Projects/Work/sre-config",
    branch: "main",
    client: "Soren",
    story: "Blackbox probes",
  });
  const pg = await db();
  const { page_id } = (await pg.query(`select page_id from sessions where id=$1`, [id]))
    .rows[0] as { page_id: string };
  const page = (await pg.query(`select tags from pages where id=$1`, [page_id]))
    .rows[0] as { tags: string[] };
  assertEquals(page.tags, ["infra"]);
  // vocabulary row exists, labelled as written
  const tag = (await pg.query(`select label from tags where key='infra' and not deleted`))
    .rows[0] as { label: string };
  assertEquals(tag.label, "Infra");
  // re-attaching by the same story name must not re-stamp or duplicate
  const again = await upsertSession({
    title: "sre-config — probe 2",
    repo_path: "/home/me/Projects/Work/sre-config",
    branch: "other",
    client: "Soren",
    story: "blackbox probes",
  });
  const p2 = (await pg.query(`select page_id from sessions where id=$1`, [again]))
    .rows[0] as { page_id: string };
  assertEquals(p2.page_id, page_id);
});
