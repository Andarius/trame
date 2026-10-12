import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import { socketPg } from "./pg.ts";

const socket = Deno.env.get("TRAME_TEST_PG_SOCKET");

Deno.test({
  name:
    "socket adapter preserves local query types and rolls back failed imports",
  ignore: !socket,
  async fn() {
    const pg = socketPg(socket!);
    try {
      await pg.exec(
        `create temporary table adapter_test (id int primary key, data jsonb);
        insert into adapter_test values (1, '{"seed":true}');`,
      );
      const data = [{ text: "page block" }];
      await pg.query(`insert into adapter_test values ($1,$2)`, [
        2,
        JSON.stringify(data),
      ]);
      const result = await pg.query<
        { data: unknown; n: number; amount: string; at: Date; ids: string[] }
      >(
        `select data, count(*) over () as n, 1.25::numeric as amount,
          '2026-10-11T12:00:00Z'::timestamptz as at, $1::uuid[] as ids
         from adapter_test where id=2`,
        [["a89f8286-e5d9-4931-9f52-9043726d61ea"]],
      );
      assertEquals(result.rows[0].data, data);
      assertEquals(result.rows[0].n, 1);
      assertEquals(result.rows[0].amount, "1.25");
      assertInstanceOf(result.rows[0].at, Date);
      assertEquals(result.rows[0].at.toISOString(), "2026-10-11T12:00:00.000Z");
      assertEquals(result.rows[0].ids, [
        "a89f8286-e5d9-4931-9f52-9043726d61ea",
      ]);
      await assertRejects(() =>
        pg.transaction(async (tx) => {
          await tx.query(`insert into adapter_test values (3, '{}')`);
          await tx.query(`insert into adapter_test values (1, '{}')`);
        })
      );
      assertEquals(
        [...(await pg.query(`select id from adapter_test order by id`)).rows],
        [{ id: 1 }, { id: 2 }],
      );
      assertEquals(
        await pg.transaction(async (tx) => {
          await tx.query(`insert into adapter_test values (3, '{}')`);
          return "committed";
        }),
        "committed",
      );
      assertEquals(
        [...(await pg.query(`select id from adapter_test where id=3`)).rows],
        [{ id: 3 }],
      );
    } finally {
      await pg.close();
    }
  },
});

Deno.test({
  name:
    "sidecar authenticates every path and offline mode never contacts the hub",
  ignore: !socket,
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "trame-sidecar-test-" });
    let hubRequests = 0;
    const hub = Deno.serve({
      port: 0,
      hostname: "127.0.0.1",
      onListen: () => {},
    }, () => {
      hubRequests++;
      return Response.json({});
    });
    const token = crypto.randomUUID();
    const portFile = `${root}/port.json`;
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--cached-only",
        "-A",
        new URL("./main.ts", import.meta.url).pathname,
      ],
      cwd: new URL(".", import.meta.url).pathname,
      clearEnv: true,
      env: {
        HOME: root,
        DENO_DIR: Deno.env.get("DENO_DIR") ??
          `${
            Deno.env.get("XDG_CACHE_HOME") ?? `${Deno.env.get("HOME")}/.cache`
          }/deno`,
        XDG_DATA_HOME: root,
        TRACKER_DATA_DIR: `${root}/pglite`,
        TRACKER_PORT_FILE: portFile,
        TRACKER_PORT: "0",
        TRACKER_SETTINGS_FILE: `${root}/settings.json`,
        TRACKER_HUB_API: `http://127.0.0.1:${hub.addr.port}`,
        TRACKER_HUB_API_TOKEN: "test-hub-token",
        TRAME_PG_SOCKET: socket!,
        TRAME_SIDECAR_TOKEN: token,
        TRAME_OFFLINE: "1",
      },
      stdout: "null",
      stderr: "inherit",
      stdin: "piped",
    }).spawn();
    let running = true;
    const childStatus = child.status.finally(() => {
      running = false;
    });
    try {
      const deadline = Date.now() + 20_000;
      let port = 0;
      while (!port && Date.now() < deadline) {
        port = await Deno.readTextFile(portFile).then((s) => JSON.parse(s).port)
          .catch(() => 0);
        if (!port) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!port) {
        throw new Error("sidecar did not publish its private readiness file");
      }
      assertEquals((await Deno.stat(portFile)).mode! & 0o777, 0o600);
      const base = `http://127.0.0.1:${port}`;
      for (
        const path of [
          "/",
          "/api/status",
          "/report/missing",
          "/report-file?path=missing",
        ]
      ) {
        for (
          const headers of [
            new Headers(),
            new Headers({ "x-trame-sidecar-token": "x".repeat(token.length) }),
          ]
        ) {
          const response = await fetch(`${base}${path}`, { headers });
          assertEquals(response.status, 401);
          await response.body?.cancel();
        }
      }
      const headers = { "x-trame-sidecar-token": token };
      const status = await fetch(`${base}/api/status`, { headers });
      assertEquals(status.status, 200);
      await status.body?.cancel();
      for (
        const [path, method] of [["/api/status", "GET"], [
          "/report-file",
          "POST",
        ]]
      ) {
        const csrf = await fetch(`${base}${path}`, {
          method,
          headers: { ...headers, origin: "https://attacker.invalid" },
        });
        assertEquals(csrf.status, 403);
        await csrf.body?.cancel();
      }
      const sync = await fetch(`${base}/api/sync`, { method: "POST", headers });
      assertEquals(await sync.json(), null);
      for (
        const path of [
          "/api/hub/test",
          "/api/update",
          "/api/plugins/deployments/refresh",
        ]
      ) {
        const response = await fetch(`${base}${path}`, {
          method: "POST",
          headers,
        });
        assertEquals(response.status, 503);
        await response.body?.cancel();
      }
      const update = await fetch(`${base}/api/update`, { headers });
      assertEquals((await update.json()).available, false);
      assertEquals(hubRequests, 0);
      await child.stdin.close();
      assertEquals((await childStatus).code, 0);
    } finally {
      try {
        if (running) child.kill("SIGTERM");
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) console.error(e);
      }
      await childStatus;
      await hub.shutdown();
      await Deno.remove(root, { recursive: true });
    }
  },
});
