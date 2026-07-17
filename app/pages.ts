// Pages (Notion-style): one nestable tree. kind='project' pages are the former
// objectives and still serve the board through the objectives facade in db.ts.
// The tree is returned flat (parent_id + sort_key) — the frontend assembles it and
// tolerates orphans (sync can deliver a child before its parent).
import { db } from "./db.ts";
import { NODE_ID } from "./config.ts";
import { getIdentity } from "./identity.ts";
import { midKey } from "./udb.ts";
import {
  AGENT_AUTHOR_ID,
  agentIdentity,
  type AgentKind,
  resolveCommentBlock,
} from "./agent-comments.ts";

const LIST_COLS =
  "id, parent_id, kind, title, icon, status, client_id, color, sort_key";
const COMMENT_COLS =
  "id, page_id, block_id, anchor, body, author, author_avatar, author_id, resolved, meta, updated_at";

// Comments for a page, each carrying the newest watcher status (seen/answering/failed)
// from comment_agent_status. Shared by listComments and getPage.
async function commentsForPage(pageId: string) {
  const pg = await db();
  return (await pg.query(
    `select ${COMMENT_COLS.split(", ").map((c) => `c.${c}`).join(", ")},
            s.status as agent_status, s.agent as agent_status_agent
       from page_comments c
       left join lateral (
         select status, agent from comment_agent_status
          where comment_id = c.id and not deleted
          order by updated_at desc limit 1
       ) s on true
      where c.page_id=$1 and not c.deleted order by c.updated_at`,
    [pageId],
  )).rows;
}

export async function listPages() {
  const pg = await db();
  return (await pg.query(
    `select ${LIST_COLS} from pages where not deleted order by sort_key, title`,
  )).rows;
}

export async function getPage(id: string) {
  const pg = await db();
  const page =
    (await pg.query(`select * from pages where id=$1 and not deleted`, [id]))
      .rows[0];
  if (!page) return null;
  const children = (await pg.query(
    `select ${LIST_COLS} from pages where parent_id=$1 and not deleted order by sort_key, title`,
    [id],
  )).rows;
  const databases = (await pg.query(
    `select d.id, d.name, d.icon,
            (select count(*)::int from udb_rows r where r.db_id = d.id and not r.deleted) as row_count
       from udb_databases d where d.page_id=$1 and not d.deleted order by d.sort_key, d.name`,
    [id],
  )).rows;
  const sessions = (await pg.query(
    `select * from sessions where page_id=$1 and not deleted order by last_touched desc`,
    [id],
  )).rows;
  const comments = await commentsForPage(id);
  return { ...page, children, databases, sessions, comments };
}

async function endKey(
  pg: Awaited<ReturnType<typeof db>>,
  parentId: string | null,
): Promise<string> {
  const last = (await pg.query(
    `select max(sort_key) as k from pages where parent_id is not distinct from $1 and not deleted`,
    [parentId],
  )).rows[0] as { k: string | null };
  return midKey(last.k ?? "", "");
}

