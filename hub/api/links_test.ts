// The public link viewer on PGlite: scope, revocation, and what must never leak.
// Pages render client-side; the server ships a sanitized JSON payload + the
// viewer bundle, so the tests check the payload and the asset routes.
import { afterAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import type { Q } from "./db.ts";
import { createLinkApp } from "./links.ts";
import { LINK_ENTRY } from "./link-embed.ts";

function q(pg: PGlite): Q {
  return {
    query: async (text, params) =>
      (await pg.query(text, params as unknown[])).rows as Record<
        string,
        unknown
      >[],
  };
}

const pg = new PGlite();
await pg.waitReady;
await pg.exec(
  await Bun.file(new URL("../../db/schema.sql", import.meta.url)).text(),
);

const TOKEN = "test-link-token-abc";
const hash = Array.from(
  new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(TOKEN)),
  ),
).map((b) => b.toString(16).padStart(2, "0")).join("");

const ROOT = "00000000-0000-4000-8000-0000000000f1";
const SUB = "00000000-0000-4000-8000-0000000000f2";
const PRIVATE = "00000000-0000-4000-8000-0000000000f3";
const DB_ID = "00000000-0000-4000-8000-0000000000f4";
await pg.query(
  `insert into pages (id, title, brief, content, origin) values
   ($1, 'Roadmap', 'the plan', '[{"type":"heading","text":"Q3 {{tab}}"},{"type":"todo","text":"ship links","done":true},{"type":"text","text":"hello </script><b>world</b>"},{"type":"folder","path":"/home/me/secret-dir"},{"type":"subpage","page_id":"00000000-0000-4000-8000-0000000000f2"},{"type":"subpage","page_id":"00000000-0000-4000-8000-0000000000f3"},{"type":"html","html":"<h1>Widget</h1>","height":222,"data":{"secret":"PICKED"}}]', 't'),
   ($2, 'Sub Plan', '', '[]', 't'),
   ($3, 'Secret Page', '', '[]', 't')`,
  [ROOT, SUB, PRIVATE],
);
await pg.query(`update pages set parent_id=$1 where id=$2`, [ROOT, SUB]);
await pg.query(
  `insert into udb_databases (id, name, page_id, origin) values ($1, 'Tasks', $2, 't')`,
  [DB_ID, ROOT],
);
const PROP = "00000000-0000-4000-8000-0000000000f5";
await pg.query(
  `insert into udb_properties (id, db_id, name, type, sort_key, origin) values ($1, $2, 'Title', 'title', 'a0', 't')`,
  [PROP, DB_ID],
);
const SELECT_PROP = "00000000-0000-4000-8000-0000000000f7";
await pg.query(
  `insert into udb_properties (id, db_id, name, type, config, sort_key, origin)
   values ($1, $2, 'Stage', 'select', $3, 'a1', 't')`,
  [
    SELECT_PROP,
    DB_ID,
    JSON.stringify({
      options: [{ id: "o1", name: "doing", color: "#fff" }],
    }),
  ],
);
await pg.query(
  `insert into udb_rows (db_id, vals, sort_key, origin) values ($1, $2, 'a0', 't')`,
  [DB_ID, JSON.stringify({ [PROP]: "first task", [SELECT_PROP]: "o1" })],
);
// legacy row: postgres.js stored the JSON as a jsonb *string* (see links.ts asJson)
await pg.query(
  `insert into udb_rows (db_id, vals, sort_key, origin) values ($1, to_jsonb($2::text), 'a1', 't')`,
  [DB_ID, JSON.stringify({ [PROP]: "double-encoded" })],
);
await pg.query(
  `insert into page_comments (page_id, block_id, body, origin) values ($1, 'b', 'INTERNAL COMMENT', 't')`,
  [ROOT],
);
await pg.query(
  `insert into page_links (page_id, token_hash, origin) values ($1, $2, 't')`,
  [ROOT, hash],
);

