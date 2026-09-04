// Guest access through the full /sync stack on PGlite: what a guest sees, what
// they may write, and how grants/revokes reach an already-synced replica.
import { assert, assertEquals } from "@std/assert";
import { PGlite } from "@electric-sql/pglite";
import type { DB, Q } from "./db.ts";
import { ensureAuthSchema, mintToken } from "./auth.ts";
import { createApp } from "./app.ts";
import type { SyncResponse } from "../../protocol/types.ts";
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

// member device + token
await pg.query(
  `insert into devices (node_id, user_id, origin) values ('member-dev', $1, 'member-dev')`,
  [MEMBER],
);
const memberToken = await mintToken(db, "member-dev");
// guest user + device + token (what the invite CLI does)
const GUEST = ((await pg.query(
  `insert into users (name, role, origin) values ('Guest', 'guest', 'test') returning id`,
)).rows[0] as { id: string }).id;
await pg.query(
  `insert into devices (node_id, user_id, origin) values ('guest-dev', $1, 'test')`,
  [GUEST],
);
const guestToken = await mintToken(db, "guest-dev");

const sync = async (token: string, body: unknown) => {
  const res = await app.request("/sync", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-trame-protocol": String(PROTOCOL_VERSION),
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  assertEquals(res.status, 200);
  return await res.json() as SyncResponse;
};

// workspace: SHARED (with sub-page + database + comment) and PRIVATE
const SHARED = "00000000-0000-4000-8000-0000000000d1";
const SUB = "00000000-0000-4000-8000-0000000000d2";
const PRIVATE = "00000000-0000-4000-8000-0000000000d3";
const DB_ID = "00000000-0000-4000-8000-0000000000d4";
await pg.query(
  `insert into pages (id, title, origin, owner_id) values
   ($1, 'shared root', 'member-dev', $4),
   ($2, 'shared sub', 'member-dev', $4),
   ($3, 'private', 'member-dev', $4)`,
  [SHARED, SUB, PRIVATE, MEMBER],
);
await pg.query(`update pages set parent_id=$1 where id=$2`, [SHARED, SUB]);
await pg.query(
  `insert into udb_databases (id, name, page_id, origin) values ($1, 'tasks', $2, 'member-dev')`,
  [DB_ID, SUB],
);
await pg.query(
  `insert into page_comments (page_id, block_id, body, author_id, origin)
   values ($1, 'b1', 'root note', $2, 'member-dev')`,
  [SHARED, MEMBER],
);

const page = (
  id: string,
  title: string,
  extra: Record<string, unknown> = {},
) => ({
  mutationId: `g:pages:${id}:${title}`,
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
    owner_id: GUEST,
    origin: "guest-dev",
    updated_at: new Date().toISOString(),
    deleted: false,
    ...extra,
  },
});

Deno.test("an unshared guest sees only profiles (and nothing of the workspace)", async () => {
  const r = await sync(guestToken, { cursor: null, mutations: [] });
  const entities = new Set(r.changes.map((c) => c.entity));
  assertEquals([...entities].sort(), ["devices", "users"]);
  assertEquals(
    r.changes.filter((c) => c.entity === "devices").map((c) =>
      (c.value as { node_id: string }).node_id
    ),
    ["guest-dev"],
    "only their own device",
  );
});

Deno.test("sharing a page exposes exactly its subtree + attached database", async () => {
  await pg.query(
    `insert into page_shares (page_id, user_id, role, origin) values ($1, $2, 'editor', 'member-dev')`,
    [SHARED, GUEST],
  );
  const r = await sync(guestToken, { cursor: null, mutations: [] });
  const pages = r.changes.filter((c) => c.entity === "pages").map((c) => c.id)
    .sort();
  assertEquals(pages, [SHARED, SUB], "subtree yes, private page no");
  assertEquals(r.changes.filter((c) => c.entity === "udb_databases").length, 1);
  assertEquals(r.changes.filter((c) => c.entity === "page_comments").length, 1);
  assertEquals(r.changes.filter((c) => c.entity === "sessions").length, 0);
});

