import { expect, test } from "bun:test";
import { testTempDir } from "./test_tmp.ts";
// Isolated PGlite in a temp dir — set the env BEFORE importing any app module (config
// reads it at load), so app code is pulled in via dynamic import inside the tests.
const tmp = testTempDir("trame-watch-test-");
process.env.TRACKER_DATA_DIR = `${tmp}/pglite`;
process.env.TRACKER_NODE_ID = "watch-test";
process.env.TRACKER_OUTBOX = `${tmp}/outbox.jsonl`;
process.env.TRACKER_SETTINGS_FILE = `${tmp}/settings.json`;
process.env.TRACKER_PORT_FILE = `${tmp}/port.json`;
process.env.TRACKER_APP_ROOT = new URL(".", import.meta.url).pathname;
const { APP_CTX } = await import("./ctx.ts");

import { AGENT_AUTHOR_ID } from "../core/agent-comments.ts";

const { db } = await import("./db.ts");
const {
  createComment,
  createPage,
  listCommentInbox,
  listComments,
  setCommentAgentStatus,
  updateComment,
} = await import("../core/pages.ts");

// A thread on a fresh page: one agent comment, then a human reply (guaranteed newer).
// Returns the reply id + block id. `agent` picks which CLI should own the answer.
async function seedThread(
  agent: "codex" | "claude" = "codex",
): Promise<{ pageId: string; blockId: string; replyId: string }> {
  const pageId = await createPage(APP_CTX, {
    title: `t-${crypto.randomUUID().slice(0, 8)}`,
  });
  const blockId = crypto.randomUUID().slice(0, 8);
  const pg = await db();
  await pg.query(`update pages set content=$2 where id=$1`, [
    pageId,
    JSON.stringify([{ type: "text", text: "the block text", id: blockId }]),
  ]);
  const agentId = await createComment(APP_CTX, {
    page_id: pageId,
    block_id: blockId,
    body: "agent question",
    agent,
  });
  const replyId = await createComment(APP_CTX, {
    page_id: pageId,
    block_id: blockId,
    body: "human reply",
  });
  // make the agent comment deterministically older than the reply
  await pg.query(
    `update page_comments set updated_at = updated_at - interval '1 second' where id=$1`,
    [agentId],
  );
  return { pageId, blockId, replyId };
}

const inboxFor = async (replyId: string, staleSecs = 600) =>
  (await listCommentInbox(APP_CTX, staleSecs)).find((i) => i.comment.id === replyId);

test("a human reply to an agent thread surfaces in the inbox with the right agent", async () => {
  const { replyId } = await seedThread("codex");
  const item = await inboxFor(replyId);
  if (!item) throw new Error("reply should be an inbox candidate");
  expect(item.agent).toStrictEqual("codex");
  expect(item.block.text).toStrictEqual("the block text");
  expect(item.thread.length).toStrictEqual(2);
});

test("agent comments themselves are never inbox candidates", async () => {
  const pageId = await createPage(APP_CTX, { title: "agent-only" });
  const pg = await db();
  await pg.query(`update pages set content=$2 where id=$1`, [
    pageId,
    JSON.stringify([{ type: "text", text: "x", id: "blk" }]),
  ]);
  const agentId = await createComment(APP_CTX, {
    page_id: pageId,
    block_id: "blk",
    body: "just an agent note",
    agent: "claude",
  });
  const inbox = await listCommentInbox(APP_CTX);
  expect(inbox.find((i) => i.comment.id === agentId)).toStrictEqual(undefined);
});

test("a human comment with no prior agent comment is not a candidate", async () => {
  const pageId = await createPage(APP_CTX, { title: "human-only" });
  const pg = await db();
  await pg.query(`update pages set content=$2 where id=$1`, [
    pageId,
    JSON.stringify([{ type: "text", text: "x", id: "blk" }]),
  ]);
  const id = await createComment(APP_CTX, {
    page_id: pageId,
    block_id: "blk",
    body: "hi",
  });
  expect(await inboxFor(id)).toStrictEqual(undefined);
});

test("all mode surfaces first-contact comments, scoped by page", async () => {
  const pageId = await createPage(APP_CTX, { title: "watch-all" });
  const pg = await db();
  await pg.query(`update pages set content=$2 where id=$1`, [
    pageId,
    JSON.stringify([{ type: "text", text: "the section", id: "blk" }]),
  ]);
  const id = await createComment(APP_CTX, {
    page_id: pageId,
    block_id: "blk",
    body: "please rework this section",
  });
  const find = (items: Awaited<ReturnType<typeof listCommentInbox>>) =>
    items.find((i) => i.comment.id === id);
  // the default inbox still requires a prior agent comment
  expect(find(await listCommentInbox(APP_CTX))).toStrictEqual(undefined);
  // all mode sees it, attributed to the default agent
  const item = find(await listCommentInbox(APP_CTX, 600, { all: true }));
  if (!item) throw new Error("first-contact comment should surface in all mode");
  expect(item.agent).toStrictEqual("claude");
  // page filter: another page excludes it, its own page keeps it
  expect(find(
      await listCommentInbox(APP_CTX, 600, { all: true, pages: [crypto.randomUUID()] }),
    )).toStrictEqual(undefined);
  expect(find(await listCommentInbox(APP_CTX, 600, { all: true, pages: [pageId] }))).toBeTruthy();
});

