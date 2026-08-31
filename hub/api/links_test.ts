// The public link viewer on PGlite: scope, revocation, and what must never leak.
// Pages render client-side; the server ships a sanitized JSON payload + the
// viewer bundle, so the tests check the payload and the asset routes.
import { assert, assertEquals } from "@std/assert";
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

// deno-lint-ignore no-explicit-any
async function payloadOf(path: string): Promise<any> {
  const html = await (await app.request(path)).text();
  const m = html.match(/window\.__TRAME_LINK__ = (.*);<\/script>/);
  assert(m, "shell carries the injected payload");
  return JSON.parse(m[1]); // JSON.parse decodes the < escapes back to <
}

Deno.test("a valid link ships the page payload, database and viewer entry", async () => {
  const res = await app.request(`/l/${TOKEN}`);
  assertEquals(res.status, 200);
  const html = await res.text();
  assert(html.includes(`/l/assets/${LINK_ENTRY.js}`), "viewer bundle loaded");
  const p = await payloadOf(`/l/${TOKEN}`);
  assertEquals(p.page.title, "Roadmap");
  assertEquals(p.blocks[0], { type: "heading", text: "Q3 {{tab}}" });
  assertEquals(p.blocks[1], { type: "todo", text: "ship links", done: true });
  assertEquals(p.databases[DB_ID].rows[0].vals[PROP], "first task");
  assertEquals(p.attached, [DB_ID]);
  assertEquals(p.children, [{ id: SUB, title: "Sub Plan", icon: null }]);
  assertEquals(p.subpages[SUB].title, "Sub Plan");
});

Deno.test("page content can never break out of the inline script", async () => {
  const html = await (await app.request(`/l/${TOKEN}`)).text();
  assert(!html.includes("</script><b>"), "every < in content is escaped");
  const p = await payloadOf(`/l/${TOKEN}`);
  assertEquals(p.blocks[2].text, "hello </script><b>world</b>");
});

Deno.test("private fields never leak into the payload", async () => {
  const html = await (await app.request(`/l/${TOKEN}`)).text();
  assert(!html.includes("PICKED"), "html block data stripped");
  assert(!html.includes("secret-dir"), "folder blocks (local paths) stripped");
  assert(!html.includes("INTERNAL COMMENT"), "comments never appear");
  assert(!html.includes("Secret Page"), "out-of-scope subpage blocks dropped");
  const p = await payloadOf(`/l/${TOKEN}`);
  const sub = p.blocks.filter((b: { type: string }) => b.type === "subpage");
  assertEquals(sub.length, 1, "only the in-scope subpage block survives");
});

Deno.test("viewer assets are served with types and immutable caching", async () => {
  const res = await app.request(`/l/assets/${LINK_ENTRY.js}`);
  assertEquals(res.status, 200);
  assert(res.headers.get("content-type")!.includes("javascript"));
  assert(res.headers.get("cache-control")!.includes("immutable"));
  await res.body?.cancel();
  assertEquals((await app.request("/l/assets/nope.js")).status, 404);
});

Deno.test("sub-page renders in scope; a page outside the subtree 404s", async () => {
  const p = await payloadOf(`/l/${TOKEN}/p/${SUB}`);
  assertEquals(p.page.title, "Sub Plan");
  assertEquals(p.isRoot, false);
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
