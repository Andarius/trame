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
  const nodeId = Deno.args[1];
  if (!nodeId) {
    console.error("usage: main.ts mint <node-id>");
    Deno.exit(1);
  }
  console.log(await mintToken(db, nodeId));
  await sql.end();
  Deno.exit(0);
}

const PORT = Number(Deno.env.get("PORT") ?? "8443");
const app = createApp(db);

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