const app = createLinkApp(q(pg));

// deno-lint-ignore no-explicit-any
async function payloadOf(path: string): Promise<any> {
  const html = await (await app.request(path)).text();
  const m = html.match(/window\.__TRAME_LINK__ = (.*);<\/script>/);
  expect(m).toBeTruthy();
  return JSON.parse(m![1]); // JSON.parse decodes the < escapes back to <
}

test("a valid link ships the page payload, database and viewer entry", async () => {
  const res = await app.request(`/l/${TOKEN}`);
  expect(res.status).toStrictEqual(200);
  const html = await res.text();
  expect(html.includes(`/l/assets/${LINK_ENTRY.js}`)).toBeTruthy();
  const p = await payloadOf(`/l/${TOKEN}`);
  expect(p.page.title).toStrictEqual("Roadmap");
  expect(p.blocks[0]).toStrictEqual({ type: "heading", text: "Q3 {{tab}}" });
  expect(p.blocks[1]).toStrictEqual({ type: "todo", text: "ship links", done: true });
  expect(p.databases[DB_ID].rows[0].vals[PROP]).toStrictEqual("first task");
  // both the live shape and a double-encoded legacy row reach the viewer as values
  expect(p.databases[DB_ID].rows[1].vals[PROP]).toStrictEqual("double-encoded");
  expect(p.databases[DB_ID].props[1].config.options[0].name).toStrictEqual("doing");
  expect(p.attached).toStrictEqual([DB_ID]);
  expect(p.children).toStrictEqual([{ id: SUB, title: "Sub Plan", icon: null }]);
  expect(p.subpages[SUB].title).toStrictEqual("Sub Plan");
});

test("page content can never break out of the inline script", async () => {
  const html = await (await app.request(`/l/${TOKEN}`)).text();
  expect(!html.includes("</script><b>")).toBeTruthy();
  const p = await payloadOf(`/l/${TOKEN}`);
  expect(p.blocks[2].text).toStrictEqual("hello </script><b>world</b>");
});

test("private fields never leak into the payload", async () => {
  const html = await (await app.request(`/l/${TOKEN}`)).text();
  expect(!html.includes("PICKED")).toBeTruthy();
  expect(!html.includes("secret-dir")).toBeTruthy();
  expect(!html.includes("INTERNAL COMMENT")).toBeTruthy();
  expect(!html.includes("Secret Page")).toBeTruthy();
  const p = await payloadOf(`/l/${TOKEN}`);
  const sub = p.blocks.filter((b: { type: string }) => b.type === "subpage");
  expect(sub.length).toStrictEqual(1);
});

test("viewer assets are served with types and immutable caching", async () => {
  const res = await app.request(`/l/assets/${LINK_ENTRY.js}`);
  expect(res.status).toStrictEqual(200);
  expect(res.headers.get("content-type")!.includes("javascript")).toBeTruthy();
  expect(res.headers.get("cache-control")!.includes("immutable")).toBeTruthy();
  await res.body?.cancel();
  expect((await app.request("/l/assets/nope.js")).status).toStrictEqual(404);
});

test("sub-page renders in scope; a page outside the subtree 404s", async () => {
  const p = await payloadOf(`/l/${TOKEN}/p/${SUB}`);
  expect(p.page.title).toStrictEqual("Sub Plan");
  expect(p.isRoot).toStrictEqual(false);
  expect((await app.request(`/l/${TOKEN}/p/${PRIVATE}`)).status).toStrictEqual(404);
});

test("unknown and revoked tokens 404", async () => {
  expect((await app.request(`/l/nope`)).status).toStrictEqual(404);
  await pg.query(`update page_links set deleted=true where token_hash=$1`, [
    hash,
  ]);
  expect((await app.request(`/l/${TOKEN}`)).status).toStrictEqual(404);
  await pg.query(`update page_links set deleted=false where token_hash=$1`, [
    hash,
  ]);
});

afterAll(() => pg.close());
