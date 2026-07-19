// Public read-only link views (shareable URLs). Served by a SEPARATE listener so
// the sync API never faces the internet — this module renders pages, nothing else.
// The token is the capability: sha-256 looked up in page_links, revocable. Scope is
// the linked page's subtree + attached databases. Comments are NEVER rendered here.
import { type Context, Hono } from "hono";
import { withBridge } from "../../protocol/html.ts";
import type { Q } from "./db.ts";

type Row = Record<string, unknown>;

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
     select p.id, p.parent_id, p.title, p.icon, p.story, p.content, p.sort_key
       from pages p join tree t on t.id = p.id`,
    [root],
  );
  return new Map(rows.map((r) => [String(r.id), r]));
}

async function renderDatabase(db: Q, dbId: string): Promise<string> {
  const meta = await db.query(
    `select name from udb_databases where id=$1 and not deleted`,
    [dbId],
  );
  if (!meta.length) return "";
  const props = await db.query(
    `select id, name, type from udb_properties where db_id=$1 and not deleted order by sort_key`,
    [dbId],
  );
  const rows = await db.query(
    `select icon, vals from udb_rows where db_id=$1 and not deleted order by sort_key`,
    [dbId],
  );
  const shown = props.filter((p) =>
    !["formula", "rollup", "relation"].includes(String(p.type))
  );
  const cell = (vals: Row, p: Row): string => {
    const v = (vals ?? {})[String(p.id)];
    if (v === null || v === undefined) return "";
    if (p.type === "checkbox") return v ? "✓" : "";
    if (p.type === "date" && typeof v === "object") {
      return esc((v as { start?: string }).start ?? "");
    }
    return esc(typeof v === "object" ? JSON.stringify(v) : v);
  };
  return `<h3>${esc(meta[0].name)}</h3>
<table><thead><tr>${
    shown.map((p) => `<th>${esc(p.name)}</th>`).join("")
  }</tr></thead>
<tbody>${
    rows.map((r) =>
      `<tr>${
        shown.map((p) => `<td>${cell(r.vals as Row, p)}</td>`).join("")
      }</tr>`
    ).join("\n")
  }</tbody></table>`;
}

// The block model is small (see app Block type): text/heading/todo render as text,
// database blocks inline their table, subpage blocks link within the token's scope,
// html blocks render in the same sandboxed iframe as the app (data-back is off here).
// Folder blocks are local-filesystem views — meaningless (and private) here: skipped.
async function renderBlocks(
  db: Q,
  token: string,
  page: Row,
  pages: Map<string, Row>,
): Promise<string> {
  let content: {
    type?: string;
    text?: string;
    done?: boolean;
    db_id?: string;
    page_id?: string;
    html?: string;
    height?: unknown;
  }[] = [];
  try {
    content = typeof page.content === "string"
      ? JSON.parse(page.content)
      : (page.content as typeof content) ?? [];
  } catch { /* unreadable content — render the shell */ }
  const parts: string[] = [];
  for (const b of content) {
    if (b.type === "heading") parts.push(`<h2>${esc(b.text)}</h2>`);
    else if (b.type === "todo") {
      parts.push(`<p class="todo">${b.done ? "☑" : "☐"} ${esc(b.text)}</p>`);
    } else if (b.type === "text") {
      parts.push(`<p>${esc(b.text).replaceAll("\n", "<br>")}</p>`);
    } else if (b.type === "html" && typeof b.html === "string" && b.html) {
      const pin = typeof b.height === "number";
      parts.push(
        `<iframe class="hb" sandbox="allow-scripts" allow="clipboard-write"${
          pin ? ` data-pinned="1"` : ""
        } style="height:${pin ? Number(b.height) : 300}px" srcdoc="${
          esc(withBridge(b.html))
        }"></iframe>`,
      );
    } else if (b.type === "database" && b.db_id) {
      parts.push(await renderDatabase(db, b.db_id));
    } else if (b.type === "subpage" && b.page_id && pages.has(b.page_id)) {
      const sub = pages.get(b.page_id)!;
      parts.push(
        `<p>↳ <a href="/l/${esc(token)}/p/${esc(b.page_id)}">${
          esc(sub.icon ?? "📄")
        } ${esc(sub.title) || "Untitled"}</a></p>`,
      );
    }
  }
  return parts.join("\n");
}

