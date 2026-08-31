// Isolated PGlite in a temp dir — set the env BEFORE importing any app module (config
// reads it at load), so app code is pulled in via dynamic import inside the test.
const tmp = await Deno.makeTempDir({ prefix: "trame-identity-test-" });
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "id-test");
Deno.env.set("TRACKER_OUTBOX", `${tmp}/outbox.jsonl`);
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_PORT_FILE", `${tmp}/port.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL(".", import.meta.url).pathname);

import { assert, assertEquals } from "@std/assert";

const SEED_USER = "00000000-0000-4000-8000-000000000101";

// These run in order and clean up after themselves (one PGlite for the file).

Deno.test("seed user exists and claimDevice converges on one deterministic row", async () => {
  const { db } = await import("./db.ts");
  const { claimDevice, deviceId } = await import("./identity.ts");
  const pg = await db();

  const users = (await pg.query(`select id, name from users where not deleted`))
    .rows as { id: string; name: string }[];
  assertEquals(users.length, 1);
  assertEquals(users[0].id, SEED_USER);

  await claimDevice();
  await claimDevice(); // idempotent — no second row
  const devices = (await pg.query(
    `select id, node_id, user_id from devices where not deleted`,
  )).rows as { id: string; node_id: string; user_id: string }[];
  assertEquals(devices.length, 1);
  assertEquals(
    devices[0].id,
    await deviceId("id-test"),
    "id derives from the node id",
  );
  assertEquals(devices[0].node_id, "id-test");
  assertEquals(devices[0].user_id, SEED_USER);
});

Deno.test("createComment stamps author_id and a display author", async () => {
  const { db } = await import("./db.ts");
  const { createComment, createPage } = await import("./pages.ts");
  const pg = await db();

  const pageId = await createPage({ title: "identity page" });
  const commentId = await createComment({
    page_id: pageId,
    block_id: "b1",
    body: "hello",
  });
  const c = (await pg.query(
    `select author, author_id from page_comments where id=$1`,
    [commentId],
  )).rows[0] as { author: string; author_id: string };
  assertEquals(c.author_id, SEED_USER);
  assert(c.author.length > 0, "display author is never empty");
});

Deno.test("agent comments use canonical attribution without a user id", async () => {
  const { db } = await import("./db.ts");
  const { createComment, createPage } = await import("./pages.ts");
  const pg = await db();

  const pageId = await createPage({ title: "agent comment page" });
  const commentId = await createComment({
    page_id: pageId,
    block_id: "b-agent",
    body: "review note",
    agent: "codex",
  });
  const c = (await pg.query(
    `select author, author_avatar, author_id from page_comments where id=$1`,
    [commentId],
  )).rows[0] as {
    author: string;
    author_avatar: string;
    author_id: string | null;
  };
  assertEquals(c.author, "Codex");
  // the reserved sentinel, never a real user id
  const { AGENT_AUTHOR_ID } = await import("./agent-comments.ts");
  assertEquals(c.author_id, AGENT_AUTHOR_ID);
  assert(
    c.author_avatar.startsWith("data:image/svg+xml;base64,"),
    "agent avatar is self-contained",
  );
});

Deno.test("agent comments always carry a model in their meta", async () => {
  const { db } = await import("./db.ts");
  const { createComment, createPage } = await import("./pages.ts");
  const pg = await db();

  const pageId = await createPage({ title: "agent meta page" });
  const metas = await Promise.all(
    [
      { agent: "codex" as const, meta: undefined },
      { agent: "claude" as const, meta: { model: "claude-opus-5", out: 42 } },
      { agent: undefined, meta: undefined },
    ].map(async ({ agent, meta }, i) => {
      const id = await createComment({
        page_id: pageId,
        block_id: `b-meta-${i}`,
        body: "note",
        agent,
        meta,
      });
      return ((await pg.query(`select meta from page_comments where id=$1`, [
        id,
      ])).rows[0] as { meta: string | null }).meta;
    }),
  );
  // an agent that cannot measure itself still names its model; a human gets no footer
  assertEquals(JSON.parse(metas[0] as string), { model: "codex" });
  assertEquals(JSON.parse(metas[1] as string), {
    model: "claude-opus-5",
    out: 42,
  });
  assertEquals(metas[2], null);
});

Deno.test("page creators stamp owner_id", async () => {
  const { db, resolveClient } = await import("./db.ts");
  const { createPage } = await import("./pages.ts");
  const pg = await db();

  const owners = await Promise.all([
    createPage({ title: "owned page" }),
    resolveClient("Identity Test Client"),
  ]).then((ids) =>
    Promise.all(
      ids.map(async (id) =>
        (await pg.query(`select owner_id from pages where id=$1`, [id]))
          .rows[0] as { owner_id: string | null }
      ),
    )
  );
  for (const o of owners) assertEquals(o.owner_id, SEED_USER);
});

// The "added a column to schema.sql but forgot app/sync.ts" failure mode is silent —
// the column simply never syncs. Pin every declared sync column to a real one.
Deno.test("every sync TABLES column exists in the schema", async () => {
  const { db } = await import("./db.ts");
  const { TABLES } = await import("./sync.ts");
  const pg = await db();

  for (const t of TABLES) {
    const cols = new Set(
      ((await pg.query(
        `select column_name from information_schema.columns where table_name=$1`,
        [t.name],
      )).rows as { column_name: string }[]).map((r) => r.column_name),
    );
    assert(cols.size > 0, `table ${t.name} exists`);
    for (const c of t.cols) {
      assert(
        cols.has(c),
        `${t.name}.${c} declared in sync.ts but missing in schema`,
      );
    }
  }
});

Deno.test("claimDevice stays unclaimed once a second user exists", async () => {
  const { db } = await import("./db.ts");
  const { claimDevice } = await import("./identity.ts");
  const pg = await db();

  await pg.query(
    `insert into users (id, name) values ('00000000-0000-4000-8000-000000000102','Guest')`,
  );
  await pg.query(`delete from devices where node_id='id-test'`);
  await claimDevice();
  const devices =
    (await pg.query(`select 1 from devices where node_id='id-test'`)).rows;
  assertEquals(
    devices.length,
    0,
    "ambiguous identity is left for the claim flow",
  );

  await pg.query(
    `delete from users where id='00000000-0000-4000-8000-000000000102'`,
  );
  await claimDevice(); // restore for any later test
});