export async function createPage(
  p: {
    title?: string;
    parent_id?: string | null;
    kind?: string;
    icon?: string | null;
    client_id?: string | null;
    story?: string;
    content?: unknown[];
  },
): Promise<string> {
  const pg = await db();
  const parentId = p.parent_id ?? null;
  const row = (await pg.query(
    `insert into pages
       (kind, title, icon, client_id, parent_id, sort_key, story, content, owner_id, origin)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [
      ["project", "story"].includes(p.kind ?? "") ? p.kind : "page",
      p.title ?? "",
      p.icon ?? null,
      p.client_id ?? null,
      parentId,
      await endKey(pg, parentId),
      p.story ?? "",
      JSON.stringify(p.content ?? []),
      (await getIdentity()).userId,
      NODE_ID,
    ],
  )).rows[0] as { id: string };
  return row.id;
}

export async function updatePage(
  id: string,
  patch: {
    title?: string;
    icon?: string | null;
    story?: string;
    status?: string;
    client_id?: string | null;
    content?: unknown[];
    color?: string | null;
  },
): Promise<void> {
  const pg = await db();
  await pg.query(
    `update pages set
       title     = coalesce($2, title),
       story     = coalesce($3, story),
       status    = coalesce($4, status),
       content   = coalesce($5, content),
       icon      = case when $6 then $7 else icon end,
       client_id = case when $8 then $9 else client_id end,
       color     = case when $11 then $12 else color end,
       origin=$10, updated_at=now()
     where id=$1`,
    [
      id,
      patch.title ?? null,
      patch.story ?? null,
      patch.status ?? null,
      patch.content ? JSON.stringify(patch.content) : null,
      "icon" in patch,
      patch.icon ?? null,
      "client_id" in patch,
      patch.client_id ?? null,
      NODE_ID,
      "color" in patch,
      patch.color ?? null,
    ],
  );
}

// Reparent and/or reorder. sort_key is computed here from the neighbor the client
// dropped next to (before_id/after_id) so concurrent moves can't share a key.
export async function movePage(
  id: string,
  to: { parent_id?: string | null; before_id?: string; after_id?: string },
): Promise<void> {
  const pg = await db();
  const cur =
    (await pg.query(`select parent_id from pages where id=$1 and not deleted`, [
      id,
    ])).rows[0] as
      | { parent_id: string | null }
      | undefined;
  if (!cur) throw new Error("page not found");
  const parentId = to.parent_id !== undefined ? to.parent_id : cur.parent_id;
  // reject cycles: the new parent must not be the page itself or a descendant of it
  if (parentId) {
    const hit = (await pg.query(
      `with recursive up as (
         select id, parent_id from pages where id=$1
         union all
         select p.id, p.parent_id from pages p join up on p.id = up.parent_id
       ) select 1 from up where id=$2 limit 1`,
      [parentId, id],
    )).rows[0];
    if (hit) throw new Error("cannot move a page under itself");
  }
  const anchor = to.before_id ?? to.after_id;
  let key: string;
  if (anchor) {
    const rows = (await pg.query(
      `select id, sort_key from pages
        where parent_id is not distinct from $1 and not deleted and id <> $2
        order by sort_key, title`,
      [parentId, id],
    )).rows as { id: string; sort_key: string }[];
    const i = rows.findIndex((r) => r.id === anchor);
    if (i < 0) throw new Error("anchor page not found");
    key = to.before_id
      ? midKey(rows[i - 1]?.sort_key ?? "", rows[i].sort_key)
      : midKey(rows[i].sort_key, rows[i + 1]?.sort_key ?? "");
  } else {
    key = await endKey(pg, parentId ?? null);
  }
  await pg.query(
    `update pages set parent_id=$2, sort_key=$3, origin=$4, updated_at=now() where id=$1`,
    [id, parentId, key, NODE_ID],
  );
}

// Soft-delete the page, its whole subtree, and databases attached anywhere in it
// (Notion semantics: a page takes its contents with it). Sessions/reports keep their
// page_id — they just lose the chip until relinked.
export async function deletePage(id: string): Promise<void> {
  const pg = await db();
  await pg.query(
    `with recursive sub as (
       select id from pages where id=$1
       union all
       select p.id from pages p join sub on p.parent_id = sub.id where not p.deleted
     )
     update udb_databases set deleted=true, origin=$2, updated_at=now()
      where not deleted and page_id in (select id from sub)`,
    [id, NODE_ID],
  );
  // before the pages update below — the subtree walk only follows live rows
  await pg.query(
    `with recursive sub as (
       select id from pages where id=$1
       union all
       select p.id from pages p join sub on p.parent_id = sub.id where not p.deleted
     )
     update page_comments set deleted=true, origin=$2, updated_at=now()
      where not deleted and page_id in (select id from sub)`,
    [id, NODE_ID],
  );
  await pg.query(
    `with recursive sub as (
       select id from pages where id=$1
       union all
       select p.id from pages p join sub on p.parent_id = sub.id where not p.deleted
     )
     update pages set deleted=true, origin=$2, updated_at=now() where id in (select id from sub)`,
    [id, NODE_ID],
  );
}

// Inline page comments — block-level notes anchored by Block.id inside pages.content.

export async function listComments(pageId: string) {
  return await commentsForPage(pageId);
}

export async function createComment(
  p: {
    page_id: string;
    block_id: string;
    anchor?: string;
    body: string;
    agent?: AgentKind;
    author?: string;
    author_avatar?: string;
    meta?: Record<string, unknown>; // agent generation stats {model, in, out, ms}
  },
): Promise<string> {
  const pg = await db();
  const me = await getIdentity();
  // agents (Codex, Claude, …) get the reserved AGENT_AUTHOR_ID so the schema
  // backfill never re-claims their comments for the local user
  const agent = p.agent ? agentIdentity(p.agent) : null;
  const author = agent?.name ?? p.author?.trim();
  const row = (await pg.query(
    `insert into page_comments (page_id, block_id, anchor, body, author, author_avatar, author_id, meta, origin)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [
      p.page_id,
      p.block_id,
      p.anchor ?? "",
      p.body,
      author || me.name,
      agent?.avatar ?? (author ? (p.author_avatar ?? "") : me.avatar),
      // sentinel only for real agent threads; a custom display author stays the local user
      agent ? AGENT_AUTHOR_ID : me.userId,
      p.meta ? JSON.stringify(p.meta) : null,
      NODE_ID,
    ],
  )).rows[0] as { id: string };
  return row.id;
}

