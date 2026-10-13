import { assertEquals } from "@std/assert";
import { testTempDir } from "./test_tmp.ts";

// The host is reachable by any local process: everything it serves must require the launch token.
Deno.test("plugin host answers only requests carrying its launch token", async () => {
  const tmp = testTempDir("trame-plugin-host-test-");
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", "deno.json", "plugin-host.ts"],
    cwd: new URL(".", import.meta.url).pathname,
    env: {
      TRAME_PLUGIN_TOKEN: "launch-token",
      TRAME_PG_SOCKET: `${tmp}/socket`,
      TRAME_PG_SCHEMA_OWNED: "1",
      TRACKER_SETTINGS_FILE: `${tmp}/settings.json`,
      TRACKER_NODE_ID: "plugin-host-test",
    },
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  try {
    const reader = child.stdout.pipeThrough(new TextDecoderStream())
      .getReader();
    const { value } = await reader.read();
    const { port } = JSON.parse(value!.split("\n")[0]);
    const base = `http://127.0.0.1:${port}`;
    const cases: [string, Record<string, string>, number][] = [
      ["/host/manifests", {}, 403],
      ["/host/manifests", { "x-trame-plugin-token": "wrong" }, 403],
      ["/api/plugins/any/settings", {}, 403],
      ["/host/manifests", { "x-trame-plugin-token": "launch-token" }, 200],
    ];
    for (const [path, headers, status] of cases) {
      const response = await fetch(base + path, { headers });
      await response.body?.cancel();
      assertEquals(
        response.status,
        status,
        `${path} ${JSON.stringify(headers)}`,
      );
    }
    await reader.cancel();
  } finally {
    await child.stdin.close(); // EOF on stdin is the host's exit signal
    assertEquals((await child.status).code, 0);
  }
});
