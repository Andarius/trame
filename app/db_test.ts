// Isolated PGlite in a temp dir — set the env BEFORE importing any app module (config
// reads it at load), so app code is pulled in via dynamic import inside the test.
const tmp = await Deno.makeTempDir({ prefix: "trame-db-test-" });
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "db-test");
Deno.env.set("TRACKER_OUTBOX", `${tmp}/outbox.jsonl`);
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_PORT_FILE", `${tmp}/port.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL(".", import.meta.url).pathname);

import { assert, assertEquals } from "@std/assert";

// One PGlite for the file: these run in order and clean up after themselves.

// Regression: two offline nodes adding the same label must converge on one column after
// sync. uniqueStatusKey resolves the key against local rows only, so both nodes land on
// "review" — the id therefore has to fall out of the key, not be random per node.
Deno.test("status ids are derived from the key, so two nodes converge", async () => {
  const { createStatus, deleteStatus, getBoard, statusId } = await import("./db.ts");

  const id = await createStatus({ label: "Review", color: "#56b6c2" });
  assertEquals(id, await statusId("review"), "id is derived from the key, not random");

  // recreating a deleted key revives that row instead of colliding on the primary key
  await deleteStatus(id);
  const again = await createStatus({ label: "Review", color: "#7a9ee7" });
  assertEquals(again, id);
  const live = ((await getBoard()).statuses as { id: string; key: string; color: string }[])
    .filter((s) => s.key === "review");
  assertEquals(live.length, 1, "one column, not two");
  assertEquals(live[0].color, "#7a9ee7"); // last write wins

  await deleteStatus(again);
});

// Regression: the board columns are user-editable, but the session default, the importers
// and the tracking skills still emit fixed keys. Deleting 'active' must not strand every
// later card in a column that no longer exists.
Deno.test("a session whose status was deleted lands on a surviving column", async () => {
  const { deleteStatus, getBoard, upsertSession } = await import("./db.ts");

  const before = (await getBoard()).statuses as { id: string; key: string }[];
  assertEquals(before.map((s) => s.key), ["active", "paused", "blocked", "done"]);

  await deleteStatus(before.find((s) => s.key === "active")!.id);

  // no status given → the 'active' default, which no longer exists
  const id = await upsertSession({ title: "orphan-status card" });

  const after = await getBoard();
  const keys = (after.statuses as { key: string }[]).map((s) => s.key);
  assert(!keys.includes("active"), "active was deleted");
  const card = (after.sessions as { id: string; status: string }[]).find((s) => s.id === id)!;
  assert(keys.includes(card.status), `card landed on a live column, got "${card.status}"`);
  assertEquals(card.status, "paused"); // first surviving non-terminal
});
