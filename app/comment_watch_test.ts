// Isolated PGlite in a temp dir — set the env BEFORE importing any app module (config
// reads it at load), so app code is pulled in via dynamic import inside the tests.
const tmp = await Deno.makeTempDir({ prefix: "trame-watch-test-" });
Deno.env.set("TRACKER_DATA_DIR", `${tmp}/pglite`);
Deno.env.set("TRACKER_NODE_ID", "watch-test");
Deno.env.set("TRACKER_OUTBOX", `${tmp}/outbox.jsonl`);
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_PORT_FILE", `${tmp}/port.json`);
Deno.env.set("TRACKER_APP_ROOT", new URL(".", import.meta.url).pathname);

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { AGENT_AUTHOR_ID } from "./agent-comments.ts";

const { db } = await import("./db.ts");
const {
  createComment,
  createPage,
  listCommentInbox,
  listComments,
  setCommentAgentStatus,
  updateComment,
} = await import("./pages.ts");

// A thread on a fresh page: one agent comment, then a human reply (guaranteed newer).
// Returns the reply id + block id. `agent` picks which CLI should own the answer.
async function seedThread(
  agent: "codex" | "claude" = "codex",
): Promise<{ pageId: string; blockId: string; replyId: string }> {
  const pageId = await createPage({
    title: `t-${crypto.randomUUID().slice(0, 8)}`,
  });
  const blockId = crypto.randomUUID().slice(0, 8);
  const pg = await db();
  await pg.query(`update pages set content=$2 where id=$1`, [
    pageId,
    JSON.stringify([{ type: "text", text: "the block text", id: blockId }]),
  ]);
  const agentId = await createComment({
    page_id: pageId,
    block_id: blockId,
    body: "agent question",
    agent,
  });
  const replyId = await createComment({
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
  (await listCommentInbox(staleSecs)).find((i) => i.comment.id === replyId);

Deno.test("a human reply to an agent thread surfaces in the inbox with the right agent", async () => {
  const { replyId } = await seedThread("codex");
  const item = await inboxFor(replyId);
  assert(item, "reply should be an inbox candidate");
  assertEquals(item.agent, "codex");
  assertEquals(item.block.text, "the block text");
  assertEquals(item.thread.length, 2);
});

Deno.test("agent comments themselves are never inbox candidates", async () => {
  const pageId = await createPage({ title: "agent-only" });
  const pg = await db();
  await pg.query(`update pages set content=$2 where id=$1`, [
    pageId,
    JSON.stringify([{ type: "text", text: "x", id: "blk" }]),
  ]);
  const agentId = await createComment({
    page_id: pageId,
    block_id: "blk",
    body: "just an agent note",
    agent: "claude",
  });
  const inbox = await listCommentInbox();
  assertEquals(inbox.find((i) => i.comment.id === agentId), undefined);
});

Deno.test("a human comment with no prior agent comment is not a candidate", async () => {
  const pageId = await createPage({ title: "human-only" });
  const pg = await db();
  await pg.query(`update pages set content=$2 where id=$1`, [
    pageId,
    JSON.stringify([{ type: "text", text: "x", id: "blk" }]),
  ]);
  const id = await createComment({
    page_id: pageId,
    block_id: "blk",
    body: "hi",
  });
  assertEquals(await inboxFor(id), undefined);
});

Deno.test("an answered reply (newer agent comment) leaves the inbox", async () => {
  const { pageId, blockId, replyId } = await seedThread();
  assert(await inboxFor(replyId), "unanswered reply is a candidate");
  await createComment({
    page_id: pageId,
    block_id: blockId,
    body: "agent answer",
    agent: "codex",
  });
  assertEquals(await inboxFor(replyId), undefined, "answered → gone");
});

Deno.test("two consecutive human replies yield only the newest as a candidate", async () => {
  const { pageId, blockId, replyId: h1 } = await seedThread();
  await new Promise((r) => setTimeout(r, 5));
  const h2 = await createComment({
    page_id: pageId,
    block_id: blockId,
    body: "a second question",
  });
  const inbox = await listCommentInbox();
  const onBlock = inbox.filter((i) =>
    (i.comment.block_id as string) === blockId
  );
  assertEquals(onBlock.length, 1, "exactly one candidate per block");
  assertEquals(
    onBlock[0].comment.id,
    h2,
    "the newest reply, not the earlier one",
  );
  assertEquals(
    await inboxFor(h1),
    undefined,
    "the older reply is not answered twice",
  );
});

Deno.test("a custom author without agent is not stamped as an agent", async () => {
  const pageId = await createPage({ title: "custom-author" });
  const pg = await db();
  const id = await createComment({
    page_id: pageId,
    block_id: "b",
    body: "hi",
    author: "Some Bot",
  });
  const row = (await pg.query(
    `select author, author_id from page_comments where id=$1`,
    [id],
  )).rows[0] as { author: string; author_id: string | null };
  assertEquals(row.author, "Some Bot", "display name is kept");
  assert(
    row.author_id !== AGENT_AUTHOR_ID,
    "a non-agent custom author must not get the agent sentinel",
  );
});

Deno.test("reopening an answered reply with unchanged text does not requeue it", async () => {
  const { pageId, blockId, replyId } = await seedThread();
  // agent answers, watcher marks the reply answered (keeps its body hash)
  await new Promise((r) => setTimeout(r, 5));
  await createComment({
    page_id: pageId,
    block_id: blockId,
    body: "agent answer",
    agent: "codex",
  });
  await setCommentAgentStatus(replyId, { status: "answered", agent: "codex" });
  assertEquals(
    await inboxFor(replyId),
    undefined,
    "answered → not a candidate",
  );
  // resolve then reopen bumps updated_at past the answer, but the text is unchanged
  await updateComment(replyId, { resolved: true });
  await updateComment(replyId, { resolved: false });
  assertEquals(
    await inboxFor(replyId),
    undefined,
    "reopen with unchanged text stays answered (hash matches)",
  );
});

Deno.test("status lifecycle: seen (fresh) drops out, body edit re-triggers, stale re-surfaces", async () => {
  const { replyId } = await seedThread();
  await setCommentAgentStatus(replyId, { status: "seen", agent: "codex" });
  assertEquals(await inboxFor(replyId), undefined, "fresh seen → handled");

  await updateComment(replyId, { body: "human reply, edited" });
  assert(await inboxFor(replyId), "body edit → re-triggers (hash differs)");

  await setCommentAgentStatus(replyId, { status: "answering", agent: "codex" });
  assertEquals(
    await inboxFor(replyId),
    undefined,
    "answering (fresh) → handled",
  );
  const pg = await db();
  await pg.query(
    `update comment_agent_status set updated_at = now() - interval '30 minutes' where comment_id=$1`,
    [replyId],
  );
  assert(await inboxFor(replyId, 600), "stale answering → crash self-heal");
});

Deno.test("resolve / reopen without a body edit does not re-trigger", async () => {
  const { replyId } = await seedThread();
  await setCommentAgentStatus(replyId, { status: "seen", agent: "codex" });
  await updateComment(replyId, { resolved: true });
  assertEquals(await inboxFor(replyId), undefined, "resolved → excluded");
  await updateComment(replyId, { resolved: false });
  assertEquals(
    await inboxFor(replyId),
    undefined,
    "reopen, same body → hash matches",
  );
});

Deno.test("listComments exposes the newest agent status", async () => {
  const { pageId, replyId } = await seedThread();
  await setCommentAgentStatus(replyId, { status: "answering", agent: "codex" });
  const reply = (await listComments(pageId) as Record<string, unknown>[]).find((
    c,
  ) => c.id === replyId) as {
    agent_status: string;
    agent_status_agent: string;
  };
  assertEquals(reply.agent_status, "answering");
  assertEquals(reply.agent_status_agent, "codex");
  await setCommentAgentStatus(replyId, { status: "clear" });
  const cleared = (await listComments(pageId) as Record<string, unknown>[])
    .find((c) => c.id === replyId) as { agent_status: string | null };
  assertEquals(cleared.agent_status, null, "clear soft-deletes the status");
});

Deno.test("setCommentAgentStatus rejects an unknown comment", async () => {
  let threw = false;
  try {
    await setCommentAgentStatus(crypto.randomUUID(), { status: "seen" });
  } catch {
    threw = true;
  }
  assert(threw, "unknown comment id should error");
});

// Watcher pure parts (no DB).
const { buildPrompt } = await import("../track/watch.ts");

Deno.test("buildPrompt frames the thread with the agent identity and instructions", () => {
  const prompt = buildPrompt({
    comment: {
      id: "r",
      author: "Julien",
      author_id: "u",
      body: "why?",
      updated_at: "",
    },
    page: { id: "p", title: "Release plan" },
    block: { id: "b", text: "Ship the release" },
    thread: [
      {
        id: "a",
        author: "Codex",
        author_id: AGENT_AUTHOR_ID,
        body: "clarify rollback",
        updated_at: "",
      },
      {
        id: "r",
        author: "Julien",
        author_id: "u",
        body: "why?",
        updated_at: "",
      },
    ],
    agent: "codex",
  });
  assertStringIncludes(prompt, "You are Codex");
  assertStringIncludes(prompt, 'page "Release plan"');
  assertStringIncludes(prompt, "> Ship the release");
  assertStringIncludes(prompt, "[Codex (you)] clarify rollback");
  assertStringIncludes(prompt, "[Julien] why?");
  assertStringIncludes(prompt, "Output ONLY the comment body");
});
