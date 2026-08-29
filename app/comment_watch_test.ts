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

Deno.test("all mode surfaces first-contact comments, scoped by page", async () => {
  const pageId = await createPage({ title: "watch-all" });
  const pg = await db();
  await pg.query(`update pages set content=$2 where id=$1`, [
    pageId,
    JSON.stringify([{ type: "text", text: "the section", id: "blk" }]),
  ]);
  const id = await createComment({
    page_id: pageId,
    block_id: "blk",
    body: "please rework this section",
  });
  const find = (items: Awaited<ReturnType<typeof listCommentInbox>>) =>
    items.find((i) => i.comment.id === id);
  // the default inbox still requires a prior agent comment
  assertEquals(find(await listCommentInbox()), undefined);
  // all mode sees it, attributed to the default agent
  const item = find(await listCommentInbox(600, { all: true }));
  assert(item, "first-contact comment should surface in all mode");
  assertEquals(item.agent, "claude");
  // page filter: another page excludes it, its own page keeps it
  assertEquals(
    find(
      await listCommentInbox(600, { all: true, pages: [crypto.randomUUID()] }),
    ),
    undefined,
  );
  assert(find(await listCommentInbox(600, { all: true, pages: [pageId] })));
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
const {
  agentCommand,
  buildPrompt,
  parseAgentOutput,
  parseCodexDoctorModel,
} = await import("../track/watch.ts");

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

Deno.test("the built-in Codex runner requests a JSONL event stream", () => {
  const previous = Deno.env.get("TRAME_WATCH_CODEX_CMD");
  Deno.env.delete("TRAME_WATCH_CODEX_CMD");
  try {
    assertEquals(agentCommand("codex", "answer this"), {
      cmd: "codex",
      args: [
        "exec",
        "--json",
        "--sandbox",
        "read-only",
        "answer this",
      ],
      stdin: null,
    });
  } finally {
    if (previous === undefined) Deno.env.delete("TRAME_WATCH_CODEX_CMD");
    else Deno.env.set("TRAME_WATCH_CODEX_CMD", previous);
  }
});

Deno.test("--model reaches the built-in runners' args", () => {
  const saved = {
    codex: Deno.env.get("TRAME_WATCH_CODEX_CMD"),
    claude: Deno.env.get("TRAME_WATCH_CLAUDE_CMD"),
  };
  Deno.env.delete("TRAME_WATCH_CODEX_CMD");
  Deno.env.delete("TRAME_WATCH_CLAUDE_CMD");
  try {
    assertEquals(
      agentCommand("codex", "p", "gpt-5-codex").args,
      ["exec", "--json", "--sandbox", "read-only", "--model", "gpt-5-codex", "p"],
    );
    assertEquals(
      agentCommand("claude", "p", "opus").args,
      ["-p", "p", "--output-format", "json", "--model", "opus"],
    );
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      const name = `TRAME_WATCH_${k.toUpperCase()}_CMD`;
      if (v === undefined) Deno.env.delete(name);
      else Deno.env.set(name, v);
    }
  }
});

Deno.test("Codex JSONL yields its final message and non-duplicated token usage", () => {
  const stream = [
    { type: "thread.started", thread_id: "thread-1" },
    { type: "turn.started" },
    {
      type: "item.completed",
      item: { id: "item-1", type: "reasoning", text: "private" },
    },
    {
      type: "item.completed",
      item: {
        id: "item-2",
        type: "agent_message",
        text: "The rollback criterion is now explicit. ",
      },
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 24_763,
        cached_input_tokens: 24_448,
        output_tokens: 122,
        reasoning_output_tokens: 0,
      },
    },
  ].map((event) => JSON.stringify(event)).join("\n");

  assertEquals(parseAgentOutput("codex", stream, 4_200, "gpt-5.6-sol"), {
    body: "The rollback criterion is now explicit.",
    meta: { model: "gpt-5.6-sol", in: 24_763, out: 122, ms: 4_200 },
  });
});

Deno.test("Codex JSONL prefers a model emitted by the stream", () => {
  const stream = [
    JSON.stringify({ type: "turn.started", model: "gpt-5.7-codex" }),
    "not json, but harmless",
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "Final answer" },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 100, output_tokens: 20 },
    }),
  ].join("\n");

  assertEquals(parseAgentOutput("codex", stream, 900, "older-model"), {
    body: "Final answer",
    meta: { model: "gpt-5.7-codex", in: 100, out: 20, ms: 900 },
  });
});

Deno.test("an incomplete Codex stream is not posted as raw JSON", () => {
  const stream = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({ type: "turn.failed", error: { message: "boom" } }),
  ].join("\n");
  assertEquals(parseAgentOutput("codex", stream, 700), {
    body: "",
    meta: { model: "codex", in: undefined, out: undefined, ms: 700 },
  });
});

Deno.test("Claude single-object telemetry remains unchanged", () => {
  assertEquals(
    parseAgentOutput(
      "claude",
      JSON.stringify({
        result: "Use the previous release tag.",
        duration_ms: 3_800,
        usage: {
          input_tokens: 1_000,
          cache_read_input_tokens: 2_000,
          cache_creation_input_tokens: 300,
          output_tokens: 42,
        },
        modelUsage: { "claude-haiku-4-5-20251001": {} },
      }),
      4_000,
    ),
    {
      body: "Use the previous release tag.",
      meta: {
        model: "claude-haiku-4-5-20251001",
        in: 3_300,
        out: 42,
        ms: 3_800,
      },
    },
  );
});

Deno.test("Codex model is read from its redacted doctor report", () => {
  assertEquals(
    parseCodexDoctorModel(JSON.stringify({
      checks: {
        "config.load": { details: { model: "gpt-5.6-sol" } },
      },
    })),
    "gpt-5.6-sol",
  );
  assertEquals(parseCodexDoctorModel("not json"), undefined);
});
