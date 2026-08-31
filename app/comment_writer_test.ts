import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { addComment } from "../track/comment.ts";

Deno.test("comment writer resolves page and block text and detects Codex", async () => {
  let posted: Record<string, unknown> | null = null;
  let listening!: (port: number) => void;
  const ready = new Promise<number>((resolve) => listening = resolve);
  const json = (data: unknown) =>
    new Response(JSON.stringify(data), {
      headers: { "content-type": "application/json" },
    });
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen: ({ port }) => listening(port),
    },
    async (req) => {
      const { pathname } = new URL(req.url);
      if (pathname === "/api/pages") {
        return json([{ id: "page-1", title: "Release plan" }]);
      }
      if (pathname === "/api/pages/page-1") {
        return json({
          id: "page-1",
          title: "Release plan",
          content: [
            { type: "heading", text: "Checklist", id: "block-1" },
            {
              type: "text",
              text: "Ship the first release safely.",
              id: "block-2",
            },
          ],
        });
      }
      if (pathname === "/api/comments" && req.method === "POST") {
        posted = await req.json();
        return json({ id: "comment-1" });
      }
      return json({ error: "not found" });
    },
  );

  const tmp = await Deno.makeTempDir({ prefix: "trame-comment-writer-test-" });
  try {
    const port = await ready;
    const portFile = `${tmp}/port.json`;
    await Deno.writeTextFile(portFile, JSON.stringify({ port }));
    const input = JSON.stringify({
      page_title: "Release plan",
      block_text: "safely",
      body: "Clarify the rollback criterion.",
      meta: { model: "gpt-5.6-sol", in: 12894, out: 512, ms: 8300 },
    });
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "../track/comment.ts", input],
      cwd: new URL(".", import.meta.url).pathname,
      env: {
        TRACKER_PORT_FILE: portFile,
        CODEX_THREAD_ID: "00000000-0000-4000-8000-000000000001",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();

    assert(out.success, new TextDecoder().decode(out.stderr));
    assertStringIncludes(new TextDecoder().decode(out.stdout), "comment-1");
    assertEquals(posted, {
      page_id: "page-1",
      block_id: "block-2",
      anchor: "Ship the first release safely.",
      body: "Clarify the rollback criterion.",
      agent: "codex",
      meta: { model: "gpt-5.6-sol", in: 12894, out: 512, ms: 8300 },
    });
  } finally {
    await server.shutdown();
    await Deno.remove(tmp, { recursive: true });
  }
});

// claude and codex both surface their own usage, so a bare footer is a bug, not a limit.
Deno.test("meta.model is always required; claude and codex must send stats too", async () => {
  let listening!: (port: number) => void;
  const ready = new Promise<number>((resolve) => listening = resolve);
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: ({ port }) => listening(port) },
    (req) =>
      new Response(
        JSON.stringify(
          new URL(req.url).pathname === "/api/comments"
            ? { id: "comment-9" }
            : {
              id: "page-1",
              title: "Release plan",
              content: [{ type: "text", text: "Ship it.", id: "block-1" }],
            },
        ),
        { headers: { "content-type": "application/json" } },
      ),
  );

  try {
    const base = `http://127.0.0.1:${await ready}`;
    const post = (agent: string, meta?: Record<string, unknown>) =>
      addComment(
        { page_id: "page-1", block_id: "block-1", body: "Answered.", agent, meta },
        base,
      );
    const cases: [string, string | undefined, Record<string, unknown> | undefined][] = [
      ["claude with no meta", "meta.model is required", undefined],
      ["claude missing token counts", "meta.in is required", { model: "claude-opus-5" }],
      ["codex missing elapsed time", "meta.ms is required", {
        model: "gpt-5.6-sol",
        in: 10,
        out: 5,
      }],
      // an agent whose harness hides its usage may still comment with the model alone
      ["glm with model only", undefined, { model: "glm-5" }],
    ];
    for (const [name, wanted, meta] of cases) {
      const agent = name.startsWith("codex") ? "codex" : name.startsWith("glm") ? "glm" : "claude";
      const err = await post(agent, meta).then(() => null, (e: Error) => e.message);
      if (wanted) assertStringIncludes(err ?? "", wanted, name);
      else assertEquals(err, null, name);
    }
  } finally {
    await server.shutdown();
  }
});

Deno.test("in_reply_to brackets the reply with answering/answered", async () => {
  const calls: string[] = [];
  let listening!: (port: number) => void;
  const ready = new Promise<number>((resolve) => listening = resolve);
  const json = (data: unknown) =>
    new Response(JSON.stringify(data), {
      headers: { "content-type": "application/json" },
    });
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: ({ port }) => listening(port) },
    async (req) => {
      const { pathname } = new URL(req.url);
      if (pathname === "/api/pages/page-1") {
        return json({
          id: "page-1",
          title: "Release plan",
          content: [{ type: "text", text: "Ship it.", id: "block-1" }],
        });
      }
      if (pathname === "/api/comments" && req.method === "POST") {
        calls.push("post");
        return json({ id: "comment-2" });
      }
      if (pathname === "/api/comments/comment-1/agent-status") {
        calls.push((await req.json()).status);
        return json({ ok: true });
      }
      return json({ error: "not found" });
    },
  );

  try {
    const base = `http://127.0.0.1:${await ready}`;
    const res = await addComment({
      page_id: "page-1",
      block_id: "block-1",
      body: "Answered.",
      agent: "claude",
      in_reply_to: "comment-1",
      meta: { model: "claude-opus-5", in: 4210, out: 118, ms: 5400 },
    }, base);
    assertEquals(res.id, "comment-2");
    assertEquals(calls, ["answering", "post", "answered"]);
  } finally {
    await server.shutdown();
  }
});
