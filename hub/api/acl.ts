// Access control for /sync (phase 7). Members see the whole workspace (the original
// single-user behavior). Guests see only subtrees granted via page_shares — the page,
// its descendants, their comments and attached databases — plus every user profile
// (author display) and their own rows. Enforcement lives HERE, not in the schema:
// the laptop replica is untrusted anyway; the API is the boundary.
import type { Q } from "./db.ts";
import type { Caller } from "./auth.ts";

// null = member: unrestricted (filters are identity functions).
export type Access = null | GuestAccess;

export type GuestAccess = {
  userId: string;
  pages: Map<string, boolean>; // page id → editor?
  dbs: Map<string, boolean>; // udb_databases id → editor?
  props: Map<string, boolean>; // udb_properties id → editor?
};

export async function loadAccess(db: Q, caller: Caller): Promise<Access> {
  if (!caller.userId) {
    // a token whose device maps to no user sees nothing until invited properly
    return { userId: "", pages: new Map(), dbs: new Map(), props: new Map() };
  }
  const u = await db.query(
    `select role from users where id=$1 and not deleted`,
    [caller.userId],
  );
  if ((u[0]?.role ?? "member") === "member") return null;

  // Visible pages: live shares to this user + pages they own, then all descendants.
  // UNION (not UNION ALL) so a parent_id cycle (possible under LWW) can't recurse
  // forever; editor-ness is aggregated with bool_or afterwards.
  const rows = await db.query(
    `with recursive tree (id, editor) as (
       select page_id, (role = 'editor') from page_shares
        where user_id = $1 and not deleted
       union
       select id, true from pages where owner_id = $1 and not deleted
       union
       select p.id, t.editor from pages p
         join tree t on p.parent_id = t.id
        where not p.deleted
     )
     select id, bool_or(editor) as editor from tree group by id`,
    [caller.userId],
  ) as { id: string; editor: boolean }[];
  const pages = new Map(rows.map((r) => [r.id, r.editor]));

  const dbs = new Map<string, boolean>();
  if (pages.size) {
    const ph = [...pages.keys()].map((_, i) => `$${i + 1}`).join(",");
    const d = await db.query(
      `select id, page_id from udb_databases where page_id in (${ph}) and not deleted`,
      [...pages.keys()],
    ) as { id: string; page_id: string }[];
    for (const r of d) dbs.set(r.id, pages.get(r.page_id) ?? false);
  }
  const props = new Map<string, boolean>();
  if (dbs.size) {
    const ph = [...dbs.keys()].map((_, i) => `$${i + 1}`).join(",");
    const p = await db.query(
      `select id, db_id from udb_properties where db_id in (${ph}) and not deleted`,
      [...dbs.keys()],
    ) as { id: string; db_id: string }[];
    for (const r of p) props.set(r.id, dbs.get(r.db_id) ?? false);
  }
  return { userId: caller.userId, pages, dbs, props };
}

type Row = Record<string, unknown>;

// May this caller RECEIVE this row? (pull/snapshot filter)
export function rowVisible(access: Access, entity: string, row: Row): boolean {
  if (access === null) return true;
  switch (entity) {
    case "users":
      return true; // profiles only — needed to render authors
    case "devices":
      return row.user_id === access.userId;
    case "pages":
      return access.pages.has(String(row.id));
    case "page_shares":
    case "page_comments":
      return access.pages.has(String(row.page_id));
    case "udb_databases":
      return access.dbs.has(String(row.id));
    case "udb_properties":
    case "udb_rows":
      return access.dbs.has(String(row.db_id));
    case "udb_links":
      return access.props.has(String(row.prop_id));
    default: // clients, statuses, sessions, session_events, reports, …
      return false;
  }
}

// May this caller WRITE this row? (push authorization — editor role required)
export function mayWrite(access: Access, entity: string, row: Row): boolean {
  if (access === null) return true;
  const editor = (m: Map<string, boolean>, k: unknown) =>
    m.get(String(k)) === true;
  switch (entity) {
    case "users":
      return row.id === access.userId; // own profile
    case "devices":
      return row.user_id === access.userId;
    case "pages":
      // an existing visible page, a new child of an editable page, or their own page
      return editor(access.pages, row.id) ||
        editor(access.pages, row.parent_id) ||
        row.owner_id === access.userId;
    case "page_comments":
      // author pinned to the caller — a guest must not write as someone else
      return editor(access.pages, row.page_id) &&
        row.author_id === access.userId;
    case "udb_databases":
      return editor(access.dbs, row.id) || editor(access.pages, row.page_id);
    case "udb_properties":
    case "udb_rows":
      return editor(access.dbs, row.db_id);
    case "udb_links":
      return editor(access.props, row.prop_id);
    default: // incl. page_shares: only members manage shares
      return false;
  }
}

// Every id under a page (the page, descendants, comments, shares, attached dbs) —
// used to tombstone a revoked subtree. Walks the CURRENT pages table, access-
// independent. `key`/`keyMap` name what still grants the row if another share
// overlaps: a comment lives via its page, a udb row via its database, and so on.
export type SubtreeRow = {
  entity: string;
  id: string;
  key: string;
  keyMap: "pages" | "dbs" | "props";
};

export function stillVisible(access: GuestAccess, r: SubtreeRow): boolean {
  return access[r.keyMap].has(r.key);
}

export async function subtreeIds(db: Q, pageId: string): Promise<SubtreeRow[]> {
  const pages = await db.query(
    `with recursive tree (id) as (
       select id from pages where id = $1
       union
       select p.id from pages p join tree t on p.parent_id = t.id
     )
     select id from tree`,
    [pageId],
  ) as { id: string }[];
  if (!pages.length) return [];
  const ids = pages.map((p) => p.id);
  const ph = ids.map((_, i) => `$${i + 1}`).join(",");
  const out: SubtreeRow[] = pages.map((p) => ({
    entity: "pages",
    id: p.id,
    key: p.id,
    keyMap: "pages" as const,
  }));
  for (
    const [entity, col] of [
      ["page_comments", "page_id"],
      ["page_shares", "page_id"],
      ["udb_databases", "page_id"],
    ] as const
  ) {
    const rows = await db.query(
      `select id, ${col} as key from ${entity} where ${col} in (${ph})`,
      ids,
    ) as { id: string; key: string }[];
    // a database's guard is itself (its id in access.dbs), pages guard the rest
    out.push(...rows.map((r) => ({
      entity,
      id: r.id,
      key: entity === "udb_databases" ? r.id : r.key,
      keyMap: entity === "udb_databases" ? "dbs" as const : "pages" as const,
    })));
  }
  const dbIds = out.filter((o) => o.entity === "udb_databases").map((o) =>
    o.id
  );
  if (dbIds.length) {
    const dph = dbIds.map((_, i) => `$${i + 1}`).join(",");
    for (const entity of ["udb_properties", "udb_rows"] as const) {
      const rows = await db.query(
        `select id, db_id as key from ${entity} where db_id in (${dph})`,
        dbIds,
      ) as { id: string; key: string }[];
      out.push(
        ...rows.map((r) => ({
          entity,
          id: r.id,
          key: r.key,
          keyMap: "dbs" as const,
        })),
      );
    }
    const links = await db.query(
      `select l.id, l.prop_id as key from udb_links l
         join udb_properties p on p.id = l.prop_id
        where p.db_id in (${dph})`,
      dbIds,
    ) as { id: string; key: string }[];
    out.push(...links.map((r) => ({
      entity: "udb_links",
      id: r.id,
      key: r.key,
      keyMap: "props" as const,
    })));
  }
  return out;
}
