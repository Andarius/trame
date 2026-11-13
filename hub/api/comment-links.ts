// Comment links: a page-scoped, revocable token embedded in a published HTML page
// (html-comments), letting its visitors read and post `html:` comment threads on
// ONE Trame page from the public listener. Hub-only table, never synced.
import { type Context, Hono } from "hono";
import type { DB, Q } from "./db.ts";
import { type Access, loadAccess } from "./acl.ts";
import type { Caller } from "./auth.ts";

const AGENT_ID = "00000000-0000-4000-8000-0000000000aa";
const THREAD_RE = /^html:[0-9a-z]{6,32}$/;
const VISITOR_RE = /^[A-Za-z0-9_-]{16,64}$/;
const ORIGIN_RE = /^(null|https?:\/\/[a-z0-9.-]+(:\d+)?)$/;
const MAX_BODY = 20_000;
const MAX_NAME = 60;
const MAX_ORIGINS = 8;
const DEFAULT_TTL_DAYS = 30;
const MAX_TTL_DAYS = 365;
// per link, not per IP: the token is the only identity a public caller can't spoof
export const WRITE_LIMITS: [count: number, windowMs: number][] = [
  [20, 60_000],
  [300, 86_400_000],
];

export async function ensureCommentLinkSchema(db: Q): Promise<void> {
  await db.query(`
    create table if not exists comment_links (
      id uuid primary key default gen_random_uuid(),
      page_id uuid not null,
      token_hash text not null unique,
      origins text[] not null,
      created_by text not null,
      created_at timestamptz not null default now(),
      revoked_at timestamptz
    )`);
  // volatile default: links minted before expiry existed get 30 days from this deploy
  await db.query(
    `alter table comment_links add column if not exists expires_at timestamptz not null default now() + interval '${DEFAULT_TTL_DAYS} days'`,
  );
  await db.query(
    `comment on table comment_links is
     'Hub-only: html-comments tokens (sha-256) letting pages served from origins read/post html: threads on page_id. Revoke by setting revoked_at; dead after expires_at.'`,
  );
}

async function sha256hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s),
  );
  return Array.from(new Uint8Array(digest)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

function randomToken(): string {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  return btoa(String.fromCharCode(...raw)).replaceAll("+", "-").replaceAll(
    "/",
    "_",
  ).replaceAll("=", "");
}

const isUuid = (s: unknown): s is string =>
  typeof s === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const mayEdit = (access: Access, pageId: string) =>
  access === null || access.pages.get(pageId) === true;

type Env = { Variables: { caller: Caller } };

/** Authenticated routes (mounted behind the /api/* bearer auth): mint and revoke. */
export function commentLinkApi(db: DB): Hono<Env> {
  const app = new Hono<Env>();
  app.post("/api/comment-links", async (c) => {
    const p = await c.req.json().catch(() => null) as
      | Record<string, unknown>
      | null;
    const origins = Array.isArray(p?.origins) ? p.origins : [];
    if (!p || !isUuid(p.page_id)) {
      return c.json({ error: "page_id must be a uuid" }, 400);
    }
    if (
      !origins.length || origins.length > MAX_ORIGINS ||
      !origins.every((o) => typeof o === "string" && ORIGIN_RE.test(o))
    ) {
      return c.json({
        error: `origins: 1..${MAX_ORIGINS} values like https://host or null`,
      }, 400);
    }
    const ttl = p.ttl_days ?? DEFAULT_TTL_DAYS;
    if (
      !Number.isInteger(ttl) || (ttl as number) < 1 ||
      (ttl as number) > MAX_TTL_DAYS
    ) {
      return c.json(
        { error: `ttl_days must be an integer 1..${MAX_TTL_DAYS}` },
        400,
      );
    }
    const caller = c.get("caller");
    if (!mayEdit(await loadAccess(db, caller), p.page_id)) {
      return c.json({ error: "no edit access to page" }, 403);
    }
    const token = randomToken();
    const rows = await db.query(
      `insert into comment_links (page_id, token_hash, origins, created_by, expires_at)
       values ($1, $2, $3, $4, now() + make_interval(days => $5)) returning id, expires_at`,
      [p.page_id, await sha256hex(token), origins, caller.nodeId, ttl],
    );
    return c.json({ id: rows[0].id, token, expires_at: rows[0].expires_at });
  });
  app.delete("/api/comment-links/:id", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "bad id" }, 400);
    const rows = await db.query(
      `select page_id from comment_links where id=$1 and revoked_at is null`,
      [id],
    );
    if (!rows.length) return c.json({ error: "not found" }, 404);
    if (
      !mayEdit(await loadAccess(db, c.get("caller")), String(rows[0].page_id))
    ) {
      return c.json({ error: "no edit access to page" }, 403);
    }
    await db.query(`update comment_links set revoked_at=now() where id=$1`, [
      id,
    ]);
    return c.json({ revoked: id });
  });
  return app;
}

type Link = { id: string; pageId: string; origins: string[] };

async function findLink(
  db: Q,
  token: string | undefined,
): Promise<Link | null> {
  if (!token) return null;
  const rows = await db.query(
    `select id, page_id, origins from comment_links
      where token_hash=$1 and revoked_at is null and expires_at > now()`,
    [await sha256hex(token)],
  );
  const r = rows[0];
  return r
    ? {
      id: String(r.id),
      pageId: String(r.page_id),
      origins: r.origins as string[],
    }
    : null;
}

function parseMeta(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object") return v as Record<string, unknown>;
  if (typeof v !== "string" || !v) return {};
  try {
    const m = JSON.parse(v);
    return m && typeof m === "object" ? m : {};
  } catch {
    return {};
  }
}

