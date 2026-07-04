// User-defined databases (Notion-style): fixed physical tables (udb_*), user schemas
// as data. Derived values (formula/rollup) are computed here on read, never stored.
// Formulas are raw SQL expressions: property references are rewritten to jsonb
// extractions and PGlite evaluates them (single-user local app — that's a feature).
import { db } from "./db.ts";
import { NODE_ID } from "./config.ts";

export type UdbProp = {
  id: string;
  db_id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  sort_key: string;
  width: number | null;
};

// Fractional order keys: returns a key strictly between a and b ("" = ±infinity).
// Generated keys never end on the alphabet's first char, so there is always room.
const AB = "0123456789abcdefghijklmnopqrstuvwxyz";
export function midKey(a: string, b: string): string {
  let i = 0, res = "";
  while (true) {
    const ca = i < a.length ? AB.indexOf(a[i]) : 0;
    const cb = i < b.length ? AB.indexOf(b[i]) : AB.length;
    if (ca === cb) {
      res += AB[ca];
      i++;
      continue;
    }
    if (cb - ca > 1) return res + AB[(ca + cb) >> 1];
    // adjacent digits: keep a's digit, then midpoint between the rest of a and +inf
    res += AB[ca];
    i++;
    while (true) {
      const c = i < a.length ? AB.indexOf(a[i]) : 0;
      if (AB.length - c > 1) return res + AB[(c + AB.length) >> 1];
      res += AB[c];
      i++;
    }
  }
}

async function nextKey(table: "udb_databases" | "udb_properties" | "udb_rows", dbId?: string): Promise<string> {
  const pg = await db();
  const where = dbId ? `where db_id=$1 and not deleted` : `where not deleted`;
  const last = (await pg.query(
    `select max(sort_key) as k from ${table} ${where}`,
    dbId ? [dbId] : [],
  )).rows[0] as { k: string | null };
  return midKey(last.k ?? "", "");
}

// databases

export async function listUdbs() {
  const pg = await db();
  return (await pg.query(
    `select d.id, d.name, d.icon, d.page_id, d.sort_key,
            (select count(*)::int from udb_rows r where r.db_id = d.id and not r.deleted) as row_count
       from udb_databases d where not d.deleted order by d.sort_key, d.name`,
  )).rows;
}

export async function createUdb(name: string): Promise<string> {
  const pg = await db();
  const key = await nextKey("udb_databases");
  const row = (await pg.query(
    `insert into udb_databases (name, sort_key, origin) values ($1,$2,$3) returning id`,
    [name, key, NODE_ID],
  )).rows[0] as { id: string };
  await pg.query(
    `insert into udb_properties (db_id, name, type, sort_key, origin) values ($1,'Name','title',$2,$3)`,
    [row.id, midKey("", ""), NODE_ID],
  );
  return row.id;
}

export async function updateUdb(id: string, patch: { name?: string; icon?: string | null }): Promise<void> {
  const pg = await db();
  await pg.query(
    `update udb_databases set name = coalesce($2, name),
            icon = case when $4 then $3 else icon end,
            origin=$5, updated_at=now() where id=$1`,
    [id, patch.name ?? null, patch.icon ?? null, "icon" in patch, NODE_ID],
  );
}

export async function deleteUdb(id: string): Promise<void> {
  const pg = await db();
  // links under this db's props, links pointing at this db's rows,
  // relation pair props living in OTHER dbs, then props + rows + the db itself.
  await pg.query(
    `update udb_links set deleted=true, origin=$2, updated_at=now()
      where not deleted and (
        prop_id in (select id from udb_properties where db_id=$1)
        or to_row in (select id from udb_rows where db_id=$1)
        or from_row in (select id from udb_rows where db_id=$1))`,
    [id, NODE_ID],
  );
  await pg.query(
    `update udb_properties set deleted=true, origin=$2, updated_at=now()
      where not deleted and (db_id=$1 or (type='relation' and config->>'target_db' = $1::text))`,
    [id, NODE_ID],
  );
  await pg.query(`update udb_rows set deleted=true, origin=$2, updated_at=now() where db_id=$1 and not deleted`, [id, NODE_ID]);
  await pg.query(`update udb_databases set deleted=true, origin=$2, updated_at=now() where id=$1`, [id, NODE_ID]);
}