export async function updateComment(
  id: string,
  patch: {
    body?: string;
    resolved?: boolean;
    author?: string;
    author_avatar?: string;
  },
): Promise<void> {
  const pg = await db();
  // re-attributing to an agent name detaches the comment from the synced user
  await pg.query(
    `update page_comments set
       body     = coalesce($2, body),
       resolved = coalesce($3, resolved),
       author   = coalesce($4, author),
       author_avatar = case when $4::text is null then author_avatar else coalesce($5, '') end,
       author_id     = case when $4::text is null then author_id else '${AGENT_AUTHOR_ID}'::uuid end,
       origin=$6, updated_at=now()
     where id=$1`,
    [
      id,
      patch.body ?? null,
      patch.resolved ?? null,
      patch.author?.trim() || null,
      patch.author_avatar ?? null,
      NODE_ID,
    ],
  );
}

export async function deleteComment(id: string): Promise<void> {
  const pg = await db();
  await pg.query(
    `update page_comments set deleted=true, origin=$2, updated_at=now() where id=$1`,
    [id, NODE_ID],
  );
}

// Comment watcher: an agent sees a human reply and answers it.

export type AgentStatus = "seen" | "answering" | "failed" | "answered";

// Set (or clear) the watcher status on a human reply. body_hash pins the current
// reply text so an edit re-triggers the watcher but a resolve toggle does not.
export async function setCommentAgentStatus(
  commentId: string,
  patch: { status: AgentStatus | "clear"; agent?: string },
): Promise<void> {
  const pg = await db();
  const c = (await pg.query(
    `select page_id, body from page_comments where id=$1 and not deleted`,
    [commentId],
  )).rows[0] as { page_id: string; body: string } | undefined;
  if (!c) throw new Error(`comment "${commentId}" was not found`);

  // id=comment_id is deliberate: at most one status row per comment (dedup) and
  // LWW-mergeable — concurrent watchers converge on the same row via ON CONFLICT (id).
  if (patch.status === "clear") {
    await pg.query(
      `update comment_agent_status set deleted=true, origin=$2, updated_at=now()
        where id=$1`,
      [commentId, NODE_ID],
    );
    return;
  }

  await pg.query(
    `insert into comment_agent_status (id, comment_id, page_id, status, agent, body_hash, origin)
     values ($1,$1,$2,$3,coalesce($4,''),md5($5),$6)
     on conflict (id) do update set
       page_id=excluded.page_id, status=excluded.status,
       agent=coalesce($4, comment_agent_status.agent),
       body_hash=excluded.body_hash, deleted=false, origin=excluded.origin, updated_at=now()`,
    [commentId, c.page_id, patch.status, patch.agent ?? null, c.body, NODE_ID],
  );
}

export type InboxItem = {
  comment: Record<string, unknown>; // the human reply awaiting an answer
  page: { id: string; title: string };
  block: { id: string; text: string };
  thread: Record<string, unknown>[]; // all comments on the block, oldest first
  agent: AgentKind; // which CLI answers (the thread's latest agent author)
};

// Human replies on agent threads that still need an answer. A candidate is the
// NEWEST non-deleted comment on its block (no newer comment of any author), and is
// unresolved, human-authored, and has an OLDER agent comment (a reply to the agent) —
// exactly one per block, only when the newest comment is a human reply. Its status must
// be absent, hash-stale (the human edited it), or stuck ≥ staleSecs (watcher crash).
export async function listCommentInbox(staleSecs = 600): Promise<InboxItem[]> {
  const pg = await db();
  // self-heal: only drop status rows whose comment is hard-gone or deleted. "answered"
  // rows are kept — they're the terminal hash tombstone that stops re-answering. The
  // candidate logic below (not this cleanup) keeps answered replies out of the inbox.
  await pg.query(
    `update comment_agent_status s set deleted=true, origin=$1, updated_at=now()
      where not s.deleted and not exists (
        select 1 from page_comments c where c.id = s.comment_id and not c.deleted)`,
    [NODE_ID],
  );

  const candidates = (await pg.query(
    `with latest as (
       select distinct on (comment_id) comment_id, status, body_hash, updated_at
         from comment_agent_status where not deleted
        order by comment_id, updated_at desc
     )
     select ${COMMENT_COLS.split(", ").map((c) => `c.${c}`).join(", ")}
       from page_comments c
       left join latest s on s.comment_id = c.id
      where not c.deleted and not c.resolved
        and c.author_id is distinct from $1::uuid
        and exists (select 1 from page_comments a
              where a.page_id=c.page_id and a.block_id=c.block_id and not a.deleted
                and a.author_id=$1 and a.updated_at < c.updated_at)
        and not exists (select 1 from page_comments a
              where a.page_id=c.page_id and a.block_id=c.block_id and not a.deleted
                and a.id <> c.id and a.updated_at > c.updated_at)
        and (s.comment_id is null
             or s.body_hash is distinct from md5(c.body)
             or (s.status in ('seen','answering')
                 and s.updated_at < now() - make_interval(secs => $2)))
      -- updated_at is the app's LWW wall-clock; cross-device clock skew can affect
      -- ordering here (known limitation, same as the rest of the app)
      order by c.updated_at`,
    [AGENT_AUTHOR_ID, staleSecs],
  )).rows as Record<string, unknown>[];

  const items: InboxItem[] = [];
  for (const c of candidates) {
    const pageId = String(c.page_id);
    const blockId = String(c.block_id);
    const page = (await pg.query(
      `select id, title, content from pages where id=$1 and not deleted`,
      [pageId],
    )).rows[0] as { id: string; title: string; content: unknown } | undefined;
    if (!page) continue; // page vanished under LWW — skip this pass

    let blockText = String(c.anchor ?? "");
    try {
      blockText = resolveCommentBlock(page.content, { block_id: blockId }).text;
    } catch {
      // block removed from content — keep the anchor snapshot
    }

    const thread = (await pg.query(
      `select ${COMMENT_COLS} from page_comments
        where page_id=$1 and block_id=$2 and not deleted order by updated_at`,
      [pageId, blockId],
    )).rows as Record<string, unknown>[];

    // the thread's newest agent comment decides which agent answers — its display
    // name lower-cased is the agent id (Codex→codex, Claude→claude, GLM→glm)
    const lastAgent = [...thread].reverse().find((t) =>
      t.author_id === AGENT_AUTHOR_ID
    );
    const agent: AgentKind = String(lastAgent?.author ?? "claude")
      .toLowerCase();

    items.push({
      comment: c,
      page: { id: page.id, title: page.title },
      block: { id: blockId, text: blockText },
      thread,
      agent,
    });
  }
  return items;
}

