// Pages (Notion-style): one nestable tree. kind='project' pages are the former
// objectives and still serve the board through the objectives facade in db.ts.
// The tree is returned flat (parent_id + sort_key) — the frontend assembles it and
// tolerates orphans (sync can deliver a child before its parent).
import { db } from "./db.ts";
import { NODE_ID } from "./config.ts";
import { getCommentAuthor } from "./files.ts";
import { midKey } from "./udb.ts";

const LIST_COLS =
  "id, parent_id, kind, title, icon, status, client_id, color, sort_key";
const COMMENT_COLS =
  "id, page_id, block_id, anchor, body, author, author_avatar, resolved, updated_at";

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
  const comments = (await pg.query(
    `select ${COMMENT_COLS} from page_comments where page_id=$1 and not deleted order by updated_at`,
    [id],
  )).rows;
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
  },
): Promise<string> {
  const pg = await db();
  const parentId = p.parent_id ?? null;
  const row = (await pg.query(
    `insert into pages (kind, title, icon, client_id, parent_id, sort_key, origin)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [
      ["project", "story"].includes(p.kind ?? "") ? p.kind : "page",
      p.title ?? "",
      p.icon ?? null,
      p.client_id ?? null,
      parentId,
      await endKey(pg, parentId),
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
  const pg = await db();
  return (await pg.query(
    `select ${COMMENT_COLS} from page_comments where page_id=$1 and not deleted order by updated_at`,
    [pageId],
  )).rows;
}

export async function createComment(
  p: { page_id: string; block_id: string; anchor?: string; body: string },
): Promise<string> {
  const pg = await db();
  const { name: author, avatar } = await getCommentAuthor();
  const row = (await pg.query(
    `insert into page_comments (page_id, block_id, anchor, body, author, author_avatar, origin)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [p.page_id, p.block_id, p.anchor ?? "", p.body, author, avatar, NODE_ID],
  )).rows[0] as { id: string };
  return row.id;
}

export async function updateComment(
  id: string,
  patch: { body?: string; resolved?: boolean },
): Promise<void> {
  const pg = await db();
  await pg.query(
    `update page_comments set
       body     = coalesce($2, body),
       resolved = coalesce($3, resolved),
       origin=$4, updated_at=now()
     where id=$1`,
    [id, patch.body ?? null, patch.resolved ?? null, NODE_ID],
  );
}

export async function deleteComment(id: string): Promise<void> {
  const pg = await db();
  await pg.query(
    `update page_comments set deleted=true, origin=$2, updated_at=now() where id=$1`,
    [id, NODE_ID],
  );
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
