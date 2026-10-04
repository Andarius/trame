import { testTempDir } from "./test_tmp.ts";
// config reads the env at load — set it before importing app modules
const tmp = testTempDir("trame-sync-apply-");
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "apply-test");
Deno.env.set("TRACKER_OUTBOX", `${tmp}/outbox.jsonl`);
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_PORT_FILE", `${tmp}/port.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL(".", import.meta.url).pathname);

import { assertEquals } from "@std/assert";
const { APP_CTX } = await import("./ctx.ts");
const { db } = await import("./db.ts");
const { addEvent, upsertSession } = await import("../core/sessions.ts");
const { applyChanges } = await import("./sync-api.ts");
type Change = Parameters<typeof applyChanges>[1][number];

// a real session + event, captured as pulled changes, then removed locally
async function pulledPair(): Promise<{ session: Change; event: Change }> {
  const pg = await db();
  const id = await upsertSession(APP_CTX, { title: "fk order" });
  await addEvent(APP_CTX, id, "first log");
  const s = (await pg.query(`select * from sessions where id=$1`, [id]))
    .rows[0] as Record<string, unknown>;
  const e =
    (await pg.query(`select * from session_events where session_id=$1`, [id]))
      .rows[0] as Record<string, unknown>;
  await pg.query(`delete from session_events where session_id=$1`, [id]);
  await pg.query(`delete from sessions where id=$1`, [id]);
  return {
    session: { rev: 1, entity: "sessions", id, value: s },
    event: { rev: 1, entity: "session_events", id: String(e.id), value: e },
  } as { session: Change; event: Change };
}

// pages as the hub sends them; the child (event) may come before its parent
for (
  const [id, pages, left] of [
    [
      "child before parent in one window",
      (p: Awaited<ReturnType<typeof pulledPair>>) => [[p.event, p.session]],
      0,
    ],
    [
      "parent in a later page",
      (p: Awaited<ReturnType<typeof pulledPair>>) => [[p.event], [p.session]],
      0,
    ],
    [
      "parent never arrives",
      (p: Awaited<ReturnType<typeof pulledPair>>) => [[p.event]],
      1,
    ],
  ] as const
) {
  Deno.test(`pull apply: ${id}`, async () => {
    const pair = await pulledPair();
    const pg = await db();
    const deferred: Change[] = [];
    for (const page of pages(pair)) await applyChanges(pg, page, deferred);
    assertEquals(deferred.length, left);
    const n = (await pg.query(
      `select count(*)::int as n from session_events where id=$1`,
      [pair.event.id],
    ))
      .rows[0] as { n: number };
    assertEquals(n.n, 1 - left);
  });
}
