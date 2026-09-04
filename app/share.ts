// Share a page across Trame instances (separate hubs, no shared server): export a
// page's whole subtree — sub-pages, attached/inline databases, their properties, rows
// and relation links — into a portable JSON bundle, and import it back on the other end.
// Import remaps every id to a fresh one (so re-importing never collides with existing
// rows and the copy is owned by this node), rewriting all cross-references as it goes.
import { db } from "./db.ts";
import { NODE_ID } from "./config.ts";
import { getIdentity } from "./identity.ts";
import { midKey } from "./udb.ts";

export const BUNDLE_TAG = "trame-page-bundle";

type Json = Record<string, unknown>;
type PageRow = {
  id: string;
  parent_id: string | null;
  kind: string;
  title: string;
  icon: string | null;
  brief: string;
  client_id: string | null;
  status: string;
  content: Json[];
  sort_key: string;
  color: string | null;
};
type DbRow = {
  id: string;
  name: string;
  icon: string | null;
  sort_key: string;
  views: unknown;
  page_id: string | null;
};
type PropRow = {
  id: string;
  db_id: string;
  name: string;
  type: string;
  config: Json;
  sort_key: string;
  width: number | null;
};
type RowRow = {
  id: string;
  db_id: string;
  icon: string | null;
  vals: Json;
  sort_key: string;
};
type LinkRow = {
  id: string;
  prop_id: string;
  from_row: string;
  to_row: string;
};

export type Bundle = {
  trame: typeof BUNDLE_TAG;
  version: 1;
  exported_at: string;
  root: string;
  pages: PageRow[];
  databases: DbRow[];
  properties: PropRow[];
  rows: RowRow[];
  links: LinkRow[];
};

// Gather the full subtree. Returns null if the page doesn't exist.
export async function exportPage(id: string): Promise<Bundle | null> {
  const pg = await db();
  const pages = (await pg.query<PageRow>(
    `with recursive sub as (
       select * from pages where id=$1 and not deleted
       union all
       select p.* from pages p join sub on p.parent_id = sub.id where not p.deleted
     )
     select id, parent_id, kind, title, icon, brief, client_id, status, content, sort_key, color from sub`,
    [id],
  )).rows;
  if (!pages.length) return null;

  const pageIds = pages.map((p) => p.id);
  // databases: attached to a page in the subtree, plus any referenced by an inline block
  const dbIds = new Set<string>();
  for (const p of pages) {
    for (const b of p.content ?? []) {
      if (b?.type === "database" && typeof b.db_id === "string") {
        dbIds.add(b.db_id);
      }
    }
  }
  for (
    const d of (await pg.query<{ id: string }>(
      `select id from udb_databases where not deleted and page_id = any($1::uuid[])`,
      [pageIds],
    )).rows
  ) {
    dbIds.add(d.id);
  }

  const dbArr = [...dbIds];
  const databases = dbArr.length
    ? (await pg.query<DbRow>(
      `select id, name, icon, sort_key, views, page_id from udb_databases where not deleted and id = any($1::uuid[])`,
      [dbArr],
    )).rows
    : [];
  const properties = dbArr.length
    ? (await pg.query<PropRow>(
      `select id, db_id, name, type, config, sort_key, width from udb_properties where not deleted and db_id = any($1::uuid[])`,
      [dbArr],
    )).rows
    : [];
  const rows = dbArr.length
    ? (await pg.query<RowRow>(
      `select id, db_id, icon, vals, sort_key from udb_rows where not deleted and db_id = any($1::uuid[])`,
      [dbArr],
    )).rows
    : [];
  const propIds = properties.map((p) => p.id);
  const rowIds = rows.map((r) => r.id);
  // links only when both endpoints (and the owner prop) are inside the bundle
  const links = propIds.length && rowIds.length
    ? (await pg.query<LinkRow>(
      `select id, prop_id, from_row, to_row from udb_links
        where not deleted and prop_id = any($1::uuid[]) and from_row = any($2::uuid[]) and to_row = any($2::uuid[])`,
      [propIds, rowIds],
    )).rows
    : [];

  return {
    trame: BUNDLE_TAG,
    version: 1,
    exported_at: new Date().toISOString(),
    root: id,
    pages,
    databases,
    properties,
    rows,
    links,
  };
}

