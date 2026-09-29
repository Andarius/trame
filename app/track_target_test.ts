import { testTempDir } from "./test_tmp.ts";
// config reads the env at load — set it before importing the writer
const tmp = testTempDir("trame-track-target-");
Deno.env.set("TRACKER_PORT_FILE", `${tmp}/port.json`); // never written: no local app
Deno.env.set("TRACKER_SETTINGS_FILE", `${tmp}/settings.json`);
Deno.env.set("TRACKER_OUTBOX", `${tmp}/outbox.jsonl`);
Deno.env.set("TRACKER_TLS_DIR", `${tmp}/certs`);
Deno.env.set("TRACKER_CLAUDE_MAP", `${tmp}/claude-map.json`);
Deno.env.delete("TRACKER_HUB_API");
Deno.env.delete("TRACKER_HUB_API_TOKEN");
Deno.env.delete("CODEX_THREAD_ID");

import { assertEquals, assertRejects } from "@std/assert";
const { main } = await import("../track/track.ts");

const OUTBOX = `${tmp}/outbox.jsonl`;
const queued = () =>
  Deno.readTextFile(OUTBOX).then((t) => t.trim().split("\n").length).catch(() =>
    0
  );

// No local app: a reachable hub is the target. A hub rejection is final — a box
// without the app never drains the outbox, so queuing it would lose the write.
for (
  const [id, hubStatus, rejects, outboxLines] of [
    ["hub accepts", 200, false, 0],
    ["hub rejects", 403, true, 0],
    ["hub unreachable", null, false, 1],
    ["no hub configured", undefined, false, 1],
  ] as const
) {
  Deno.test(`track without a local app: ${id}`, async () => {
    await Deno.remove(OUTBOX).catch(() => {});
    const server = typeof hubStatus === "number"
      ? Deno.serve(
        { port: 0, onListen: () => {} },
        () =>
          Response.json(
            hubStatus === 200
              ? { id: "s1", specs_page_id: null }
              : { error: "no" },
            {
              status: hubStatus,
            },
          ),
      )
      : null;
    // a closed port stands in for an unreachable hub
    const url = server
      ? `http://127.0.0.1:${server.addr.port}`
      : "http://127.0.0.1:9";
    await Deno.writeTextFile(
      `${tmp}/settings.json`,
      JSON.stringify(
        hubStatus === undefined ? {} : { hubApi: url, hubApiToken: "t" },
      ),
    );
    try {
      const run = main([JSON.stringify({ title: "card", repo_path: "/r" })], {
        json: true,
      });
      if (rejects) {
        await assertRejects(() => run, Error, "the hub rejected the track");
      } else await run;
      assertEquals(await queued(), outboxLines);
    } finally {
      await server?.shutdown();
    }
  });
}
