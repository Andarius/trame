// Comment links on PGlite: who may mint, what the public /l/c routes gate on, and
// what must never leak to a public page.
import { afterAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import type { DB, Q } from "./db.ts";
import { ensureAuthSchema, mintToken } from "./auth.ts";
import { createApp } from "./app.ts";
import { createLinkApp } from "./links.ts";
import { Hono } from "hono";
import {
  ensureCommentLinkSchema,
  mountCommentLinkRoutes,
} from "./comment-links.ts";

const MEMBER = "00000000-0000-4000-8000-000000000101";
const AGENT = "00000000-0000-4000-8000-0000000000aa";
const PAGE = "00000000-0000-4000-8000-0000000000c1";
const SITE = "https://demo.sites.example";
const VISITOR = "visitor-aaaaaaaaaaaaaaaa";

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
  await Bun.file(new URL("../../db/schema.sql", import.meta.url)).text(),
);
const db = pgliteAdapter(pg);
await ensureAuthSchema(db);
await ensureCommentLinkSchema(db);
const api = createApp(db);
const pub = createLinkApp(db);

await pg.query(
  `insert into devices (node_id, user_id, origin) values ('member-dev', $1, 't')`,
  [MEMBER],
);
const memberToken = await mintToken(db, "member-dev");
const GUEST = ((await pg.query(
  `insert into users (name, role, origin) values ('Guest', 'guest', 't') returning id`,
)).rows[0] as { id: string }).id;
await pg.query(
  `insert into devices (node_id, user_id, origin) values ('guest-dev', $1, 't')`,
  [GUEST],
);
const guestToken = await mintToken(db, "guest-dev");

const mint = (token: string, body: unknown) =>
  api.request("/api/comment-links", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

const { id: LINK_ID, token: LINK } =
  await (await mint(memberToken, { page_id: PAGE, origins: [SITE] })).json();
const expired =
  await (await mint(memberToken, { page_id: PAGE, origins: [SITE] }))
    .json();
await pg.query(
  `update comment_links set expires_at = now() - interval '1 second' where id=$1`,
  [expired.id],
);

const call = (
  path: string,
  { link = LINK, origin = SITE, body, visitor = VISITOR }: {
    link?: string;
    origin?: string;
    body?: unknown;
    visitor?: string;
  } = {},
) =>
  pub.request(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      origin,
      "x-hc-link": link,
      "x-hc-visitor": visitor,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const comment = (over: Record<string, unknown> = {}) => ({
  block_id: "html:abc123def456",
  anchor: "§ Model — “price_lines”",
  body: "is this replacing article_prices?",
  name: "Carlo",
  meta: {
    html: { quote: "price_lines", prefix: "", suffix: "", heading: "Model" },
  },
  ...over,
});

test.each([
  ["member", memberToken, { page_id: PAGE, origins: [SITE] }, 200],
  [
    "guest without edit access",
    guestToken,
    { page_id: PAGE, origins: [SITE] },
    403,
  ],
  ["no origins", memberToken, { page_id: PAGE, origins: [] }, 400],
  [
    "origin with a path",
    memberToken,
    { page_id: PAGE, origins: [`${SITE}/x`] },
    400,
  ],
  ["file:// pages", memberToken, { page_id: PAGE, origins: ["null"] }, 200],
  [
    "custom ttl",
    memberToken,
    { page_id: PAGE, origins: [SITE], ttl_days: 7 },
    200,
  ],
  [
    "zero ttl",
    memberToken,
    { page_id: PAGE, origins: [SITE], ttl_days: 0 },
    400,
  ],
  ["ttl over a year", memberToken, {
    page_id: PAGE,
    origins: [SITE],
    ttl_days: 400,
  }, 400],
])("mint: %s → %d", async (_, token, body, status) => {
  expect((await mint(token, body)).status).toBe(status);
});

test.each([
  ["unknown token", { link: "nope" }, 401],
  ["expired link", { link: expired.token }, 401],
  ["foreign origin", { origin: "https://evil.example" }, 403],
  ["missing name", { body: comment({ name: " " }) }, 400],
  ["missing visitor", { body: comment(), visitor: "short" }, 400],
  ["non-thread block", { body: comment({ block_id: "b1" }) }, 400],
] as [string, Parameters<typeof call>[1] & {}, number][])(
  "public gate: %s → %d",
  async (_, opts, status) => {
    const res = await call(opts.body ? "/l/c/comments" : "/l/c/threads", opts);
    expect(res.status).toBe(status);
  },
);

test("writes are capped per link, whatever the caller claims to be", async () => {
  const limited = new Hono();
  mountCommentLinkRoutes(limited, db, [[2, 60_000]]);
  const post = (ip: string) =>
    limited.request("/l/c/comments", {
      method: "POST",
      headers: { origin: SITE, "x-hc-link": LINK, "x-forwarded-for": ip },
      body: "{}",
    });
  expect([
    (await post("1.1.1.1")).status,
    (await post("2.2.2.2")).status,
    (await post("3.3.3.3")).status,
  ]).toEqual([400, 400, 429]);
});

test("preflight only answers origins some live link allows", async () => {
  const pre = (origin: string) =>
    pub.request("/l/c/threads", { method: "OPTIONS", headers: { origin } });
  expect((await pre(SITE)).headers.get("access-control-allow-origin")).toBe(
    SITE,
  );
  expect((await pre("https://evil.example")).status).toBe(403);
});

test("a posted comment lands on the linked page, tagged by visitor, without leaking ids", async () => {
  expect((await call("/l/c/comments", { body: comment() })).status).toBe(200);
  // same name from another browser gets another tag
  expect(
    (await call("/l/c/comments", {
      body: comment(),
      visitor: "visitor-bbbbbbbbbbbbbbbb",
    })).status,
  ).toBe(200);
  await pg.query(
    `insert into page_comments (page_id, block_id, body, author, author_id, meta, origin)
     values ($1, 'html:abc123def456', 'agent answer', 'claude', $2, '{"model":"claude-opus-5-5","in":10}', 't'),
            ($1, 'b-other', 'block comment', 'Julien', $3, null, 't')`,
    [PAGE, AGENT, MEMBER],
  );

  const res = await call("/l/c/threads");
  expect(res.headers.get("access-control-allow-origin")).toBe(SITE);
  const rows = await res.json() as Record<string, unknown>[];
  expect(rows.map((r) => [r.author, r.author_id])).toEqual([["Carlo", null], [
    "Carlo",
    null,
  ], ["claude", AGENT]]);
  const tags = rows.slice(0, 2).map((r) =>
    (r.meta as Record<string, unknown>).visitor_tag
  );
  expect(new Set(tags).size).toBe(2);
  expect(JSON.stringify(rows)).not.toContain(VISITOR);

  const stored = (await pg.query(
    `select c.origin, l.source from page_comments c join change_log l on l.row_id = c.id where c.author='Carlo'`,
  )).rows;
  expect(stored).toEqual([{ origin: "hub-link", source: "link" }, {
    origin: "hub-link",
    source: "link",
  }]);
});

test("resolve flips the whole thread, and a revoked link stops working", async () => {
  const res = await call("/l/c/threads/resolve", {
    body: { block_id: "html:abc123def456", resolved: true },
  });
  expect(await res.json()).toEqual({ updated: 3 });

  const revoke = await api.request(`/api/comment-links/${LINK_ID}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${memberToken}` },
  });
  expect(revoke.status).toBe(200);
  expect((await call("/l/c/threads")).status).toBe(401);
});

afterAll(async () => await pg.close());
