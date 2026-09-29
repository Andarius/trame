// The laptop /api contract served by the hub (tramecli with no local app): who may
// call it, and that hub writes carry the caller's provenance like a /sync push.
import { assertEquals } from "@std/assert";
import { PGlite } from "@electric-sql/pglite";
import type { DB, Q } from "./db.ts";
import { ensureAuthSchema, mintToken } from "./auth.ts";
import { createApp } from "./app.ts";
import { PROTOCOL_VERSION } from "../../protocol/entities.ts";

const MEMBER = "00000000-0000-4000-8000-000000000101"; // the seeded user

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
const app = createApp(db);

await pg.query(
  `insert into devices (node_id, user_id, origin) values ('member-dev', $1, 'test')`,
  [MEMBER],
);
const memberToken = await mintToken(db, "member-dev");
const GUEST = ((await pg.query(
  `insert into users (name, role, origin) values ('Guest', 'guest', 'test') returning id`,
)).rows[0] as { id: string }).id;
await pg.query(
  `insert into devices (node_id, user_id, origin) values ('guest-dev', $1, 'test')`,
  [GUEST],
);
const guestToken = await mintToken(db, "guest-dev");
// a guest soft-deleted after invite keeps its token and device row
const GONE = ((await pg.query(
  `insert into users (name, role, origin, deleted) values ('Gone', 'guest', 'test', true) returning id`,
)).rows[0] as { id: string }).id;
await pg.query(
  `insert into devices (node_id, user_id, origin) values ('gone-dev', $1, 'test')`,
  [GONE],
);
const goneToken = await mintToken(db, "gone-dev");
const unboundToken = await mintToken(db, "unbound-dev");

const call = (
  path: string,
  { token = memberToken, protocol = String(PROTOCOL_VERSION), body }: {
    token?: string | null;
    protocol?: string | null;
    body?: unknown;
  } = {},
) =>
  app.request(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      ...(protocol ? { "x-trame-protocol": protocol } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

for (
  const [id, path, opts, status] of [
    ["no token", "/api/board", { token: null }, 401],
    ["bad token", "/api/board", { token: "nope" }, 401],
    ["no protocol header", "/api/board", { protocol: null }, 400],
    [
      "older protocol",
      "/api/board",
      { protocol: String(PROTOCOL_VERSION - 1) },
      400,
    ],
    ["guest", "/api/board", { token: guestToken }, 403],
    ["deleted guest", "/api/board", { token: goneToken }, 403],
    ["unbound device", "/api/board", { token: unboundToken }, 403],
    ["guest write", "/api/sessions", {
      token: guestToken,
      body: { title: "x" },
    }, 403],
    ["laptop-only route", "/api/status", {}, 404],
    ["member", "/api/board", {}, 200],
  ] as const
) {
  Deno.test(`hub /api access: ${id}`, async () => {
    const res = await call(path, opts);
    await res.body?.cancel();
    assertEquals(res.status, status);
  });
}

Deno.test("hub /api writes carry the caller's node, user and api source", async () => {
  const res = await call("/api/sessions", {
    body: {
      title: "headless track",
      repo_path: "/srv/work/repo",
      branch: "feat/x",
      story: "Hub story",
      client: "Hub project",
    },
  });
  assertEquals(res.status, 200);
  const { id } = await res.json() as { id: string };

  const board = await (await call("/api/board")).json() as {
    sessions: { id: string }[];
  };
  assertEquals(board.sessions.some((s) => s.id === id), true);

  const session = (await pg.query(
    `select origin, page_id, client_id from sessions where id=$1`,
    [id],
  )).rows[0] as { origin: string; page_id: string; client_id: string };
  assertEquals(session.origin, "member-dev");
  // pages minted on the hub are owned by the caller's user, resolved from its device
  const owners = (await pg.query(
    `select kind, owner_id from pages where id in ($1, $2) order by kind`,
    [session.client_id, session.page_id],
  )).rows;
  assertEquals(owners, [
    { kind: "project", owner_id: MEMBER },
    { kind: "story", owner_id: MEMBER },
  ]);
  const log = (await pg.query(
    `select distinct actor, source from change_log where entity='sessions' and row_id=$1`,
    [id],
  )).rows;
  assertEquals(log, [{ actor: MEMBER, source: "api" }]);
});

// tramecli sends blocks and a resolved block_id; content is jsonb end to end
Deno.test("hub /api reads and writes pages and comments", async () => {
  const content = [{ id: "b1", type: "text", text: "first block" }];
  const created = await call("/api/pages", {
    body: { title: "Hub page", content, repo_path: "/srv/work/repo" },
  });
  assertEquals(created.status, 200);
  const { id: pageId } = await created.json() as { id: string };

  const comment = await call("/api/comments", {
    body: { page_id: pageId, block_id: "b1", body: "from the hub" },
  });
  assertEquals(comment.status, 200);

  const page = await (await call(`/api/pages/${pageId}`)).json() as {
    title: string;
    content: unknown[];
    comments: { body: string; author_id: string }[];
  };
  assertEquals(page.title, "Hub page");
  assertEquals(page.content, content);
  assertEquals(
    page.comments.map((c) => ({ body: c.body, author_id: c.author_id })),
    [{ body: "from the hub", author_id: MEMBER }],
  );
});

Deno.test("a hub /api error rolls back what the route wrote first", async () => {
  // resolveHomeProject mints the repo's project, then content validation fails
  const res = await call("/api/pages", {
    body: { title: "bad", repo_path: "/srv/rollback/repo", content: {} },
  });
  await res.body?.cancel();
  assertEquals(res.status >= 400, true);
  const minted = (await pg.query(
    `select count(*)::int as n from pages where title in ('bad', 'Side-projects')`,
  )).rows[0] as { n: number };
  assertEquals(minted.n, 0);
});
