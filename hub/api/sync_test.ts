// The /sync core + auth + Hono app, run against real PGlite with the real shared
// schema — triggers, change_log and the LWW rule all exercised, no Postgres needed.
import { assert, assertEquals } from "@std/assert";
import { PGlite } from "@electric-sql/pglite";
import type { DB, Q } from "./db.ts";
import { ensureAuthSchema, mintToken } from "./auth.ts";
import { createApp } from "./app.ts";
import type { SyncResponse } from "../../protocol/types.ts";

const SEED_USER = "00000000-0000-4000-8000-000000000101";

function pgliteAdapter(pg: PGlite): DB {
  const q = (h: { query: PGlite["query"] }): Q => ({
    query: async (text, params) =>
      (await h.query(text, params as unknown[])).rows as Record<
        string,
        unknown
      >[],
  });
  return {
    ...q(pg),
    transaction: (fn) =>
      pg.transaction((tx) => fn(q(tx as never))) as Promise<never>,
  };
}

const pg = new PGlite();
await pg.waitReady;
await pg.exec(
  await Deno.readTextFile(new URL("../../db/schema.sql", import.meta.url)),
);
const db = pgliteAdapter(pg);
await ensureAuthSchema(db);
// claim the calling device for the seed user so the API stamps an actor
await pg.query(
  `insert into devices (node_id, user_id, origin) values ('api-test', $1, 'api-test')`,
  [SEED_USER],
);
const token = await mintToken(db, "api-test");
const app = createApp(db);

const sync = async (
  body: unknown,
  opts: { token?: string; protocol?: string } = {},
) =>
  await app.request("/sync", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-trame-protocol": opts.protocol ?? "1",
      authorization: `Bearer ${opts.token ?? token}`,
    },
    body: JSON.stringify(body),
  });

const page = (id: string, title: string, updatedAt: string) => ({
  mutationId: `test:pages:${id}:${updatedAt}`,
  entity: "pages",
  id,
  op: "upsert",
  value: {
    id,
    parent_id: null,
    kind: "page",
    title,
    icon: null,
    story: "",
    client_id: null,
    status: "open",
    content: [],
    color: null,
    sort_key: "a0",
    owner_id: SEED_USER,
    origin: "api-test",
    updated_at: updatedAt,
    deleted: false,
  },
});

const P1 = "00000000-0000-4000-8000-0000000000a1";

Deno.test("health is open, /sync requires a valid token", async () => {
  assertEquals((await app.request("/health")).status, 200);
  assertEquals(
    (await sync({ cursor: null, mutations: [] }, { token: "nope" })).status,
    401,
  );
});

Deno.test("protocol version mismatch is a clear 400", async () => {
  const res = await sync({ cursor: null, mutations: [] }, { protocol: "99" });
  assertEquals(res.status, 400);
  assert(((await res.json()).error as string).includes("protocol mismatch"));
});

Deno.test("null cursor returns a full snapshot with a resumable cursor", async () => {
  const res = await sync({ cursor: null, mutations: [] });
  assertEquals(res.status, 200);
  const body = await res.json() as SyncResponse;
  const entities = new Set(body.changes.map((c) => c.entity));
  assert(entities.has("statuses"), "seeded statuses in the snapshot");
  assert(entities.has("users"), "seeded user in the snapshot");
  assertEquals(body.hasMore, false);
  assert(Number.isFinite(body.nextCursor));
});

Deno.test("push applies LWW, stamps actor/source via the triggers, acks stale writes", async () => {
  const r1 = await sync({
    cursor: null,
    mutations: [page(P1, "v1", "2026-07-16T10:00:00Z")],
  });
  const b1 = await r1.json() as SyncResponse;
  assertEquals(b1.acknowledgements.length, 1);

  const logged = (await pg.query(
    `select actor, source from change_log where row_id=$1 order by rev desc limit 1`,
    [P1],
  )).rows[0] as { actor: string; source: string };
  assertEquals(logged.source, "api");
  assertEquals(logged.actor, SEED_USER);

  // an OLDER updated_at must lose the value but still be acknowledged
  const r2 = await sync({
    cursor: null,
    mutations: [page(P1, "stale", "2026-07-16T09:00:00Z")],
  });
  assertEquals(((await r2.json()) as SyncResponse).acknowledgements.length, 1);
  const row = (await pg.query(`select title from pages where id=$1`, [P1]))
    .rows[0] as { title: string };
  assertEquals(row.title, "v1");
});

Deno.test("a bad mutation is rejected alone — the rest of the batch lands", async () => {
  const bad = {
    mutationId: "test:bad",
    entity: "session_events",
    id: "00000000-0000-4000-8000-0000000000b1",
    op: "upsert",
    value: {
      id: "00000000-0000-4000-8000-0000000000b1",
      session_id: "00000000-0000-4000-8000-0000000000ff", // FK violation: no such session
      at: "2026-07-16T10:00:00Z",
      summary: "x",
      kind: "log",
      origin: "api-test",
      updated_at: "2026-07-16T10:00:00Z",
      deleted: false,
    },
  };
  const good = page(
    "00000000-0000-4000-8000-0000000000a2",
    "survives",
    "2026-07-16T10:00:00Z",
  );
  const res = await sync({ cursor: null, mutations: [bad, good] });
  const body = await res.json() as SyncResponse;
  assertEquals(body.rejectedMutations.length, 1);
  assertEquals(body.rejectedMutations[0].mutationId, "test:bad");
  assertEquals(body.acknowledgements, [good.mutationId]);
  const row = (await pg.query(`select title from pages where id=$1`, [good.id]))
    .rows[0] as { title: string };
  assertEquals(row.title, "survives");
});

Deno.test("incremental pull returns coalesced changes and hard-delete tombstones", async () => {
  const cursor = ((await (await sync({ cursor: null, mutations: [] }))
    .json()) as SyncResponse).nextCursor;

  // another writer (legacy direct SQL): two edits to one row → one coalesced change
  await pg.query(
    `insert into pages (id, title, origin, owner_id) values ('00000000-0000-4000-8000-0000000000a3','ext', 'other', $1)`,
    [SEED_USER],
  );
  await pg.query(
    `update pages set title='ext2', updated_at=now() where id='00000000-0000-4000-8000-0000000000a3'`,
  );
  // and a hard delete of a previously synced row
  await pg.query(`delete from pages where id=$1`, [P1]);

  const res = await sync({ cursor, mutations: [] });
  const body = await res.json() as SyncResponse;
  const forA3 = body.changes.filter((c) =>
    c.id === "00000000-0000-4000-8000-0000000000a3"
  );
  assertEquals(forA3.length, 1, "two writes coalesce to one change");
  assertEquals((forA3[0].value as { title: string }).title, "ext2");
  const tomb = body.changes.find((c) => c.id === P1);
  assertEquals(tomb?.value, null, "hard delete arrives as a tombstone");
  assert(body.nextCursor > cursor);

  // caught up: same cursor again after consuming → empty
  const idle = await sync({ cursor: body.nextCursor, mutations: [] });
  assertEquals(((await idle.json()) as SyncResponse).changes.length, 0);
});
