// The /sync core + auth + Hono app, run against real PGlite with the real shared
// schema — triggers, change_log and the LWW rule all exercised, no Postgres needed.
import { afterAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import type { DB, Q } from "./db.ts";
import { ensureAuthSchema, mintToken } from "./auth.ts";
import { createApp } from "./app.ts";
import type { SyncResponse } from "../../protocol/types.ts";
import { PROTOCOL_VERSION } from "../../protocol/entities.ts";

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
  await Bun.file(new URL("../../db/schema.sql", import.meta.url)).text(),
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
      "x-trame-protocol": opts.protocol ?? String(PROTOCOL_VERSION),
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
    brief: "",
    tags: [],
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

test("health is open, /sync requires a valid token", async () => {
  expect((await app.request("/health")).status).toStrictEqual(200);
  expect((await sync({ cursor: null, mutations: [] }, { token: "nope" })).status).toStrictEqual(401);
});

test("protocol version mismatch is a clear 400", async () => {
  const res = await sync({ cursor: null, mutations: [] }, { protocol: "99" });
  expect(res.status).toStrictEqual(400);
  expect(((await res.json()).error as string).includes("protocol mismatch")).toBeTruthy();
});

test("null cursor returns a full snapshot with a resumable cursor", async () => {
  const res = await sync({ cursor: null, mutations: [] });
  expect(res.status).toStrictEqual(200);
  const body = await res.json() as SyncResponse;
  const entities = new Set(body.changes.map((c) => c.entity));
  expect(entities.has("statuses")).toBeTruthy();
  expect(entities.has("users")).toBeTruthy();
  expect(body.hasMore).toStrictEqual(false);
  expect(Number.isFinite(body.nextCursor)).toBeTruthy();
});

test("push applies LWW, stamps actor/source via the triggers, acks stale writes", async () => {
  const r1 = await sync({
    cursor: null,
    mutations: [page(P1, "v1", "2026-07-16T10:00:00Z")],
  });
  const b1 = await r1.json() as SyncResponse;
  expect(b1.acknowledgements.length).toStrictEqual(1);

  const logged = (await pg.query(
    `select actor, source from change_log where row_id=$1 order by rev desc limit 1`,
    [P1],
  )).rows[0] as { actor: string; source: string };
  expect(logged.source).toStrictEqual("api");
  expect(logged.actor).toStrictEqual(SEED_USER);

  // an OLDER updated_at must lose the value but still be acknowledged
  const r2 = await sync({
    cursor: null,
    mutations: [page(P1, "stale", "2026-07-16T09:00:00Z")],
  });
  expect(((await r2.json()) as SyncResponse).acknowledgements.length).toStrictEqual(1);
  const row = (await pg.query(`select title from pages where id=$1`, [P1]))
    .rows[0] as { title: string };
  expect(row.title).toStrictEqual("v1");
});

test("a bad mutation is rejected alone — the rest of the batch lands", async () => {
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
  expect(body.rejectedMutations.length).toStrictEqual(1);
  expect(body.rejectedMutations[0].mutationId).toStrictEqual("test:bad");
  expect(body.acknowledgements).toStrictEqual([good.mutationId]);
  const row = (await pg.query(`select title from pages where id=$1`, [good.id]))
    .rows[0] as { title: string };
  expect(row.title).toStrictEqual("survives");
});

test("incremental pull returns coalesced changes and hard-delete tombstones", async () => {
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
  expect(forA3.length).toStrictEqual(1);
  expect((forA3[0].value as { title: string }).title).toStrictEqual("ext2");
  const tomb = body.changes.find((c) => c.id === P1);
  expect(tomb?.value).toStrictEqual(null);
  expect(body.nextCursor > cursor).toBeTruthy();

  // caught up: same cursor again after consuming → empty
  const idle = await sync({ cursor: body.nextCursor, mutations: [] });
  expect(((await idle.json()) as SyncResponse).changes.length).toStrictEqual(0);
});

test("a same-title project from a second node merges into the incumbent", async () => {
  const OLD = "00000000-0000-4000-8000-0000000000c1";
  const DUP = "00000000-0000-4000-8000-0000000000c2";
  const STORY = "00000000-0000-4000-8000-0000000000c3";
  const SESS = "00000000-0000-4000-8000-0000000000c4";
  const proj = (id: string, updatedAt: string) => {
    const p = page(id, "Obitrain", updatedAt);
    p.value.kind = "project";
    return p;
  };
  await sync({ cursor: null, mutations: [proj(OLD, "2026-07-17T10:00:00Z")] });

  // a fresh node re-creates the project and tracks a story + session under it
  const story = page(STORY, "RN upgrade", "2026-07-17T11:00:00Z");
  story.value.kind = "story";
  story.value.client_id = DUP as never;
  story.value.parent_id = DUP as never;
  const sess = {
    mutationId: `test:sessions:${SESS}:1`,
    entity: "sessions",
    id: SESS,
    op: "upsert",
    value: {
      id: SESS,
      title: "s1",
      status: "active",
      client_id: DUP,
      page_id: STORY,
      repo_path: null,
      branch: null,
      next_step: null,
      specs_page_id: null,
      tags: ["priority-p1", "infra"],
      pr_url: null,
      summary: "",
      claude_id: null,
      agent: null,
      last_touched: "2026-07-17T11:00:00Z",
      origin: "mac-test",
      updated_at: "2026-07-17T11:00:00Z",
      deleted: false,
    },
  };
  const res = await sync({
    cursor: null,
    mutations: [proj(DUP, "2026-07-17T11:00:00Z"), story, sess],
  });
  const body = await res.json() as SyncResponse;
  expect(body.rejectedMutations).toStrictEqual([]);

  const dup = (await pg.query(
    `select deleted, origin from pages where id=$1`,
    [DUP],
  )).rows[0] as { deleted: boolean; origin: string };
  expect(dup).toStrictEqual({ deleted: true, origin: "hub" });
  const st = (await pg.query(
    `select client_id, parent_id from pages where id=$1`,
    [STORY],
  )).rows[0] as { client_id: string; parent_id: string };
  expect(st).toStrictEqual({ client_id: OLD, parent_id: OLD });
  const se = (await pg.query(
    `select client_id, tags from sessions where id=$1`,
    [SESS],
  )).rows[0] as { client_id: string; tags: string[] };
  expect(se.client_id).toStrictEqual(OLD);
  expect(se.tags).toStrictEqual(["priority-p1", "infra"]);
  const snapshot = await (await sync({ cursor: null, mutations: [] })).json() as SyncResponse;
  expect(snapshot.changes.find((c) => c.entity === "sessions" && c.id === SESS)?.value?.tags).toStrictEqual(["priority-p1", "infra"]);
  const live = (await pg.query(
    `select id from pages where kind='project' and title='Obitrain' and not deleted`,
  )).rows;
  expect(live).toStrictEqual([{ id: OLD }]);
});

afterAll(() => pg.close());
