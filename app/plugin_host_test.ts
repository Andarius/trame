import { expect, test } from "bun:test";
import { testTempDir } from "./test_tmp.ts";

// The host is reachable by any local process: everything it serves must require the launch token.
test("plugin host answers only requests carrying its launch token", async () => {
  const tmp = testTempDir("trame-plugin-host-test-");
  const child = Bun.spawn([process.execPath, "plugin-host.ts"], {
    cwd: new URL(".", import.meta.url).pathname,
    env: {
      ...process.env,
      TRAME_PLUGIN_TOKEN: "launch-token",
      TRAME_PG_SOCKET: `${tmp}/socket`,
      TRAME_PG_SCHEMA_OWNED: "1",
      TRACKER_SETTINGS_FILE: `${tmp}/settings.json`,
      TRACKER_NODE_ID: "plugin-host-test",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
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
      expect(response.status, `${path} ${JSON.stringify(headers)}`).toStrictEqual(status);
    }
    await reader.cancel();
  } finally {
    await child.stdin.end(); // EOF on stdin is the host's exit signal
    expect(await child.exited).toStrictEqual(0);
  }
});
