// `tramecli db rows <db>` — write database rows (JSON on stdin); a row with an id
// merges into it, one without is created. Cells may be keyed by column name.
import { apiRequest, resolveTarget } from "./target.ts";

export type RowInput = {
  id?: string;
  vals: Record<string, unknown>;
  icon?: string | null;
};
type Prop = { id: string; name: string; type: string };

const READ_ONLY = new Set(["relation", "formula", "rollup"]);

// vals keyed by property id or exact column name → keyed by property id
export function resolveVals(
  vals: Record<string, unknown>,
  props: Prop[],
): Record<string, unknown> {
  const byId = new Map(props.map((p) => [p.id, p]));
  const byName = new Map(props.map((p) => [p.name, p]));
  return Object.fromEntries(Object.entries(vals).map(([k, v]) => {
    const p = byId.get(k) ?? byName.get(k);
    if (!p) throw new Error(`unknown column "${k}" — have: ${props.map((p) => p.name).join(", ")}`);
    if (READ_ONLY.has(p.type)) {
      throw new Error(`column "${p.name}" is a ${p.type} — not writable through vals (see \`tramecli db\`)`);
    }
    return [p.id, v];
  }));
}

export async function writeRows(db: string, rows: RowInput[]): Promise<{ id: string; created: boolean }[]> {
  const target = await resolveTarget();
  const { properties } = await apiRequest(target, `/api/udb/${db}`) as { properties: Prop[] };
  const resolved = rows.map((r) => {
    if (!r?.vals || typeof r.vals !== "object") throw new Error("every row needs a vals object");
    return { ...r, vals: resolveVals(r.vals, properties) };
  });
  const out = [];
  for (const { id, vals, icon } of resolved) {
    const body = JSON.stringify(icon === undefined ? { vals } : { vals, icon });
    const init = { method: "POST", headers: { "content-type": "application/json" }, body };
    if (id) {
      await apiRequest(target, `/api/udb/rows/${id}`, init);
      out.push({ id, created: false });
    } else {
      const res = await apiRequest(target, `/api/udb/${db}/rows`, init) as { id: string };
      out.push({ id: res.id, created: true });
    }
  }
  return out;
}

export async function main(argv: string[], json: boolean): Promise<void> {
  const [sub, db] = argv;
  if (sub !== "rows" || !db) throw new Error("usage: tramecli db rows <db-id> < rows.json");
  const input = JSON.parse(await new Response(Deno.stdin.readable).text()) as RowInput | RowInput[];
  const written = await writeRows(db, Array.isArray(input) ? input : [input]);
  if (json) console.log(JSON.stringify(written));
  else for (const w of written) console.log(`ok: row ${w.id} ${w.created ? "created" : "updated"}`);
}
