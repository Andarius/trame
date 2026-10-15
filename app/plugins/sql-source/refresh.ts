// One refresh: run the source query read-only, then write only the cells it changed.
// Sync is row-level LWW, so an untouched row must stay untouched (no updated_at bump).
import postgres from "postgres";
import {
  type Ctx,
  createProperty,
  createRow,
  deleteRow,
  getUdb,
  patchRow,
  type UdbProp,
  updateProperty,
} from "../api.ts";

export const MAX_ROWS = 10_000;
export const TIMEOUT_MS = 30_000;

export type Source = {
  id: string;
  name: string;
  dsn: string;
  query: string;
  db_id: string;
  key_column: string;
  interval_min: number;
  delete_missing: boolean;
};

export type SourceColumn = { name: string; type: number }; // type = PostgreSQL type oid
export type SourceResult = { columns: SourceColumn[]; rows: Record<string, unknown>[] };
export type RefreshCounts = { rows: number; created: number; updated: number; deleted: number };

export class SourceError extends Error {}

// Postgres type oids, grouped by the column type they become
const NUMBER_OIDS = new Set([20, 21, 23, 26, 700, 701, 1700]);
const DATE_OIDS = new Set([1082, 1114, 1184]);
const BOOL_OID = 16;
const WRITABLE = new Set(["title", "text", "url", "number", "checkbox", "date"]);

// postgres.js takes no libpq `?host=/socket/dir`; map it to its `path` option
function connectOptions(dsn: string): { url: string; path?: string } {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new SourceError("the connection string is not a postgres:// URL");
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    throw new SourceError("the connection string is not a postgres:// URL");
  }
  const host = url.searchParams.get("host");
  if (!host?.startsWith("/")) return { url: dsn };
  url.searchParams.delete("host");
  return { url: url.toString(), path: `${host}/.s.PGSQL.${url.port || 5432}` };
}

// error text with the connection string and its password masked
export function scrub(message: string, dsn: string): string {
  let out = message;
  try {
    const pass = decodeURIComponent(new URL(dsn).password);
    if (pass) out = out.replaceAll(pass, "***");
  } catch { /* not a URL: nothing to mask beyond the raw string */ }
  return dsn ? out.replaceAll(dsn, "<dsn>") : out;
}