function isBundle(b: unknown): b is Bundle {
  const x = b as Partial<Bundle>;
  return !!x && x.trame === BUNDLE_TAG && typeof x.root === "string" &&
    Array.isArray(x.pages) && Array.isArray(x.databases) &&
    Array.isArray(x.properties) &&
    Array.isArray(x.rows) && Array.isArray(x.links);
}

// End-of-siblings fractional key under `parentId` — mirrors pages.ts so the imported
// root lands last among the target parent's children.
async function endKey(
  pg: Awaited<ReturnType<typeof db>>,
  parentId: string | null,
): Promise<string> {
  const last = (await pg.query<{ k: string | null }>(
    `select max(sort_key) as k from pages where parent_id is not distinct from $1 and not deleted`,
    [parentId],
  )).rows[0];
  return midKey(last?.k ?? "", "");
}

const remapContent = (
  content: Json[],
  pageMap: Map<string, string>,
  dbMap: Map<string, string>,
): Json[] => {
  const out: Json[] = [];
  for (const b of content ?? []) {
    if (b?.type === "subpage") {
      const np = pageMap.get(b.page_id as string);
      if (np) out.push({ ...b, page_id: np });
    } else if (b?.type === "database") {
      const nd = dbMap.get(b.db_id as string);
      if (nd) out.push({ ...b, db_id: nd });
    } else {
      out.push(b);
    }
  }
  return out;
};

// View tabs reference properties by id (sorts/filters/groupBy/aggs). Import mints fresh
// property ids, so rewrite every reference and drop the ones whose property didn't travel.
const remapViews = (views: unknown, propMap: Map<string, string>): unknown => {
  const t = views as { tabs?: unknown[] } | null;
  if (!t || !Array.isArray(t.tabs)) return views ?? [];
  const at = (v: unknown) => (typeof v === "string" ? propMap.get(v) : undefined);
  const keep = (list: unknown[]) =>
    list.flatMap((x) => {
      const np = at((x as { propId?: unknown })?.propId);
      return np ? [{ ...(x as object), propId: np }] : [];
    });
  return {
    ...t,
    tabs: t.tabs.map((tab) => {
      const x = (tab ?? {}) as { config?: Record<string, unknown> };
      const c: Record<string, unknown> = { ...(x.config ?? {}) };
      if (Array.isArray(c.sorts)) c.sorts = keep(c.sorts);
      if (Array.isArray(c.filters)) c.filters = keep(c.filters);
      if (c.groupBy) c.groupBy = at(c.groupBy) ?? null;
      if (c.aggs && typeof c.aggs === "object") {
        c.aggs = Object.fromEntries(
          Object.entries(c.aggs as Record<string, unknown>)
            .flatMap(([k, v]) => {
              const np = propMap.get(k);
              return np ? [[np, v] as const] : [];
            }),
        );
      }
      return { ...x, config: c };
    }),
  };
};

const remapConfig = (
  p: PropRow,
  propMap: Map<string, string>,
  dbMap: Map<string, string>,
): Json => {
  const c: Json = { ...(p.config ?? {}) };
  if (p.type === "relation") {
    if (c.target_db) {
      c.target_db = dbMap.get(String(c.target_db)) ?? c.target_db;
    }
    if (c.pair) c.pair = propMap.get(String(c.pair)) ?? c.pair;
  }
  if (p.type === "rollup") {
    for (const k of ["relation_prop", "target_prop", "date_prop"]) {
      if (c[k]) c[k] = propMap.get(String(c[k])) ?? c[k];
    }
  }
  return c;
};

