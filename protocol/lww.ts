// The LWW apply rule, shared verbatim by both sides so their merge semantics can
// never drift: server `rev` orders delivery; the envelope updated_at resolves values.
import { entityByName } from "./entities.ts";

// jsonb/date params as PG-friendly primitives — portable across postgres.js and PGlite.
export function toParam(v: unknown): unknown {
  if (v !== null && typeof v === "object" && !(v instanceof Date)) {
    return JSON.stringify(v);
  }
  return v;
}

// Parameterized upsert for one entity row: newer updated_at wins, on either engine.
export function lwwUpsert(
  entity: string,
  row: Record<string, unknown>,
): { text: string; params: unknown[] } {
  const e = entityByName.get(entity);
  if (!e) throw new Error(`unknown entity: ${entity}`);
  const cols = e.cols as readonly string[];
  const ph = cols.map((_, i) => `$${i + 1}`).join(",");
  const set = cols.filter((c) => c !== "id").map((c) => `${c}=excluded.${c}`)
    .join(",");
  return {
    text: `insert into ${e.name} (${cols.join(",")}) values (${ph})
           on conflict (id) do update set ${set}
           where excluded.updated_at > ${e.name}.updated_at`,
    params: cols.map((c) => toParam(row[c] ?? null)),
  };
}

// Hard-delete mutations and null-value changes apply as an LWW soft delete.
export function lwwSoftDelete(
  entity: string,
  id: string,
  updatedAt: string,
): { text: string; params: unknown[] } {
  const e = entityByName.get(entity);
  if (!e) throw new Error(`unknown entity: ${entity}`);
  return {
    text: `update ${e.name} set deleted=true, updated_at=$2
           where id=$1 and updated_at < $2`,
    params: [id, updatedAt],
  };
}
