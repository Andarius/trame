import { assert, assertEquals, assertStringIncludes } from "@std/assert";

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
    });
  } finally {
    await server.shutdown();
    await Deno.remove(tmp, { recursive: true });
  }
});