/** Run `query` in a READ ONLY transaction with a statement timeout; refuses past `maxRows`. */
export async function runSourceQuery(
  dsn: string,
  query: string,
  opts: { maxRows?: number; timeoutMs?: number } = {},
): Promise<SourceResult> {
  const maxRows = opts.maxRows ?? MAX_ROWS;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const body = query.trim().replace(/;\s*$/, "");
  if (!body) throw new SourceError("the query is empty");
  const { url, path } = connectOptions(dsn);
  const raw = (x: string) => x;
  const sql = postgres(url, {
    ...(path && { path }),
    max: 1,
    connect_timeout: 10,
    fetch_types: false,
    onnotice: () => {},
    connection: {
      application_name: "trame sql-source",
      default_transaction_read_only: true,
      statement_timeout: Math.floor(timeoutMs),
    },
    // dates and big numbers stay text: no timezone shift, no float rounding before we map them
    types: { raw: { to: 25, from: [20, 1700, 1082, 1114, 1184], serialize: raw, parse: raw } },
  });
  try {
    const rows = await sql.begin("read only", async (tx) => {
      // extended protocol (simple: false): one statement only, nothing can COMMIT out of the read-only txn
      return await tx.unsafe(
        `select * from (\n${body}\n) as sql_source limit ${maxRows + 1}`,
        [],
        { simple: false } as postgres.UnsafeQueryOptions,
      );
    });
    if (rows.length > maxRows) {
      throw new SourceError(`the query returns more than ${maxRows} rows — narrow it`);
    }
    const columns = (rows.columns ?? []).map((c) => ({ name: c.name, type: c.type }));
    return { columns, rows: [...rows] as Record<string, unknown>[] };
  } catch (e) {
    if (e instanceof SourceError) throw e;
    throw new SourceError(scrub(e instanceof Error ? e.message : String(e), dsn));
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

function typeFor(oid: number): string {
  if (oid === BOOL_OID) return "checkbox";
  if (NUMBER_OIDS.has(oid)) return "number";
  if (DATE_OIDS.has(oid)) return "date";
  return "text";
}

/** A source value as the cell shape of a `type` column; null clears the cell. */
export function cellValue(type: string, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  switch (type) {
    case "number": {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    }
    case "checkbox":
      return v === true || v === "t" || v === "true" || v === 1;
    case "date": {
      const s = v instanceof Date ? v.toISOString() : String(v);
      return /^\d{4}-\d{2}-\d{2}/.test(s) ? { start: s.slice(0, 10) } : null;
    }
    default:
      return typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const keyOf = (v: unknown) => (v === null || v === undefined || v === "" ? null : JSON.stringify(v));

type Plan = { prop: UdbProp | null; name: string; type: string; claim: boolean };

/**
 * Write `result` into the source's database: source-owned columns are matched by name
 * (created, or claimed when no source owns them), rows by the key column. Validation runs
 * before the first write, so a refused refresh changes nothing.
 */
export async function applyRefresh(
  ctx: Ctx,
  source: Source,
  result: SourceResult,
): Promise<RefreshCounts> {
  const udb = await getUdb(ctx, source.db_id);
  if (!udb) throw new SourceError("the target database no longer exists");
  const props = udb.properties as UdbProp[];
  if (!result.columns.some((c) => c.name === source.key_column)) {
    throw new SourceError(`key column "${source.key_column}" is not in the query results`);
  }

  const plans: Plan[] = [];
  for (const c of result.columns) {
    const prop = props.find((p) => p.name === c.name) ?? null;
    if (!prop) {
      plans.push({ prop: null, name: c.name, type: typeFor(c.type), claim: false });
      continue;
    }
    const owner = prop.config.source;
    // an explicit null is a detached column: the user took it over
    const theirs = "source" in prop.config && owner !== source.id;
    if (theirs || !WRITABLE.has(prop.type)) {
      if (c.name === source.key_column) {
        throw new SourceError(`key column "${c.name}" is not writable by this source`);
      }
      continue;
    }
    plans.push({ prop, name: c.name, type: prop.type, claim: owner !== source.id });
  }

  const keyPlan = plans.find((p) => p.name === source.key_column)!;
  const keys = result.rows.map((r) => keyOf(cellValue(keyPlan.type, r[source.key_column])));
  const seen = new Set<string>();
  for (const k of keys) {
    if (k === null) throw new SourceError(`key column "${source.key_column}" has empty values`);
    if (seen.has(k)) throw new SourceError(`key column "${source.key_column}" is not unique (${k})`);
    seen.add(k);
  }
  const existing = new Map<string, (typeof udb.rows)[number]>();
  if (keyPlan.prop) {
    for (const r of udb.rows) {
      const k = keyOf(r.vals[keyPlan.prop.id]);
      if (k !== null && !existing.has(k)) existing.set(k, r);
    }
  }

  const counts: RefreshCounts = { rows: result.rows.length, created: 0, updated: 0, deleted: 0 };
  for (const p of plans) {
    if (p.prop && p.claim) {
      await updateProperty(ctx, p.prop.id, { config: { source: source.id } });
    } else if (!p.prop) {
      const id = await createProperty(ctx, source.db_id, {
        name: p.name,
        type: p.type,
        config: { source: source.id },
      });
      p.prop = {
        id,
        db_id: source.db_id,
        name: p.name,
        type: p.type,
        config: { source: source.id },
        sort_key: "",
        width: null,
      };
    }
  }

  for (const [i, r] of result.rows.entries()) {
    const vals: Record<string, unknown> = {};
    for (const p of plans) vals[p.prop!.id] = cellValue(p.type, r[p.name]);
    const row = existing.get(keys[i]!);
    if (!row) {
      await createRow(ctx, source.db_id, Object.fromEntries(Object.entries(vals).filter(([, v]) => v !== null)));
      counts.created++;
      continue;
    }
    const patch = Object.fromEntries(Object.entries(vals).filter(([id, v]) => !same(row.vals[id], v)));
    if (Object.keys(patch).length) {
      await patchRow(ctx, row.id, patch);
      counts.updated++;
    }
  }
  if (source.delete_missing) {
    for (const [k, row] of existing) {
      if (!seen.has(k)) {
        await deleteRow(ctx, row.id);
        counts.deleted++;
      }
    }
  }
  return counts;
}
