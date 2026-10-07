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

// A hub /api track writes session, event, then touches the session again: pull
// must still deliver the session first, or the replica's FK rejects the event.
Deno.test("pull after a hub /api track delivers the session before its event", async () => {
  const cursor = Number(
    ((await pg.query(`select max(rev) as r from change_log`)).rows[0] as {
      r: string;
    }).r,
  );
  const res = await call("/api/sessions", {
    body: { title: "fk order", repo_path: "/srv/fk", summary: "first log" },
  });
  const { id } = await res.json() as { id: string };
  const pull = await app.request("/sync", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-trame-protocol": String(PROTOCOL_VERSION),
      authorization: `Bearer ${memberToken}`,
    },
    body: JSON.stringify({ cursor, mutations: [] }),
  });
  const { changes } = await pull.json() as {
    changes: { entity: string; id: string; value: { session_id?: string } }[];
  };
  const session = changes.findIndex((c) =>
    c.entity === "sessions" && c.id === id
  );
  const event = changes.findIndex((c) =>
    c.entity === "session_events" && c.value?.session_id === id
  );
  assertEquals(session >= 0 && event >= 0, true);
  assertEquals(session < event, true);
});

// udb over the hub: user formula SQL may only run through the injected sandbox
// executor; without one the hub refuses to evaluate it.
const formulaCalls: string[] = [];
// PGlite is one connection: a spy querying it from inside the request txn would
// deadlock, so this app's core runs untransacted (production uses a 2nd connection)
const sandboxApp = createApp(db, { ...db, transaction: (fn) => fn(db) }, {
  query: async <T>(text: string, params?: unknown[]) => {
    formulaCalls.push(text);
    return { rows: (await pg.query(text, params)).rows as T[] };
  },
});
const udbCall = async (target: typeof app, path: string, body?: unknown) =>
  await (await target.request(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "x-trame-protocol": String(PROTOCOL_VERSION),
      authorization: `Bearer ${memberToken}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })).json();

async function udbWithFormula(target: typeof app) {
  const { id: dbId } = await udbCall(target, "/api/udb", { name: "Scores" });
  const { id: n } = await udbCall(target, `/api/udb/${dbId}/props`, {
    name: "n",
    type: "number",
    config: {},
  });
  await udbCall(target, `/api/udb/${dbId}/rows`, { vals: { [n]: 2 } });
  return { dbId, n };
}

for (
  const [id, target, expected] of [
    ["sandbox executor evaluates", sandboxApp, 6],
    ["no executor refuses", app, "formulas are not evaluated on this hub"],
  ] as const
) {
  Deno.test(`hub /api udb formulas: ${id}`, async () => {
    formulaCalls.length = 0;
    const { dbId } = await udbWithFormula(target);
    const created = await udbCall(target, `/api/udb/${dbId}/props`, {
      name: "triple",
      type: "formula",
      config: { expr: "n * 3" },
    });
    if (typeof expected === "string") {
      assertEquals(String(created.error).includes(expected), true);
      return;
    }
    const data = await udbCall(target, `/api/udb/${dbId}`) as {
      rows: { derived: Record<string, unknown> }[];
    };
    assertEquals(data.rows.map((r) => Number(r.derived[created.id])), [
      expected,
    ]);
    // validation + evaluation, both through the sandbox, never the core tx
    assertEquals(formulaCalls.length >= 2, true);
    assertEquals(formulaCalls.every((t) => t.includes("vals")), true);
  });
}

// rollup config rides /sync from any editor: its ids are spliced into SQL
Deno.test("hub /api udb rejects a rollup whose config smuggles SQL", async () => {
  const { dbId } = await udbWithFormula(sandboxApp);
  const rel = ((await pg.query(
    `insert into udb_properties (db_id, name, type, config, sort_key, origin)
     values ($1, 'rel', 'relation', $2, 'r', 'test') returning id`,
    [dbId, { owner: true, target_db: dbId }],
  )).rows[0] as { id: string }).id;
  const roll = ((await pg.query(
    `insert into udb_properties (db_id, name, type, config, sort_key, origin)
     values ($1, 'roll', 'rollup', $2, 's', 'test') returning id`,
    [dbId, {
      relation_prop: rel,
      agg: "sum",
      target_prop: "x'))::numeric) from api_tokens --",
    }],
  )).rows[0] as { id: string }).id;
  const data = await udbCall(sandboxApp, `/api/udb/${dbId}`) as {
    rows: { derived: Record<string, { error?: string }> }[];
  };
  assertEquals(data.rows[0].derived[roll], {
    error: "rollup: invalid property id",
  });
});

// agents forget to tick spec todos before closing a card — via track or a status move
for (
  const [id, via, status, done, note] of [
    ["track: done with an open todo", "track", "done", false, "card closed with 1 open todo(s) on its specs page: 'ship it'"],
    ["track: done with every todo ticked", "track", "done", true, undefined],
    ["track: active with an open todo", "track", "active", false, undefined],
    ["status: done with an open todo", "status", "done", false, "card closed with 1 open todo(s) on its specs page: 'ship it'"],
    ["status: active with an open todo", "status", "active", false, undefined],
  ] as const
) {
  Deno.test(`hub /api warns on open todos: ${id}`, async () => {
    const res = await call("/api/sessions", { body: { title: `todos ${id}`, repo_path: `/srv/todos/${id}` } });
    const { id: card } = await res.json() as { id: string };
    const { page_id } = await (await call(`/api/sessions/${card}/specs-page`, { body: {} })).json() as {
      page_id: string;
    };
    await pg.query(`update pages set content=$2::jsonb where id=$1`, [
      page_id,
      JSON.stringify([{ id: "t1", type: "todo", text: "ship it {{trame:created_at=2026-10-07}}", done }]),
    ]);
    const closed = via === "track"
      ? await call("/api/sessions", { body: { card, title: `todos ${id}`, status } })
      : await call(`/api/sessions/${card}/status`, { body: { status } });
    assertEquals(((await closed.json()) as { note?: string }).note?.split(" — ")[0], note);
  });
}

// the page list says which role a page's marks give it
Deno.test("hub /api page lists carry the role a page's marks give it", async () => {
  const mark = (m: string) => [{ id: "b1", type: "text", text: `x {{trame:${m}}}` }];
  const ids: Record<string, string> = {};
  for (const [key, content] of [["ticket", mark("cockpit_ref=GEN-1")], ["us", mark("cockpit_us=US-1")], ["none", []]]) {
    const res = await call("/api/pages", { body: { title: `cockpit kind ${key}`, content, repo_path: "/srv/kind" } });
    ids[key as string] = ((await res.json()) as { id: string }).id;
  }
  const pages = await (await call("/api/pages")).json() as { id: string; mark_role: string | null }[];
  const kindOf = (id: string) => pages.find((p) => p.id === id)?.mark_role;
  assertEquals([kindOf(ids.ticket), kindOf(ids.us), kindOf(ids.none)], ["ticket", "linked-story", null]);
  // Ctrl+P search hits carry it too
  const hits = await (await call("/api/search?q=cockpit%20kind")).json() as { id: string; mark_role: string | null }[];
  assertEquals(hits.find((h) => h.id === ids.ticket)?.mark_role, "ticket");
});
