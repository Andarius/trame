// Insights across devices: who may store and read usage, replace semantics, per-user isolation.
import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import type { DB, Q } from "./db.ts";
import { ensureAuthSchema, mintToken } from "./auth.ts";
import { createApp } from "./app.ts";
import { ensureUsageSchema } from "./usage.ts";

const MEMBER = "00000000-0000-4000-8000-000000000101"; // the seeded user

function pgliteAdapter(pg: PGlite): DB {
  const q = (h: { query: PGlite["query"] }): Q => ({
    query: async (text, params) => (await h.query(text, params as unknown[])).rows as Record<string, unknown>[],
  });
  return { ...q(pg), transaction: (fn) => pg.transaction((tx) => fn(q(tx as never))) as Promise<never> };
}

const pg = new PGlite();
await pg.waitReady;
await pg.exec(await Bun.file(new URL("../../db/schema.sql", import.meta.url)).text());
const db = pgliteAdapter(pg);
await ensureAuthSchema(db);
await ensureUsageSchema(db);
const app = createApp(db);

const device = async (node: string, user: string) => {
  await pg.query(`insert into devices (node_id, user_id, origin) values ($1, $2, 'test')`, [node, user]);
  return await mintToken(db, node);
};
const desk = await device("desk", MEMBER);
const laptop = await device("laptop", MEMBER);
const OTHER = ((await pg.query(
  `insert into users (name, role, origin) values ('Other', 'member', 'test') returning id`,
)).rows[0] as { id: string }).id;
const other = await device("other-desk", OTHER);
const GUEST = ((await pg.query(
  `insert into users (name, role, origin) values ('Guest', 'guest', 'test') returning id`,
)).rows[0] as { id: string }).id;
const guest = await device("guest-dev", GUEST);
const unbound = await mintToken(db, "unbound-dev");

const call = (path: string, token: string | null, body?: unknown) =>
  app.request(path, {
    method: body === undefined ? "GET" : "PUT",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const row = (d: string, prompts: number, tokens = 0, m: string | null = null) => ({
  d,
  p: null,
  r: "acme",
  a: "claude",
  m,
  prompts,
  tokens,
});

for (
  const [id, token, body, status] of [
    ["no token", null, undefined, 401],
    ["bad token", "nope", undefined, 401],
    ["guest read", guest, undefined, 403],
    ["guest write", guest, { from: "2026-10-01", rows: [] }, 403],
    ["unbound device", unbound, undefined, 403],
    ["bad day", desk, { from: "2026-10-1", rows: [] }, 400],
    ["negative count", desk, { from: "2026-10-01", rows: [row("2026-10-02", -1)] }, 400],
    ["member read", desk, undefined, 200],
  ] as const
) {
  test(`usage access: ${id}`, async () => {
    const res = await call("/usage?since=2026-01-01", token, body);
    await res.body?.cancel();
    expect(res.status).toStrictEqual(status);
  });
}

test("a push replaces the device's days from `from` on and sums duplicate keys", async () => {
  await call("/usage", laptop, {
    from: "2026-10-01",
    rows: [row("2026-10-01", 5), row("2026-10-02", 7), row("2026-10-03", 1, 900, "gpt-6-sol")],
  });
  const res = await call("/usage", laptop, {
    from: "2026-10-02",
    rows: [row("2026-10-01", 99), row("2026-10-02", 2), row("2026-10-02", 3)],
  });
  expect(await res.json()).toStrictEqual({ stored: 1 });
  const seen = await (await call("/usage?since=2026-10-01", desk)).json() as Record<string, unknown>[];
  // day 1 predates `from` and stays; day 2 is the sum; day 3 was dropped by the re-scan
  expect(seen.map((r) => [r.node_id, r.d, r.prompts, r.tokens])).toStrictEqual([
    ["laptop", "2026-10-01", 5, 0],
    ["laptop", "2026-10-02", 5, 0],
  ]);
});

test("a device reads only its user's other devices", async () => {
  await call("/usage", desk, { from: "2026-09-01", rows: [row("2026-09-05", 4)] });
  await call("/usage", other, { from: "2026-09-01", rows: [row("2026-09-05", 40)] });
  const nodes = async (token: string) =>
    [...new Set(((await (await call("/usage?since=2026-09-01", token)).json()) as { node_id: string }[]).map((r) => r.node_id))];
  expect(await nodes(desk)).toStrictEqual(["laptop"]);
  expect(await nodes(laptop)).toStrictEqual(["desk"]);
  expect(await nodes(other)).toStrictEqual([]);
});