// properties

async function propsOf(dbId: string): Promise<UdbProp[]> {
  const pg = await db();
  return (await pg.query(
    `select id, db_id, name, type, config, sort_key, width
       from udb_properties where db_id=$1 and not deleted order by sort_key, name`,
    [dbId],
  )).rows as UdbProp[];
}

export async function createProperty(
  dbId: string,
  p: { name: string; type: string; config?: Record<string, unknown> },
): Promise<string> {
  const pg = await db();
  const config = p.config ?? {};

  if (p.type === "formula") {
    rewriteFormula(String(config.expr ?? ""), await propsOf(dbId)); // throws on bad expr
    await validateFormula(String(config.expr ?? ""), await propsOf(dbId));
  }
  if (p.type === "rollup") {
    const rel = (await propsOf(dbId)).find((x) => x.id === config.relation_prop);
    if (!rel || rel.type !== "relation") throw new Error("rollup: relation_prop must be a relation property of this database");
    if (config.agg !== "count" && !config.target_prop) throw new Error("rollup: target_prop required");
  }

  const key = await nextKey("udb_properties", dbId);
  const row = (await pg.query(
    `insert into udb_properties (db_id, name, type, config, sort_key, origin)
     values ($1,$2,$3,$4,$5,$6) returning id`,
    [dbId, p.name, p.type, JSON.stringify(config), key, NODE_ID],
  )).rows[0] as { id: string };

  if (p.type === "relation") {
    const target = String(config.target_db ?? "");
    if (!target) throw new Error("relation: config.target_db required");
    const srcName = (await pg.query(`select name from udb_databases where id=$1`, [dbId])).rows[0] as { name: string };
    const reverseName = String(config.reverse_name ?? srcName.name);
    const revKey = await nextKey("udb_properties", target);
    const rev = (await pg.query(
      `insert into udb_properties (db_id, name, type, config, sort_key, origin)
       values ($1,$2,'relation',$3,$4,$5) returning id`,
      [target, reverseName, JSON.stringify({ target_db: dbId, pair: row.id, owner: false }), revKey, NODE_ID],
    )).rows[0] as { id: string };
    await pg.query(
      `update udb_properties set config = config || $2::jsonb, origin=$3, updated_at=now() where id=$1`,
      [row.id, JSON.stringify({ target_db: target, pair: rev.id, owner: true }), NODE_ID],
    );
  }
  return row.id;
}

export async function updateProperty(
  id: string,
  patch: { name?: string; config?: Record<string, unknown>; width?: number | null; sort_key?: string },
): Promise<void> {
  const pg = await db();
  const cur = (await pg.query(`select db_id, type, config from udb_properties where id=$1 and not deleted`, [id]))
    .rows[0] as { db_id: string; type: string; config: Record<string, unknown> } | undefined;
  if (!cur) throw new Error("property not found");
  if (cur.type === "formula" && patch.config && "expr" in patch.config) {
    await validateFormula(String(patch.config.expr ?? ""), await propsOf(cur.db_id));
  }
  await pg.query(
    `update udb_properties set
       name = coalesce($2, name),
       config = case when $3::jsonb is null then config else config || $3::jsonb end,
       width = case when $6 then $4 else width end,
       sort_key = coalesce($5, sort_key),
       origin=$7, updated_at=now()
     where id=$1`,
    [id, patch.name ?? null, patch.config ? JSON.stringify(patch.config) : null,
      patch.width ?? null, patch.sort_key ?? null, "width" in patch, NODE_ID],
  );
}

export async function deleteProperty(id: string): Promise<void> {
  const pg = await db();
  const cur = (await pg.query(`select type, config from udb_properties where id=$1 and not deleted`, [id]))
    .rows[0] as { type: string; config: Record<string, unknown> } | undefined;
  if (!cur) return;
  const ids = [id];
  if (cur.type === "relation" && cur.config.pair) ids.push(String(cur.config.pair));
  const ownerId = cur.type === "relation" ? (cur.config.owner ? id : String(cur.config.pair)) : null;
  if (ownerId) {
    await pg.query(
      `update udb_links set deleted=true, origin=$2, updated_at=now() where prop_id=$1 and not deleted`,
      [ownerId, NODE_ID],
    );
  }
  await pg.query(
    `update udb_properties set deleted=true, origin=$2, updated_at=now() where id = any($1::uuid[])`,
    [ids, NODE_ID],
  );
}