Deno.test("editor can write inside the subtree, nowhere else; own profile ok", async () => {
  const inside = page("00000000-0000-4000-8000-0000000000d5", "guest sub", {
    parent_id: SUB,
  });
  const outside = page("00000000-0000-4000-8000-0000000000d6", "escape", {
    parent_id: PRIVATE,
    owner_id: MEMBER,
  });
  const comment = {
    mutationId: "g:comment:1",
    entity: "page_comments",
    id: "00000000-0000-4000-8000-0000000000c1",
    op: "upsert",
    value: {
      id: "00000000-0000-4000-8000-0000000000c1",
      page_id: SUB,
      block_id: "b1",
      anchor: "",
      body: "guest was here",
      author: "Guest",
      author_avatar: "",
      author_id: GUEST,
      resolved: false,
      origin: "guest-dev",
      updated_at: new Date().toISOString(),
      deleted: false,
    },
  };
  const shareGrab = {
    mutationId: "g:share:1",
    entity: "page_shares",
    id: "00000000-0000-4000-8000-0000000000e1",
    op: "upsert",
    value: {
      id: "00000000-0000-4000-8000-0000000000e1",
      page_id: PRIVATE,
      user_id: GUEST,
      role: "editor",
      origin: "guest-dev",
      updated_at: new Date().toISOString(),
      deleted: false,
    },
  };
  const r = await sync(guestToken, {
    cursor: null,
    mutations: [inside, comment, outside, shareGrab],
  });
  assertEquals(r.acknowledgements.length, 2, "inside page + comment land");
  assertEquals(
    r.rejectedMutations.map((m) => m.reason),
    ["forbidden", "forbidden"],
    "writing under the private page and self-granting a share are both rejected",
  );
  const c = (await pg.query(`select author_id from page_comments where id=$1`, [
    comment.id,
  ]))
    .rows[0] as { author_id: string };
  assertEquals(c.author_id, GUEST);
});

Deno.test("a guest cannot write a comment as someone else", async () => {
  const spoof = {
    mutationId: "g:spoof:1",
    entity: "page_comments",
    id: "00000000-0000-4000-8000-0000000000c2",
    op: "upsert",
    value: {
      id: "00000000-0000-4000-8000-0000000000c2",
      page_id: SUB,
      block_id: "b1",
      anchor: "",
      body: "impostor",
      author: "Not Gia",
      author_avatar: "",
      author_id: MEMBER, // spoofed
      resolved: false,
      origin: "guest-dev",
      updated_at: new Date().toISOString(),
      deleted: false,
    },
  };
  const r = await sync(guestToken, { cursor: null, mutations: [spoof] });
  assertEquals(r.rejectedMutations.map((m) => m.reason), ["forbidden"]);
});

Deno.test("viewer can read but every write is rejected", async () => {
  await pg.query(
    `update page_shares set role='viewer', updated_at=now() where page_id=$1 and user_id=$2`,
    [SHARED, GUEST],
  );
  const r = await sync(guestToken, {
    cursor: null,
    mutations: [
      page("00000000-0000-4000-8000-0000000000d7", "nope", {
        parent_id: SUB,
        owner_id: MEMBER,
      }),
    ],
  });
  assertEquals(r.rejectedMutations.length, 1);
  assert(r.changes.some((c) => c.id === SHARED), "still reads the subtree");
  await pg.query(
    `update page_shares set role='editor', updated_at=now() where page_id=$1 and user_id=$2`,
    [SHARED, GUEST],
  );
});

Deno.test("a grant mid-cursor back-fills rows older than the cursor", async () => {
  // guest is caught up, then a share lands on PRIVATE (created long before)
  const cur =
    (await sync(guestToken, { cursor: null, mutations: [] })).nextCursor;
  await pg.query(
    `insert into page_shares (page_id, user_id, role, origin) values ($1, $2, 'viewer', 'member-dev')`,
    [PRIVATE, GUEST],
  );
  const r = await sync(guestToken, { cursor: cur, mutations: [] });
  assert(
    r.changes.some((c) =>
      c.entity === "pages" && c.id === PRIVATE && c.value !== null
    ),
    "the old page arrives despite predating the cursor",
  );
});

Deno.test("a revoke tombstones the subtree, sparing overlapping grants", async () => {
  const cur =
    (await sync(guestToken, { cursor: null, mutations: [] })).nextCursor;
  await pg.query(
    `update page_shares set deleted=true, updated_at=now() where page_id=$1 and user_id=$2`,
    [PRIVATE, GUEST],
  );
  const r = await sync(guestToken, { cursor: cur, mutations: [] });
  const tomb = r.changes.filter((c) => c.value === null).map((c) => c.id);
  assert(tomb.includes(PRIVATE), "revoked page tombstoned");
  assert(!tomb.includes(SHARED), "the still-shared subtree is untouched");

  // and the member is entirely unaffected by any of this
  const m = await sync(memberToken, { cursor: null, mutations: [] });
  assert(m.changes.some((c) => c.id === PRIVATE && c.value !== null));
});
