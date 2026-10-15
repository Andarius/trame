// Out-of-process host for HOST_PLUGINS (sql-source + plugins.local.json). The native app
// spawns the compiled binary, reads {"port"} from its first stdout line and forwards
// /api/plugins/<id>/* with a per-launch token; plugins reach the app's PostgreSQL over its socket.
import {
  handlePluginRoute,
  HOST_PLUGINS,
  listPluginManifests,
  startPlugins,
} from "./plugins/index.ts";
import { LOCAL_MARK_ROLES } from "../core/mark-roles.gen.ts";

const token = Deno.env.get("TRAME_PLUGIN_TOKEN");
if (!token || !Deno.env.get("TRAME_PG_SOCKET")) {
  console.error(
    "plugin-host: TRAME_PLUGIN_TOKEN and TRAME_PG_SOCKET are required",
  );
  Deno.exit(2);
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

const server = Deno.serve({
  hostname: "127.0.0.1",
  port: 0,
  onListen: ({ port }) => console.log(JSON.stringify({ port })),
}, async (req) => {
  if (req.headers.get("x-trame-plugin-token") !== token) {
    return json({ error: "forbidden" }, 403);
  }
  const url = new URL(req.url);
  if (url.pathname === "/host/manifests") {
    return json(await listPluginManifests(HOST_PLUGINS));
  }
  if (url.pathname === "/host/mark-roles") {
    return json(
      LOCAL_MARK_ROLES.map((r) => ({
        mark: r.mark,
        value: r.value.source,
        role: r.role,
      })),
    );
  }
  if (url.pathname.startsWith("/api/plugins/")) {
    try {
      return await handlePluginRoute(req, url, HOST_PLUGINS);
    } catch (e) {
      console.error("plugin-host:", e);
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }
  return json({ error: "not found" }, 404);
});

// the app holds our stdin open for its lifetime: EOF means it is gone
(async () => {
  for await (const _ of Deno.stdin.readable) { /* nothing is sent */ }
  Deno.exit(0);
})();

startPlugins(HOST_PLUGINS);
await server.finished;
