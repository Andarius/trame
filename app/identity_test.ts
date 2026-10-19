import { expect, test } from "bun:test";
import { testTempDir } from "./test_tmp.ts";
// Isolated PGlite in a temp dir — set the env BEFORE importing any app module (config
// reads it at load), so app code is pulled in via dynamic import inside the test.
const tmp = testTempDir("trame-identity-test-");
process.env.TRACKER_DATA_DIR = `${tmp}/pglite`;
process.env.TRACKER_NODE_ID = "id-test";
process.env.TRACKER_OUTBOX = `${tmp}/outbox.jsonl`;
process.env.TRACKER_SETTINGS_FILE = `${tmp}/settings.json`;
process.env.TRACKER_PORT_FILE = `${tmp}/port.json`;
process.env.TRACKER_APP_ROOT = new URL(".", import.meta.url).pathname;
const { APP_CTX } = await import("./ctx.ts");


const SEED_USER = "00000000-0000-4000-8000-000000000101";

// These run in order and clean up after themselves (one PGlite for the file).

test("seed user exists and claimDevice converges on one deterministic row", async () => {
  const { db } = await import("./db.ts");
  const { claimDevice, deviceId } = await import("./identity.ts");
  const pg = await db();

  const users = (await pg.query(`select id, name from users where not deleted`))
    .rows as { id: string; name: string }[];
  expect(users.length).toStrictEqual(1);
  expect(users[0].id).toStrictEqual(SEED_USER);

  await claimDevice();
  await claimDevice(); // idempotent — no second row
  const devices = (await pg.query(
    `select id, node_id, user_id from devices where not deleted`,
  )).rows as { id: string; node_id: string; user_id: string }[];
  expect(devices.length).toStrictEqual(1);
  expect(devices[0].id, "id derives from the node id").toStrictEqual(await deviceId("id-test"));
  expect(devices[0].node_id).toStrictEqual("id-test");
  expect(devices[0].user_id).toStrictEqual(SEED_USER);
});

test("createComment stamps author_id and a display author", async () => {
  const { db } = await import("./db.ts");
  const { createComment, createPage } = await import("../core/pages.ts");
  const pg = await db();

  const pageId = await createPage(APP_CTX, { title: "identity page" });
  const commentId = await createComment(APP_CTX, {
    page_id: pageId,
    block_id: "b1",
    body: "hello",
  });
  const c = (await pg.query(
    `select author, author_id from page_comments where id=$1`,
    [commentId],
  )).rows[0] as { author: string; author_id: string };
  expect(c.author_id).toStrictEqual(SEED_USER);
  expect(c.author.length > 0, "display author is never empty").toBeTruthy();
});

test("agent comments use canonical attribution without a user id", async () => {
  const { db } = await import("./db.ts");
  const { createComment, createPage } = await import("../core/pages.ts");
  const pg = await db();

  const pageId = await createPage(APP_CTX, { title: "agent comment page" });
  const commentId = await createComment(APP_CTX, {
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
  expect(c.author).toStrictEqual("Codex");
  // the reserved sentinel, never a real user id
  const { AGENT_AUTHOR_ID } = await import("../core/agent-comments.ts");
  expect(c.author_id).toStrictEqual(AGENT_AUTHOR_ID);
  expect(c.author_avatar.startsWith("data:image/svg+xml;base64,"), "agent avatar is self-contained").toBeTruthy();
});

test("agent comments always carry a model in their meta", async () => {
  const { db } = await import("./db.ts");
  const { createComment, createPage } = await import("../core/pages.ts");
  const pg = await db();

  const pageId = await createPage(APP_CTX, { title: "agent meta page" });
  const metas = await Promise.all(
    [
      { agent: "codex" as const, meta: undefined },
      { agent: "claude" as const, meta: { model: "claude-opus-5", out: 42 } },
      { agent: undefined, meta: undefined },
    ].map(async ({ agent, meta }, i) => {
      const id = await createComment(APP_CTX, {
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
  expect(JSON.parse(metas[0] as string)).toStrictEqual({ model: "codex" });
  expect(JSON.parse(metas[1] as string)).toStrictEqual({
    model: "claude-opus-5",
    out: 42,
  });
  expect(metas[2]).toStrictEqual(null);
});

test("page creators stamp owner_id", async () => {
  const { db } = await import("./db.ts");
const { resolveClient } = await import("../core/sessions.ts");
  const { createPage } = await import("../core/pages.ts");
  const pg = await db();

  const owners = await Promise.all([
    createPage(APP_CTX, { title: "owned page" }),
    resolveClient(APP_CTX, "Identity Test Client"),
  ]).then((ids) =>
    Promise.all(
      ids.map(async (id) =>
        (await pg.query(`select owner_id from pages where id=$1`, [id]))
          .rows[0] as { owner_id: string | null }
      ),
    )
  );
  for (const o of owners) expect(o.owner_id).toStrictEqual(SEED_USER);
});

test("claimDevice stays unclaimed once a second user exists", async () => {
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
  expect(devices.length, "ambiguous identity is left for the claim flow").toStrictEqual(0);

  await pg.query(
    `delete from users where id='00000000-0000-4000-8000-000000000102'`,
  );
  await claimDevice(); // restore for any later test
});