// rows

export async function createRow(dbId: string, vals?: Record<string, unknown>, icon?: string | null): Promise<string> {
  const pg = await db();
  const key = await nextKey("udb_rows", dbId);
  const row = (await pg.query(
    `insert into udb_rows (db_id, icon, vals, sort_key, origin) values ($1,$2,$3,$4,$5) returning id`,
    [dbId, icon ?? null, JSON.stringify(vals ?? {}), key, NODE_ID],
  )).rows[0] as { id: string };
  return row.id;
}

// merge vals patch; JSON null clears a cell (checkbox false survives — only null is stripped).
// icon: undefined = leave as is, null = remove, string = set.
export async function patchRow(id: string, valsPatch: Record<string, unknown>, icon?: string | null): Promise<void> {
  const pg = await db();
  await pg.query(
    `update udb_rows set
       vals = jsonb_strip_nulls(vals || $2::jsonb),
       icon = case when $4 then $3 else icon end,
       origin=$5, updated_at=now()
     where id=$1`,
    [id, JSON.stringify(valsPatch), icon ?? null, icon !== undefined, NODE_ID],
  );
}

export async function deleteRow(id: string): Promise<void> {
  const pg = await db();
  await pg.query(
    `update udb_links set deleted=true, origin=$2, updated_at=now()
      where not deleted and (from_row=$1 or to_row=$1)`,
    [id, NODE_ID],
  );
  await pg.query(`update udb_rows set deleted=true, origin=$2, updated_at=now() where id=$1`, [id, NODE_ID]);
}

// links

export async function setLink(propId: string, fromRow: string, toRow: string, remove = false): Promise<void> {
  const pg = await db();
  const prop = (await pg.query(`select type, config from udb_properties where id=$1 and not deleted`, [propId]))
    .rows[0] as { type: string; config: Record<string, unknown> } | undefined;
  if (!prop || prop.type !== "relation") throw new Error("not a relation property");
  // links live under the owner side only; the reverse side swaps direction
  let owner = propId, from = fromRow, to = toRow;
  if (!prop.config.owner) {
    owner = String(prop.config.pair);
    [from, to] = [toRow, fromRow];
  }
  if (remove) {
    await pg.query(
      `update udb_links set deleted=true, origin=$4, updated_at=now()
        where prop_id=$1 and from_row=$2 and to_row=$3 and not deleted`,
      [owner, from, to, NODE_ID],
    );
    return;
  }
  const existing = (await pg.query(
    `select id from udb_links where prop_id=$1 and from_row=$2 and to_row=$3 limit 1`,
    [owner, from, to],
  )).rows[0] as { id: string } | undefined;
  if (existing) {
    await pg.query(
      `update udb_links set deleted=false, origin=$2, updated_at=now() where id=$1`,
      [existing.id, NODE_ID],
    );
  } else {
    await pg.query(
      `insert into udb_links (prop_id, from_row, to_row, origin) values ($1,$2,$3,$4)`,
      [owner, from, to, NODE_ID],
    );
  }
}

// distinct image icons in use across rows and databases — the "Icons" tab gallery
export async function listIcons(): Promise<string[]> {
  const pg = await db();
  const rows = (await pg.query(
    `select icon from (
       select icon, updated_at from udb_rows where icon is not null and not deleted
       union all
       select icon, updated_at from udb_databases where icon is not null and not deleted
     ) t
     where icon like 'data:%' or icon like 'http%'
     group by icon order by max(updated_at) desc limit 60`,
  )).rows as { icon: string }[];
  return rows.map((r) => r.icon);
}

// formulas — SQL expressions. Property references (bare identifiers or "Quoted Names")
// are rewritten to jsonb extractions on alias r; everything else passes through to PG.