export async function attachUdbToPage(
  dbId: string,
  pageId: string | null,
): Promise<void> {
  const pg = await db();
  await pg.query(
    `update udb_databases set page_id=$2, origin=$3, updated_at=now() where id=$1`,
    [dbId, pageId, NODE_ID],
  );
}

// Sharing (phase 7): page_shares rows are normal synced data — created here on the
// member's replica, enforced by the hub API on /sync.
export async function listUsers() {
  const pg = await db();
  return (await pg.query(
    `select id, name, role from users where not deleted order by name, id`,
  )).rows;
}

export async function listShares(pageId: string) {
  const pg = await db();
  return (await pg.query(
    `select s.id, s.user_id, s.role, coalesce(nullif(u.name, ''), s.user_id::text) as name
       from page_shares s left join users u on u.id = s.user_id
      where s.page_id=$1 and not s.deleted order by name`,
    [pageId],
  )).rows;
}

export async function setShare(
  p: { page_id: string; user_id: string; role: string },
): Promise<string> {
  const role = p.role === "viewer" ? "viewer" : "editor";
  const pg = await db();
  const hit = (await pg.query(
    `select id from page_shares where page_id=$1 and user_id=$2 and not deleted limit 1`,
    [p.page_id, p.user_id],
  )).rows[0] as { id: string } | undefined;
  if (hit) {
    await pg.query(
      `update page_shares set role=$2, origin=$3, updated_at=now() where id=$1`,
      [hit.id, role, NODE_ID],
    );
    return hit.id;
  }
  const row = (await pg.query(
    `insert into page_shares (page_id, user_id, role, origin) values ($1,$2,$3,$4) returning id`,
    [p.page_id, p.user_id, role, NODE_ID],
  )).rows[0] as { id: string };
  return row.id;
}

export async function revokeShare(id: string): Promise<void> {
  const pg = await db();
  await pg.query(
    `update page_shares set deleted=true, origin=$2, updated_at=now() where id=$1`,
    [id, NODE_ID],
  );
}

// Public share links: token minted here (shown once), only its hash is stored/synced.
export async function createLink(
  pageId: string,
): Promise<{ id: string; token: string }> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const token = btoa(String.fromCharCode(...raw)).replaceAll("+", "-")
    .replaceAll("/", "_").replaceAll("=", "");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  const hash = Array.from(new Uint8Array(digest)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  const pg = await db();
  const row = (await pg.query(
    `insert into page_links (page_id, token_hash, origin) values ($1,$2,$3) returning id`,
    [pageId, hash, NODE_ID],
  )).rows[0] as { id: string };
  return { id: row.id, token };
}

export async function listLinks(pageId: string) {
  const pg = await db();
  return (await pg.query(
    `select id, updated_at from page_links where page_id=$1 and not deleted order by updated_at`,
    [pageId],
  )).rows;
}

export async function revokeLink(id: string): Promise<void> {
  const pg = await db();
  await pg.query(
    `update page_links set deleted=true, origin=$2, updated_at=now() where id=$1`,
    [id, NODE_ID],
  );
}