// only what the page needs to render: never user ids, origins or raw visitor ids
function publicMeta(m: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["html", "visitor_tag", "model", "in", "out", "ms"]) {
    if (m[k] !== undefined) out[k] = m[k];
  }
  return out;
}

/** Sliding-window limiter: a hit counts only if every window still has room. */
function limiter(limits: [number, number][]) {
  const longest = Math.max(...limits.map(([, w]) => w));
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < longest);
    if (
      limits.some(([max, w]) => recent.filter((t) => now - t < w).length >= max)
    ) return false;
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
}

/** Public routes under /l/c (the link listener): CORS-gated per link origins, token in x-hc-link. */
export function mountCommentLinkRoutes(
  app: Hono,
  db: DB,
  limits: [number, number][] = WRITE_LIMITS,
): void {
  const allowWrite = limiter(limits);
  const cors = (origin: string) => ({
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "content-type, x-hc-link, x-hc-visitor",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "600",
    vary: "origin",
    "cache-control": "no-store",
  });

  app.options("/l/c/*", async (c) => {
    const origin = c.req.header("origin") ?? "";
    const known = await db.query(
      `select 1 from comment_links
        where revoked_at is null and expires_at > now() and $1 = any(origins) limit 1`,
      [origin],
    );
    return known.length ? c.body(null, 204, cors(origin)) : c.body(null, 403);
  });

  // resolves the link and checks the caller's origin against it, or answers the error
  const gate = async (
    c: Context,
  ): Promise<{ link: Link; headers: Record<string, string> } | Response> => {
    const origin = c.req.header("origin") ?? "";
    const link = await findLink(db, c.req.header("x-hc-link"));
    if (!link) {
      return c.json({ error: "unknown, expired or revoked link" }, 401);
    }
    if (!link.origins.includes(origin)) {
      return c.json({ error: "origin not allowed" }, 403);
    }
    if (c.req.method === "POST" && !allowWrite(link.id)) {
      return c.json(
        { error: "too many comments on this page, slow down" },
        429,
        cors(origin),
      );
    }
    return { link, headers: cors(origin) };
  };

  app.get("/l/c/threads", async (c) => {
    const g = await gate(c);
    if (g instanceof Response) return g;
    const rows = await db.query(
      `select c.id, c.block_id, c.anchor, c.body, c.author, c.author_id, c.resolved, c.meta, c.updated_at,
              s.status as agent_status, s.agent as agent_status_agent
         from page_comments c
         left join lateral (
           select status, agent from comment_agent_status
            where comment_id = c.id and not deleted order by updated_at desc limit 1
         ) s on true
        where c.page_id=$1 and c.block_id like 'html:%' and not c.deleted
        order by c.id`,
      [g.link.pageId],
    );
    const out = rows.map((r) => ({
      ...r,
      author_id: r.author_id === AGENT_ID ? AGENT_ID : null,
      meta: publicMeta(parseMeta(r.meta)),
    }));
    return c.json(out, 200, g.headers);
  });

  app.post("/l/c/comments", async (c) => {
    const g = await gate(c);
    if (g instanceof Response) return g;
    const visitor = c.req.header("x-hc-visitor") ?? "";
    if (!VISITOR_RE.test(visitor)) {
      return c.json({ error: "missing visitor id" }, 400, g.headers);
    }
    const p = await c.req.json().catch(() => null) as
      | Record<string, unknown>
      | null;
    const name = typeof p?.name === "string" ? p.name.trim() : "";
    const body = typeof p?.body === "string" ? p.body.trim() : "";
    if (!p || typeof p.block_id !== "string" || !THREAD_RE.test(p.block_id)) {
      return c.json({ error: "bad block_id" }, 400, g.headers);
    }
    if (!name || name.length > MAX_NAME) {
      return c.json(
        { error: `name must be 1..${MAX_NAME} chars` },
        400,
        g.headers,
      );
    }
    if (!body || body.length > MAX_BODY) {
      return c.json(
        { error: `body must be 1..${MAX_BODY} chars` },
        400,
        g.headers,
      );
    }
    const html = (p.meta as Record<string, unknown> | undefined)?.html;
    const meta = {
      ...(html && typeof html === "object" ? { html } : {}),
      // stable per (link, visitor) colour tag: shows a second "Julien" as a different person
      visitor_tag: (await sha256hex(`${g.link.id}:${visitor}`)).slice(0, 8),
    };
    const anchor = typeof p.anchor === "string" ? p.anchor.slice(0, 2000) : "";
    const rows = await db.transaction(async (tx) => {
      await tx.query(`select set_config('trame.source', 'link', true)`);
      return tx.query(
        `insert into page_comments (page_id, block_id, anchor, body, author, meta, origin)
         values ($1, $2, $3, $4, $5, $6, 'hub-link') returning id`,
        [g.link.pageId, p.block_id, anchor, body, name, JSON.stringify(meta)],
      );
    });
    return c.json({ id: rows[0].id }, 200, g.headers);
  });

  app.post("/l/c/threads/resolve", async (c) => {
    const g = await gate(c);
    if (g instanceof Response) return g;
    const p = await c.req.json().catch(() => null) as
      | Record<string, unknown>
      | null;
    if (
      !p || typeof p.block_id !== "string" || !THREAD_RE.test(p.block_id) ||
      typeof p.resolved !== "boolean"
    ) {
      return c.json({ error: "bad block_id/resolved" }, 400, g.headers);
    }
    const rows = await db.transaction(async (tx) => {
      await tx.query(`select set_config('trame.source', 'link', true)`);
      return tx.query(
        `update page_comments set resolved=$3, updated_at=now()
          where page_id=$1 and block_id=$2 and resolved<>$3 and not deleted returning id`,
        [g.link.pageId, p.block_id, p.resolved],
      );
    });
    return c.json({ updated: rows.length }, 200, g.headers);
  });
}
