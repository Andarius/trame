// Public read-only link views (shareable URLs). Served by a SEPARATE listener so
// the sync API never faces the internet. The token is the capability: sha-256
// looked up in page_links, revocable. Scope is the linked page's subtree +
// attached databases. Comments are NEVER rendered here.
//
// Pages render client-side with the app's own components: the shell injects a
// sanitized JSON payload (window.__TRAME_LINK__) and loads the link viewer
// bundle (app/web `npm run build:link`, embedded here via link-embed.ts) — so a
// shared page looks exactly like it does in the app, {{tab}} sections included.
import { type Context, Hono } from "hono";
import { LINK_ASSETS, LINK_ENTRY } from "./link-embed.ts";
import type { Q } from "./db.ts";

type Row = Record<string, unknown>;
type Json = Record<string, unknown>;

async function sha256hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s),
  );
  return Array.from(new Uint8Array(digest)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

const esc = (s: unknown): string =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

async function linkedRoot(db: Q, token: string): Promise<string | null> {
  const rows = await db.query(
    `select page_id from page_links where token_hash=$1 and not deleted limit 1`,
    [await sha256hex(token)],
  );
  return (rows[0]?.page_id as string | undefined) ?? null;
}

async function subtreePages(db: Q, root: string): Promise<Map<string, Row>> {
  const rows = await db.query(
    `with recursive tree (id) as (
       select id from pages where id = $1 and not deleted
       union
       select p.id from pages p join tree t on p.parent_id = t.id
        where not p.deleted
     )
     select p.id, p.parent_id, p.title, p.icon, p.brief, p.content, p.sort_key
       from pages p join tree t on t.id = p.id`,
    [root],
  );
  return new Map(rows.map((r) => [String(r.id), r]));
}

// derived columns (formula/rollup/relation) are computed by the app — not here
const HIDDEN_PROPS = ["formula", "rollup", "relation"];

async function dbPayload(db: Q, dbId: string): Promise<Json | null> {
  const meta = await db.query(
    `select name, icon from udb_databases where id=$1 and not deleted`,
    [dbId],
  );
  if (!meta.length) return null;
  const props = await db.query(
    `select id, name, type, config from udb_properties where db_id=$1 and not deleted order by sort_key`,
    [dbId],
  );
  const rows = await db.query(
    `select icon, vals from udb_rows where db_id=$1 and not deleted order by sort_key`,
    [dbId],
  );
  return {
    name: meta[0].name,
    icon: meta[0].icon ?? null,
    props: props.filter((p) => !HIDDEN_PROPS.includes(String(p.type))),
    rows: rows.map((r) => ({ icon: r.icon ?? null, vals: r.vals ?? {} })),
  };
}

// Whitelist what leaves the hub, block by block: html blocks drop their persisted
// `data` (app-side state, possibly sensitive), folder blocks are local-filesystem
// views (private paths) and vanish entirely, unknown types are dropped.
function sanitizeBlocks(content: unknown, inScope: Set<string>): Json[] {
  let blocks: Json[] = [];
  try {
    blocks = typeof content === "string"
      ? JSON.parse(content)
      : (content as Json[]) ?? [];
  } catch { /* unreadable content — render the shell */ }
  const out: Json[] = [];
  for (const b of blocks) {
    const id = typeof b?.id === "string" ? { id: b.id } : {};
    if (b?.type === "text" || b?.type === "heading" || b?.type === "todo") {
      out.push({
        type: b.type,
        text: String(b.text ?? ""),
        ...(b.done !== undefined ? { done: Boolean(b.done) } : {}),
        ...(typeof b.indent === "number" ? { indent: b.indent } : {}),
        ...id,
      });
    } else if (b?.type === "database" && typeof b.db_id === "string") {
      out.push({ type: "database", db_id: b.db_id, ...id });
    } else if (
      b?.type === "subpage" && typeof b.page_id === "string" &&
      inScope.has(b.page_id)
    ) {
      out.push({ type: "subpage", page_id: b.page_id, ...id });
    } else if (b?.type === "html" && typeof b.html === "string" && b.html) {
      out.push({
        type: "html",
        html: b.html,
        ...(typeof b.height === "number" ? { height: b.height } : {}),
        ...id,
      });
    }
  }
  return out;
}

async function buildPayload(
  db: Q,
  token: string,
  root: string,
  pageId: string,
): Promise<Json | null> {
  const pages = await subtreePages(db, root);
  const page = pages.get(pageId);
  if (!page) return null; // outside the linked subtree (or deleted)
  const blocks = sanitizeBlocks(page.content, new Set(pages.keys()));

  const subpages: Json = {};
  for (const b of blocks) {
    if (b.type !== "subpage") continue;
    const sub = pages.get(String(b.page_id))!;
    subpages[String(b.page_id)] = {
      title: sub.title ?? "",
      icon: sub.icon ?? null,
    };
  }
  const children = [...pages.values()]
    .filter((p) => p.parent_id === pageId)
    .sort((a, b) => String(a.sort_key).localeCompare(String(b.sort_key)))
    .map((p) => ({ id: p.id, title: p.title ?? "", icon: p.icon ?? null }));

  const attached = (await db.query(
    `select id from udb_databases where page_id=$1 and not deleted order by sort_key`,
    [pageId],
  )).map((d) => String(d.id));
  const dbIds = new Set(attached);
  for (const b of blocks) {
    if (b.type === "database") dbIds.add(String(b.db_id));
  }
  const databases: Json = {};
  for (const id of dbIds) {
    const d = await dbPayload(db, id);
    if (d) databases[id] = d;
  }

  return {
    token,
    page: {
      id: page.id,
      title: page.title ?? "",
      icon: page.icon ?? null,
      brief: page.brief ?? "",
    },
    blocks,
    children,
    subpages,
    databases,
    attached,
    isRoot: pageId === root,
  };
}

// `<` is escaped so page content can never break out of the inline <script>
const jsonForScript = (v: unknown): string =>
  JSON.stringify(v).replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");

function shell(payload: Json): string {
  const title = String((payload.page as Json)?.title ?? "") || "Trame";
  const css = LINK_ENTRY.css.map((f) =>
    `<link rel="stylesheet" href="/l/assets/${f}">`
  ).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>body{margin:0;background:#0c0d10}@media (prefers-color-scheme: light){body{background:#f6f7f9}}</style>
${css}
<script>window.__TRAME_LINK__ = ${jsonForScript(payload)};</script>
</head><body>
<div id="root"></div>
<script type="module" src="/l/assets/${LINK_ENTRY.js}"></script>
<noscript><p style="padding:2rem;font-family:system-ui">This shared page needs JavaScript.</p></noscript>
</body></html>`;
}

export function createLinkApp(db: Q): Hono {
  const app = new Hono();
  const notFound = (c: Context) =>
    c.html(
      "<!doctype html><p>This link doesn't exist or was revoked.</p>",
      404,
    );

  // hashed filenames → safe to cache forever
  app.get("/l/assets/*", (c) => {
    const a = LINK_ASSETS[c.req.path.slice("/l/assets/".length)];
    if (!a) return c.text("not found", 404);
    return c.body(a.bytes.slice().buffer, 200, {
      "content-type": a.type,
      "cache-control": "public, max-age=31536000, immutable",
    });
  });
  app.get("/l/:token", async (c) => {
    const token = c.req.param("token");
    const root = await linkedRoot(db, token);
    if (!root) return notFound(c);
    const payload = await buildPayload(db, token, root, root);
    return payload ? c.html(shell(payload)) : notFound(c);
  });
  app.get("/l/:token/p/:pageId", async (c) => {
    const token = c.req.param("token");
    const root = await linkedRoot(db, token);
    if (!root) return notFound(c);
    const payload = await buildPayload(db, token, root, c.req.param("pageId"));
    return payload ? c.html(shell(payload)) : notFound(c);
  });
  app.notFound((c) => c.text("not found", 404));
  return app;
}