const SQL_WORDS = new Set([
  "case", "when", "then", "else", "end", "and", "or", "not", "null", "true", "false",
  "is", "in", "like", "ilike", "between", "symmetric", "distinct", "as", "from",
  "interval", "epoch", "year", "month", "day", "dow", "doy", "hour", "minute", "second",
  "week", "quarter", "numeric", "int", "integer", "bigint", "float", "text", "boolean",
  "date", "timestamptz", "timestamp",
]);

function rewriteFormula(expr: string, props: UdbProp[]): string {
  if (!expr.trim()) throw new Error("empty formula");
  const referencable = props.filter((p) => !["formula", "rollup", "relation"].includes(p.type));
  const byName = new Map(referencable.map((p) => [p.name.toLowerCase(), p]));
  const sub = (p: UdbProp): string =>
    p.type === "number"
      ? `(r.vals->>'${p.id}')::numeric`
      : p.type === "checkbox"
      ? `coalesce((r.vals->>'${p.id}')::boolean, false)`
      : p.type === "date"
      ? `(r.vals#>>'{${p.id},start}')::timestamptz`
      : `(r.vals->>'${p.id}')`;
  let out = "", i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === ";") throw new Error("';' is not allowed in a formula");
    if (ch === "'") { // string literal ('' escapes)
      let j = i + 1;
      while (j < expr.length && !(expr[j] === "'" && expr[j + 1] !== "'")) j += expr[j] === "'" ? 2 : 1;
      if (j >= expr.length) throw new Error("unterminated string literal");
      out += expr.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '"') { // quoted property name
      const j = expr.indexOf('"', i + 1);
      if (j < 0) throw new Error('unterminated " in formula');
      const name = expr.slice(i + 1, j);
      const p = byName.get(name.toLowerCase());
      if (!p) throw new Error(`unknown property "${name}" (formulas may reference stored properties only)`);
      out += sub(p);
      i = j + 1;
      continue;
    }
    const m = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(expr.slice(i));
    if (m) {
      const word = m[0];
      const isFn = /^\s*\(/.test(expr.slice(i + word.length));
      const lower = word.toLowerCase();
      if (isFn || SQL_WORDS.has(lower)) out += word;
      else {
        const p = byName.get(lower) ?? byName.get(lower.replace(/_/g, " "));
        if (!p) throw new Error(`unknown identifier "${word}" — not a property or SQL keyword`);
        out += sub(p);
      }
      i += word.length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export async function validateFormula(expr: string, props: UdbProp[]): Promise<string> {
  const rewritten = rewriteFormula(expr, props); // throws on unknown identifiers
  const pg = await db();
  try {
    await pg.query(`select (${rewritten}) as v from (select '{}'::jsonb as vals) r`);
  } catch (e) {
    throw new Error(`invalid formula: ${(e as Error).message}`);
  }
  return rewritten;
}

// the big read

export async function getUdb(dbId: string) {
  const pg = await db();
  const dbRow = (await pg.query(
    `select id, name, icon from udb_databases where id=$1 and not deleted`,
    [dbId],
  )).rows[0];
  if (!dbRow) return null;
  const properties = await propsOf(dbId);
  const rows = (await pg.query(
    `select id, icon, vals, sort_key from udb_rows where db_id=$1 and not deleted order by sort_key, id`,
    [dbId],
  )).rows as { id: string; icon: string | null; vals: Record<string, unknown>; sort_key: string }[];

  // relation resolution: title chips of linked rows, per relation property
  const relProps = properties.filter((p) => p.type === "relation");
  const targetDbs = [...new Set(relProps.map((p) => String(p.config.target_db)))];
  const titleProps = targetDbs.length
    ? (await pg.query(
      `select id, db_id from udb_properties where type='title' and not deleted and db_id = any($1::uuid[])`,
      [targetDbs],
    )).rows as { id: string; db_id: string }[]
    : [];
  const titleOf = new Map(titleProps.map((t) => [t.db_id, t.id]));

  const relations: Record<string, Record<string, { id: string; title: string }[]>> = {};
  for (const p of relProps) {
    const ownerId = p.config.owner ? p.id : String(p.config.pair);
    const [rowCol, tgtCol] = p.config.owner ? ["from_row", "to_row"] : ["to_row", "from_row"];
    const titleProp = titleOf.get(String(p.config.target_db)) ?? "";
    const links = (await pg.query(
      `select l.${rowCol} as row_id, t.id, coalesce(t.vals->>$2, '') as title
         from (select distinct from_row, to_row from udb_links where prop_id=$1 and not deleted) l
         join udb_rows t on t.id = l.${tgtCol} and not t.deleted
        order by t.sort_key`,
      [ownerId, titleProp],
    )).rows as { row_id: string; id: string; title: string }[];
    const byRow: Record<string, { id: string; title: string }[]> = {};
    for (const l of links) (byRow[l.row_id] ??= []).push({ id: l.id, title: l.title });
    relations[p.id] = byRow;
  }

  // derived values: formulas + rollups, one query per property, errors contained per column
  const derived: Record<string, Record<string, unknown>> = {};
  for (const p of properties.filter((x) => x.type === "formula")) {
    try {
      const rewritten = rewriteFormula(String(p.config.expr ?? ""), properties);
      const vals = (await pg.query(
        `select id, (${rewritten}) as val from udb_rows r where db_id=$1 and not deleted`,
        [dbId],
      )).rows as { id: string; val: unknown }[];
      derived[p.id] = Object.fromEntries(vals.map((v) => [v.id, v.val]));
    } catch (e) {
      derived[p.id] = Object.fromEntries(rows.map((r) => [r.id, { error: (e as Error).message }]));
    }
  }
  for (const p of properties.filter((x) => x.type === "rollup")) {
    try {
      derived[p.id] = await rollup(p, properties);
    } catch (e) {
      derived[p.id] = Object.fromEntries(rows.map((r) => [r.id, { error: (e as Error).message }]));
    }
  }

  return {
    db: dbRow,
    properties,
    rows: rows.map((r) => ({
      ...r,
      relations: Object.fromEntries(relProps.map((p) => [p.id, relations[p.id]?.[r.id] ?? []])),
      derived: Object.fromEntries(Object.keys(derived).map((pid) => [pid, derived[pid][r.id] ?? null])),
    })),
  };
}

async function rollup(p: UdbProp, props: UdbProp[]): Promise<Record<string, unknown>> {
  const pg = await db();
  const cfg = p.config as { relation_prop?: string; target_prop?: string; agg?: string; date_prop?: string };
  const rel = props.find((x) => x.id === cfg.relation_prop && x.type === "relation");
  if (!rel) throw new Error("rollup: relation property missing");
  const ownerId = rel.config.owner ? rel.id : String(rel.config.pair);
  const [rowCol, tgtCol] = rel.config.owner ? ["from_row", "to_row"] : ["to_row", "from_row"];
  // distinct links first: cross-node duplicate links must not double-count aggregates
  const linkSrc = `(select distinct ${rowCol} as row_id, ${tgtCol} as tgt
                      from udb_links where prop_id=$1 and not deleted) l
                   join udb_rows t on t.id = l.tgt and not t.deleted`;
  const agg = cfg.agg ?? "count";
  let sql: string;
  if (agg === "count") {
    sql = `select l.row_id, count(*)::int as val from ${linkSrc} group by l.row_id`;
  } else if (agg === "latest") {
    const dateExpr = cfg.date_prop
      ? `coalesce((t.vals#>>'{${cfg.date_prop},start}')::timestamptz, t.updated_at)`
      : `t.updated_at`;
    sql = `select distinct on (l.row_id) l.row_id, t.vals->>'${cfg.target_prop}' as val
             from ${linkSrc} order by l.row_id, ${dateExpr} desc`;
  } else if (["sum", "avg", "min", "max"].includes(agg)) {
    sql = `select l.row_id, ${agg}((t.vals->>'${cfg.target_prop}')::numeric) as val
             from ${linkSrc} group by l.row_id`;
  } else {
    throw new Error(`rollup: unknown agg "${agg}"`);
  }
  const vals = (await pg.query(sql, [ownerId])).rows as { row_id: string; val: unknown }[];
  return Object.fromEntries(vals.map((v) => [v.row_id, v.val]));
}
