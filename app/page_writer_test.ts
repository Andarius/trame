import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";

Deno.test("page writer updates in place, keeping ids of unchanged blocks", async () => {
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
      if (pathname === "/api/pages/page-1" && req.method === "POST") {
        posted = await req.json();
        return json({ ok: true });
      }
      if (pathname === "/api/pages/page-1") {
        return json({
          id: "page-1",
          title: "Release plan",
          content: [
            { type: "heading", text: "Checklist", id: "block-1" },
            { type: "html", html: "<b>picker</b>", id: "html-1" },
            { type: "text", text: "Old paragraph.", id: "block-2" },
          ],
        });
      }
      return json({ error: "not found" });
    },
  );

  const tmp = await Deno.makeTempDir({ prefix: "trame-page-writer-test-" });
  try {
    const port = await ready;
    const portFile = `${tmp}/port.json`;
    await Deno.writeTextFile(portFile, JSON.stringify({ port }));
    const input = JSON.stringify({
      page_title: "Release plan",
      markdown: "## Checklist\n\nNew paragraph.",
    });
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "../track/page.ts", input],
      cwd: new URL(".", import.meta.url).pathname,
      env: { TRACKER_PORT_FILE: portFile },
      stdout: "piped",
      stderr: "piped",
    }).output();

    assert(out.success, new TextDecoder().decode(out.stderr));
    const stdout = new TextDecoder().decode(out.stdout);
    assertStringIncludes(stdout, "page page-1 updated");
    assertStringIncludes(stdout, "kept 1 of 2 block ids");

    const body = posted as { content: Record<string, unknown>[] } | null;
    assert(body);
    assertEquals(Object.keys(body), ["content"]);
    const content = body.content;
    assertEquals(content[0], {
      type: "heading",
      text: "Checklist",
      id: "block-1",
    });
    assertEquals(content[1], {
      type: "html",
      html: "<b>picker</b>",
      id: "html-1",
    });
    assertEquals(content[2].type, "text");
    assertEquals(content[2].text, "New paragraph.");
    assertMatch(String(content[2].id), /^[0-9a-f-]{36}$/);
  } finally {
    await server.shutdown();
    await Deno.remove(tmp, { recursive: true });
  }
});