test("an answered reply (newer agent comment) leaves the inbox", async () => {
  const { pageId, blockId, replyId } = await seedThread();
  expect(await inboxFor(replyId), "unanswered reply is a candidate").toBeTruthy();
  await createComment(APP_CTX, {
    page_id: pageId,
    block_id: blockId,
    body: "agent answer",
    agent: "codex",
  });
  expect(await inboxFor(replyId), "answered → gone").toStrictEqual(undefined);
});

test("two consecutive human replies yield only the newest as a candidate", async () => {
  const { pageId, blockId, replyId: h1 } = await seedThread();
  await new Promise((r) => setTimeout(r, 5));
  const h2 = await createComment(APP_CTX, {
    page_id: pageId,
    block_id: blockId,
    body: "a second question",
  });
  const inbox = await listCommentInbox(APP_CTX);
  const onBlock = inbox.filter((i) =>
    (i.comment.block_id as string) === blockId
  );
  expect(onBlock.length, "exactly one candidate per block").toStrictEqual(1);
  expect(onBlock[0].comment.id, "the newest reply, not the earlier one").toStrictEqual(h2);
  expect(await inboxFor(h1), "the older reply is not answered twice").toStrictEqual(undefined);
});

test("a custom author without agent is not stamped as an agent", async () => {
  const pageId = await createPage(APP_CTX, { title: "custom-author" });
  const pg = await db();
  const id = await createComment(APP_CTX, {
    page_id: pageId,
    block_id: "b",
    body: "hi",
    author: "Some Bot",
  });
  const row = (await pg.query(
    `select author, author_id from page_comments where id=$1`,
    [id],
  )).rows[0] as { author: string; author_id: string | null };
  expect(row.author, "display name is kept").toStrictEqual("Some Bot");
  expect(row.author_id !== AGENT_AUTHOR_ID, "a non-agent custom author must not get the agent sentinel").toBeTruthy();
});

test("reopening an answered reply with unchanged text does not requeue it", async () => {
  const { pageId, blockId, replyId } = await seedThread();
  // agent answers, watcher marks the reply answered (keeps its body hash)
  await new Promise((r) => setTimeout(r, 5));
  await createComment(APP_CTX, {
    page_id: pageId,
    block_id: blockId,
    body: "agent answer",
    agent: "codex",
  });
  await setCommentAgentStatus(APP_CTX, replyId, { status: "answered", agent: "codex" });
  expect(await inboxFor(replyId), "answered → not a candidate").toStrictEqual(undefined);
  // resolve then reopen bumps updated_at past the answer, but the text is unchanged
  await updateComment(APP_CTX, replyId, { resolved: true });
  await updateComment(APP_CTX, replyId, { resolved: false });
  expect(await inboxFor(replyId), "reopen with unchanged text stays answered (hash matches)").toStrictEqual(undefined);
});

test("status lifecycle: seen stays listed, body edit re-triggers, stale re-surfaces", async () => {
  const { replyId } = await seedThread();
  // "seen" is the pickup badge, not a claim: a watcher that marks it then keeps
  // polling its own inbox during the quiet window must still find the item
  await setCommentAgentStatus(APP_CTX, replyId, { status: "seen", agent: "codex" });
  expect(await inboxFor(replyId), "fresh seen → still pending").toBeTruthy();

  await updateComment(APP_CTX, replyId, { body: "human reply, edited" });
  expect(await inboxFor(replyId), "body edit → re-triggers (hash differs)").toBeTruthy();

  await setCommentAgentStatus(APP_CTX, replyId, { status: "answering", agent: "codex" });
  expect(await inboxFor(replyId), "answering (fresh) → handled").toStrictEqual(undefined);
  const pg = await db();
  await pg.query(
    `update comment_agent_status set updated_at = now() - interval '30 minutes' where comment_id=$1`,
    [replyId],
  );
  expect(await inboxFor(replyId, 600), "stale answering → crash self-heal").toBeTruthy();
});

test("resolve / reopen without a body edit does not re-trigger", async () => {
  const { replyId } = await seedThread();
  await setCommentAgentStatus(APP_CTX, replyId, { status: "answered", agent: "codex" });
  await updateComment(APP_CTX, replyId, { resolved: true });
  expect(await inboxFor(replyId), "resolved → excluded").toStrictEqual(undefined);
  await updateComment(APP_CTX, replyId, { resolved: false });
  expect(await inboxFor(replyId), "reopen, same body → hash matches").toStrictEqual(undefined);
});

test("listComments exposes the newest agent status", async () => {
  const { pageId, replyId } = await seedThread();
  await setCommentAgentStatus(APP_CTX, replyId, { status: "answering", agent: "codex" });
  const reply = (await listComments(APP_CTX, pageId) as Record<string, unknown>[]).find((
    c,
  ) => c.id === replyId) as {
    agent_status: string;
    agent_status_agent: string;
  };
  expect(reply.agent_status).toStrictEqual("answering");
  expect(reply.agent_status_agent).toStrictEqual("codex");
  await setCommentAgentStatus(APP_CTX, replyId, { status: "clear" });
  const cleared = (await listComments(APP_CTX, pageId) as Record<string, unknown>[])
    .find((c) => c.id === replyId) as { agent_status: string | null };
  expect(cleared.agent_status, "clear soft-deletes the status").toStrictEqual(null);
});

test("setCommentAgentStatus rejects an unknown comment", async () => {
  let threw = false;
  try {
    await setCommentAgentStatus(APP_CTX, crypto.randomUUID(), { status: "seen" });
  } catch {
    threw = true;
  }
  expect(threw, "unknown comment id should error").toBeTruthy();
});