async function renderPage(
  db: Q,
  token: string,
  root: string,
  pageId: string,
): Promise<string | null> {
  const pages = await subtreePages(db, root);
  const page = pages.get(pageId);
  if (!page) return null; // outside the linked subtree (or deleted)
  // child pages that aren't already inlined as subpage blocks
  const children = [...pages.values()]
    .filter((p) => p.parent_id === pageId)
    .sort((a, b) => String(a.sort_key).localeCompare(String(b.sort_key)));
  // databases attached to the page sidebar (page_id set, not inline blocks)
  const attached = await db.query(
    `select id from udb_databases where page_id=$1 and not deleted order by sort_key`,
    [pageId],
  );
  const body = await renderBlocks(db, token, page, pages);
  const dbTables = (await Promise.all(
    attached.map((d) => renderDatabase(db, String(d.id))),
  )).join("\n");
  const childLinks = children.length
    ? `<h3>Pages</h3>${
      children.map((c) =>
        `<p>↳ <a href="/l/${esc(token)}/p/${esc(c.id)}">${
          esc(c.icon ?? "📄")
        } ${esc(c.title) || "Untitled"}</a></p>`
      ).join("\n")
    }`
    : "";
  const crumb = pageId === root
    ? ""
    : `<p><a href="/l/${esc(token)}">← back</a></p>`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(page.title) || "Trame"}</title>
<style>
  body { max-width: 720px; margin: 2rem auto; padding: 0 1rem; font: 15px/1.6 system-ui, sans-serif; color: #1a1d27; }
  @media (prefers-color-scheme: dark) { body { background: #12141c; color: #d5d9e4; } a { color: #7a9ee7; } th, td { border-color: #323649 !important; } }
  h1 { font-size: 1.6rem; } h2 { font-size: 1.2rem; margin-top: 1.6rem; } h3 { font-size: 1rem; margin-top: 1.4rem; }
  table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
  th, td { border: 1px solid #d8dbe4; padding: 4px 8px; text-align: left; }
  .todo { margin: .2rem 0; } .muted { opacity: .6; font-size: 12.5px; }
  a { color: #3b62c4; text-decoration: none; }
  iframe.hb { width: 100%; border: 1px solid #d8dbe4; border-radius: 8px; background: #fff; }
  @media (prefers-color-scheme: dark) { iframe.hb { border-color: #323649; background: #12141c; } }
</style>
<script>addEventListener("message",function(e){document.querySelectorAll("iframe.hb").forEach(function(f){if(f.contentWindow===e.source&&e.data&&e.data.trame==="height"&&!f.dataset.pinned)f.style.height=Math.min(Math.ceil(e.data.height)+2,4000)+"px"})})</script>
</head><body>
${crumb}
<h1>${esc(page.icon ?? "")} ${esc(page.title) || "Untitled"}</h1>
${page.story ? `<p class="muted">${esc(page.story)}</p>` : ""}
${body}
${dbTables}
${childLinks}
<p class="muted" style="margin-top:3rem">Shared read-only from Trame.</p>
</body></html>`;
}

export function createLinkApp(db: Q): Hono {
  const app = new Hono();
  const notFound = (c: Context) =>
    c.html(
      "<!doctype html><p>This link doesn't exist or was revoked.</p>",
      404,
    );

  app.get("/l/:token", async (c) => {
    const root = await linkedRoot(db, c.req.param("token"));
    if (!root) return notFound(c);
    const html = await renderPage(db, c.req.param("token"), root, root);
    return html ? c.html(html) : notFound(c);
  });
  app.get("/l/:token/p/:pageId", async (c) => {
    const root = await linkedRoot(db, c.req.param("token"));
    if (!root) return notFound(c);
    const html = await renderPage(
      db,
      c.req.param("token"),
      root,
      c.req.param("pageId"),
    );
    return html ? c.html(html) : notFound(c);
  });
  app.notFound((c) => c.text("not found", 404));
  return app;
}