// Recreate the bundle under `parentId` (null = top level). Returns the new root page id.
export async function importPage(
  bundle: unknown,
  parentId: string | null,
): Promise<string> {
  if (!isBundle(bundle)) throw new Error("not a Trame page bundle");
  const pg = await db();

  const pageMap = new Map(bundle.pages.map((p) => [p.id, crypto.randomUUID()]));
  const dbMap = new Map(
    bundle.databases.map((d) => [d.id, crypto.randomUUID()]),
  );
  const bundledDbs = new Set(bundle.databases.map((d) => d.id));

  // keep a relation only if its target database also travelled with the bundle;
  // otherwise its pair lives in a db we don't have — drop it to avoid a dangling link.
  const keptProps = bundle.properties.filter((p) =>
    p.type !== "relation" || bundledDbs.has(String(p.config?.target_db))
  );
  const keptIds = new Set(keptProps.map((p) => p.id));
  // then drop rollups that reference a property we just dropped
  const finalProps = keptProps.filter((p) => {
    if (p.type !== "rollup") return true;
    const c = p.config ?? {};
    return [c.relation_prop, c.target_prop, c.date_prop].every((ref) =>
      !ref || keptIds.has(String(ref))
    );
  });
  const propMap = new Map(finalProps.map((p) => [p.id, crypto.randomUUID()]));
  const rowMap = new Map(bundle.rows.map((r) => [r.id, crypto.randomUUID()]));

  const rootKey = await endKey(pg, parentId);
  // the import is a copy — the importer becomes its owner
  const ownerId = (await getIdentity()).userId;

  await pg.transaction(async (tx) => {
    for (const p of bundle.pages) {
      const isRoot = p.id === bundle.root;
      const newParent = isRoot
        ? parentId
        : pageMap.get(p.parent_id ?? "") ?? null;
      const clientId = p.client_id && pageMap.has(p.client_id)
        ? pageMap.get(p.client_id)!
        : null;
      await tx.query(
        `insert into pages (id, parent_id, kind, title, icon, brief, client_id, status, content, sort_key, color, owner_id, origin)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          pageMap.get(p.id),
          newParent,
          p.kind,
          p.title,
          p.icon,
          p.brief,
          clientId,
          p.status,
          JSON.stringify(remapContent(p.content, pageMap, dbMap)),
          isRoot ? rootKey : p.sort_key,
          p.color ?? null,
          ownerId,
          NODE_ID,
        ],
      );
    }
    for (const d of bundle.databases) {
      const pageId = d.page_id && pageMap.has(d.page_id)
        ? pageMap.get(d.page_id)!
        : null;
      await tx.query(
        `insert into udb_databases (id, name, icon, sort_key, views, page_id, origin) values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          dbMap.get(d.id),
          d.name,
          d.icon,
          d.sort_key,
          JSON.stringify(remapViews(d.views, propMap)),
          pageId,
          NODE_ID,
        ],
      );
    }
    for (const p of finalProps) {
      await tx.query(
        `insert into udb_properties (id, db_id, name, type, config, sort_key, width, origin) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          propMap.get(p.id),
          dbMap.get(p.db_id),
          p.name,
          p.type,
          JSON.stringify(remapConfig(p, propMap, dbMap)),
          p.sort_key,
          p.width,
          NODE_ID,
        ],
      );
    }
    for (const r of bundle.rows) {
      const vals: Json = {};
      for (const [k, v] of Object.entries(r.vals ?? {})) {
        const nk = propMap.get(k);
        if (nk) vals[nk] = v; // drop cells whose column was dropped
      }
      await tx.query(
        `insert into udb_rows (id, db_id, icon, vals, sort_key, origin) values ($1,$2,$3,$4,$5,$6)`,
        [
          rowMap.get(r.id),
          dbMap.get(r.db_id),
          r.icon,
          JSON.stringify(vals),
          r.sort_key,
          NODE_ID,
        ],
      );
    }
    for (const l of bundle.links) {
      if (
        !propMap.has(l.prop_id) || !rowMap.has(l.from_row) ||
        !rowMap.has(l.to_row)
      ) continue;
      await tx.query(
        `insert into udb_links (id, prop_id, from_row, to_row, origin) values ($1,$2,$3,$4,$5)`,
        [
          crypto.randomUUID(),
          propMap.get(l.prop_id),
          rowMap.get(l.from_row),
          rowMap.get(l.to_row),
          NODE_ID,
        ],
      );
    }
  });

  return pageMap.get(bundle.root)!;
}
