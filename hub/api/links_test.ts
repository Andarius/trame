// The public link viewer on PGlite: scope, revocation, and what must never leak.
import { assert, assertEquals } from "@std/assert";
import { PGlite } from "@electric-sql/pglite";
import type { Q } from "./db.ts";
import { createLinkApp } from "./links.ts";

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
  await Deno.readTextFile(new URL("../../db/schema.sql", import.meta.url)),
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
  `insert into pages (id, title, story, content, origin) values
   ($1, 'Roadmap', 'the plan', '[{"type":"heading","text":"Q3"},{"type":"todo","text":"ship links","done":true},{"type":"text","text":"hello <world>"},{"type":"html","html":"<h1>Widget</h1><script>alert(1)</script>","height":222,"data":{"secret":"PICKED"}}]', 't'),
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
await pg.query(
  `insert into udb_rows (db_id, vals, sort_key, origin) values ($1, $2, 'a0', 't')`,
  [DB_ID, JSON.stringify({ [PROP]: "first task" })],
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

Deno.test("a valid link renders the page, its blocks, database and sub-page link", async () => {
  const res = await app.request(`/l/${TOKEN}`);
  assertEquals(res.status, 200);
  const html = await res.text();
  assert(html.includes("Roadmap"));
  assert(html.includes("Q3"));
  assert(html.includes("☑ ship links"));
  assert(html.includes("hello &lt;world&gt;"), "content is escaped");
  assert(html.includes("first task"), "attached database rendered");
  assert(html.includes(`/l/${TOKEN}/p/${SUB}`), "sub-page navigable");
});

Deno.test("html blocks render as sandboxed iframes, never raw in the page DOM", async () => {
  const html = await (await app.request(`/l/${TOKEN}`)).text();
  assert(html.includes('sandbox="allow-scripts"'));
  assert(
    html.includes("&lt;h1&gt;Widget&lt;/h1&gt;"),
    "doc escaped into srcdoc",
  );
  assert(!html.includes("<h1>Widget</h1>"), "doc never injected raw");
  assert(html.includes("height:222px"), "pinned height honored");
  assert(html.includes("data-pinned"), "pinned blocks opt out of auto-height");
  assert(html.includes("window.trame"), "bridge injected");
  assert(!html.includes("PICKED"), "persisted block data never rendered");
});

Deno.test("comments and out-of-scope pages never appear", async () => {
  const html = await (await app.request(`/l/${TOKEN}`)).text();
  assert(!html.includes("INTERNAL COMMENT"));
  assert(!html.includes("Secret Page"));
});

Deno.test("sub-page renders in scope; a page outside the subtree 404s", async () => {
  assertEquals((await app.request(`/l/${TOKEN}/p/${SUB}`)).status, 200);
  assertEquals((await app.request(`/l/${TOKEN}/p/${PRIVATE}`)).status, 404);
});

Deno.test("unknown and revoked tokens 404", async () => {
  assertEquals((await app.request(`/l/nope`)).status, 404);
  await pg.query(`update page_links set deleted=true where token_hash=$1`, [
    hash,
  ]);
  assertEquals((await app.request(`/l/${TOKEN}`)).status, 404);
  await pg.query(`update page_links set deleted=false where token_hash=$1`, [
    hash,
  ]);
});
