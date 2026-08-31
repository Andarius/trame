import { assert, assertEquals, assertStringIncludes } from "@std/assert";

// The session watcher against a fake app: it must badge a comment "seen" at pickup and
// still exit after the quiet window. Regression guard — while "seen" claimed a comment
// (dropping it from the inbox), badging at pickup would have parked the watcher until
// --stale instead of handing the feedback over.
Deno.test("page watcher badges seen at pickup, claims answering, then exits", async () => {
  const statuses: string[] = [];
  let commentPolls = 0;
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
      if (pathname === "/api/pages") {
        return json([{ id: "p1", parent_id: null, title: "Plan" }]);
      }
      if (pathname === "/api/presence") {
        return req.method === "POST" ? json({ ok: true }) : json([]);
      }
      if (pathname === "/api/comments/inbox") {
        // the fixed inbox a non-suppressing "seen" produces: the item keeps surfacing
        return json([{
          comment: {
            id: "c1",
            body: "please clarify",
            updated_at: new Date().toISOString(),
          },
          page: { id: "p1", title: "Plan" },
          block: { id: "b1", text: "Ship it." },
          agent: "claude",
        }]);
      }
      if (pathname === "/api/comments") {
        // commenter is still typing on the first pass, quiet from the second on
        const at = commentPolls++ === 0
          ? new Date()
          : new Date(Date.now() - 600_000);
        return json([{ author_id: null, updated_at: at.toISOString() }]);
      }
      if (pathname === "/api/comments/c1/agent-status") {
        statuses.push((await req.json()).status);
        return json({ ok: true });
      }
      return json({ error: "not found" });
    },
  );

  const tmp = await Deno.makeTempDir({ prefix: "trame-page-watch-test-" });
  try {
    const portFile = `${tmp}/port.json`;
    await Deno.writeTextFile(portFile, JSON.stringify({ port: await ready }));
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "../track/page-watch.ts",
        "--page",
        "p1",
        "--interval",
        "1",
        "--quiet",
        "30",
      ],
      cwd: new URL(".", import.meta.url).pathname,
      env: { TRACKER_PORT_FILE: portFile },
      stdout: "piped",
      stderr: "piped",
    }).output();

    assert(out.success, new TextDecoder().decode(out.stderr));
    assertStringIncludes(new TextDecoder().decode(out.stdout), "feedback ready");
    // seen once despite two polls (a write per pass is sync churn), then the claim
    assertEquals(statuses, ["seen", "answering"]);
    assert(commentPolls >= 2, "should have waited out the active commenter");
  } finally {
    await server.shutdown();
    await Deno.remove(tmp, { recursive: true });
  }
});
