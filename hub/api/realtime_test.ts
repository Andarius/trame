// WS nudges against a really-served app (upgrade needs a live server) on PGlite.
import { assert, assertEquals } from "@std/assert";
import { PGlite } from "@electric-sql/pglite";
import type { DB, Q } from "./db.ts";
import { ensureAuthSchema, mintToken } from "./auth.ts";
import { createApp } from "./app.ts";
import { broadcast } from "./realtime.ts";

function pgliteAdapter(pg: PGlite): DB {
  const q = (h: { query: PGlite["query"] }): Q => ({
    query: async (text, params) =>
      (await h.query(text, params as unknown[])).rows as Record<
        string,
        unknown
      >[],
  });
  return {
    ...q(pg),
    transaction: (fn) =>
      pg.transaction((tx) => fn(q(tx as never))) as Promise<never>,
  };
}

const pg = new PGlite();
await pg.waitReady;
await pg.exec(
  await Deno.readTextFile(new URL("../../db/schema.sql", import.meta.url)),
);
const db = pgliteAdapter(pg);
await ensureAuthSchema(db);
const token = await mintToken(db, "ws-test");

const server = Deno.serve({ port: 0, onListen: () => {} }, createApp(db).fetch);
const base = `ws://127.0.0.1:${server.addr.port}`;

const open = (tok: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}/ws?token=${tok}`);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(e);
  });

const nextMessage = (
  ws: WebSocket,
  ms = 3000,
): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("no message within timeout")),
      ms,
    );
    ws.onmessage = (ev) => {
      clearTimeout(t);
      resolve(JSON.parse(String(ev.data)));
    };
  });

Deno.test("handshake rejects a bad token before upgrading", async () => {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${base}/ws?token=wrong`);
    ws.onerror = () => resolve(); // upgrade refused
    ws.onopen = () => reject(new Error("upgraded with a bad token"));
  });
});

Deno.test("hello with a stale cursor gets a catch-up nudge", async () => {
  await pg.query(
    `insert into pages (title, origin) values ('ws page', 'ws-test')`,
  );
  const ws = await open(token);
  const msg = nextMessage(ws);
  ws.send(JSON.stringify({ type: "hello", cursor: 0 }));
  const m = await msg;
  assertEquals(m.type, "changed");
  assert(Number(m.rev) > 0);
  ws.close();
});

Deno.test("hello with a current cursor stays silent; ping gets a pong", async () => {
  const head = (await pg.query(
    `select coalesce(max(rev),0)::bigint as rev from change_log`,
  )).rows[0] as { rev: string | number };
  const ws = await open(token);
  const msg = nextMessage(ws); // pong must be the FIRST reply — no spurious nudge
  ws.send(JSON.stringify({ type: "hello", cursor: Number(head.rev) }));
  ws.send(JSON.stringify({ type: "ping" }));
  assertEquals((await msg).type, "pong");
  ws.close();
});

Deno.test("broadcast nudges every connected socket", async () => {
  const [a, b] = [await open(token), await open(token)];
  const [ma, mb] = [nextMessage(a), nextMessage(b)];
  await broadcast(db);
  assertEquals((await ma).type, "changed");
  assertEquals((await mb).type, "changed");
  a.close();
  b.close();
  // let close frames land before the server shuts down
  await new Promise((r) => setTimeout(r, 100));
  await server.shutdown();
});
