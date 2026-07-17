// Hub API server (docs/hub-api.md, phase 3): the auth boundary in front of Postgres.
// Deno terminates TLS itself with the gen-certs.sh server cert — no reverse proxy
// until it earns its place. Also the token CLI:  main.ts mint <node-id>
import postgres from "postgres";
import { pgAdapter } from "./db.ts";
import { ensureAuthSchema, mintToken } from "./auth.ts";
import { createApp } from "./app.ts";

const sql = postgres(
  Deno.env.get("DATABASE_URL") ?? "postgres://tracker@tracker-db:5432/tracker",
  // onnotice: server NOTICEs otherwise land on stdout — where `mint` prints the token
  { max: 4, onnotice: () => {} },
);
const db = pgAdapter(sql);
await ensureAuthSchema(db);

if (Deno.args[0] === "mint") {
  const [, nodeId, explicitUser] = Deno.args;
  if (!nodeId) {
    console.error("usage: main.ts mint <node-id> [user-id]");
    Deno.exit(1);
  }
  // Bind the device to its user HERE: under ACLs an unbound token has no access,
  // and the binding must never be client-claimable (that would let any token
  // holder escalate to any user). Sole member = the default; otherwise explicit.
  const bound = await db.query(
    `select user_id from devices where node_id=$1 and not deleted limit 1`,
    [nodeId],
  );
  if (!bound.length) {
    const members = await db.query(
      `select id from users where role='member' and not deleted`,
    );
    const userId = explicitUser ??
      (members.length === 1 ? members[0].id as string : null);
    if (!userId) {
      console.error(
        `several members exist — pass one: main.ts mint ${nodeId} <user-id>`,
      );
      Deno.exit(1);
    }
    await db.query(
      `insert into devices (node_id, user_id, origin) values ($1, $2, 'hub-api')`,
      [nodeId, userId],
    );
  }
  console.log(await mintToken(db, nodeId));
  await sql.end();
  Deno.exit(0);
}

// Onboard a guest in one step: user (role=guest) + device mapping + token.
// They install Trame and put hubApi + this token in settings.json — done.
if (Deno.args[0] === "invite") {
  const [, name, nodeId] = Deno.args;
  if (!name || !nodeId) {
    console.error("usage: main.ts invite <display-name> <node-id>");
    Deno.exit(1);
  }
  const u = await db.query(
    `insert into users (name, role, origin) values ($1, 'guest', 'hub-api') returning id`,
    [name],
  );
  await db.query(
    `insert into devices (node_id, user_id, origin) values ($1, $2, 'hub-api')`,
    [nodeId, u[0].id as string],
  );
  const token = await mintToken(db, nodeId);
  console.error(
    `guest '${name}' (${u[0].id}) invited for device '${nodeId}' — token:`,
  );
  console.log(token);
  await sql.end();
  Deno.exit(0);
}

const PORT = Number(Deno.env.get("PORT") ?? "8443");
const app = createApp(db);

// ONE LISTEN connection between PG and the API (never one per laptop) — the
// change_log triggers NOTIFY 'changes'; debounce bursts, then nudge every socket.
const { broadcast } = await import("./realtime.ts");
let nudgeTimer: ReturnType<typeof setTimeout> | undefined;
await sql.listen("changes", () => {
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => broadcast(db).catch(console.error), 200);
});

let tls: { cert: string; key: string } | undefined;
try {
  tls = {
    cert: await Deno.readTextFile(
      Deno.env.get("TRACKER_API_CERT") ?? "/certs/server.crt",
    ),
    key: await Deno.readTextFile(
      Deno.env.get("TRACKER_API_KEY") ?? "/certs/server.key",
    ),
  };
} catch {
  console.warn("no TLS cert/key found — serving plain HTTP (dev only)");
}

Deno.serve({ port: PORT, hostname: "0.0.0.0", ...tls }, app.fetch);

// Public link viewer on its OWN port: only /l/* exists here, so a reverse proxy /
// port-forward can expose it to the internet without ever exposing /sync or /ws.
const PUBLIC_PORT = Number(Deno.env.get("TRACKER_API_PUBLIC_PORT") ?? "8444");
const { createLinkApp } = await import("./links.ts");
Deno.serve(
  { port: PUBLIC_PORT, hostname: "0.0.0.0", ...tls },
  createLinkApp(db).fetch,
);
