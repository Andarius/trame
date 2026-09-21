// The pure half of database views: value extraction, filtering, multi-sort,
// grouping and aggregation. Split out of view.tsx so `deno test` can reach it —
// Deno has no JSX types configured, so a test that transitively imports a .tsx
// fails to type check. view.tsx re-exports everything here, so import sites are
// unchanged.
import type { UdbProp, UdbRow } from "../api.ts";
import type { ChartConfig } from "./chart.ts";

export type Sort = { propId: string; dir: 1 | -1 };
export type FilterOp =
  | "contains"
  | "not_contains"
  | "is"
  | "is_not"
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "on"
  | "before"
  | "after"
  | "checked"
  | "unchecked"
  | "empty"
  | "not_empty";
export type Filter = { propId: string; op: FilterOp; value?: string };
export type Agg = "sum" | "avg" | "min" | "max";
// summary: when grouped, collapse to one read-only row per group (a live aggregate table, no raw rows)
// chart: render the same aggregates as marks instead of a grid (see chart.ts)
export type ViewConfig = {
  sorts: Sort[];
  filters: Filter[];
  groupBy?: string | null;
  aggs?: Record<string, Agg | null>;
  summary?: boolean;
  chart?: ChartConfig;
  hidden?: string[]; // property ids not rendered in this tab's grid
};

// operator menus per property category, plus which ops need a value input
const OPS = {
  text: ["contains", "not_contains", "is", "is_not", "empty", "not_empty"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "empty", "not_empty"],
  select: ["is", "is_not", "empty", "not_empty"],
  multi: ["contains", "not_contains", "empty", "not_empty"],
  checkbox: ["checked", "unchecked"],
  date: ["on", "before", "after", "empty", "not_empty"],
  relation: ["contains", "not_contains", "empty", "not_empty"],
  derived: ["contains", "is", "gt", "lt", "empty", "not_empty"],
} as const;
type Cat = keyof typeof OPS;
const CAT: Record<string, Cat> = {
  title: "text",
  text: "text",
  url: "text",
  number: "number",
  formula: "derived",
  rollup: "derived",
  select: "select",
  multi_select: "multi",
  checkbox: "checkbox",
  date: "date",
  relation: "relation",
};
export const OP_LABEL: Record<FilterOp, string> = {
  contains: "contains",
  not_contains: "does not contain",
  is: "is",
  is_not: "is not",
  eq: "=",
  neq: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  on: "is",
  before: "before",
  after: "after",
  checked: "is checked",
  unchecked: "is unchecked",
  empty: "is empty",
  not_empty: "is not empty",
};
export const NO_VALUE = new Set<FilterOp>([
  "empty",
  "not_empty",
  "checked",
  "unchecked",
]);
const catOf = (p: UdbProp): Cat => CAT[p.type] ?? "text";
export const opsFor = (p: UdbProp): readonly FilterOp[] => OPS[catOf(p)];

// value extraction

const dateStart = (
  v: unknown,
): string => (typeof v === "object" && v
  ? (v as { start?: string }).start ?? ""
  : String(v ?? ""));
const textOf = (p: UdbProp, r: UdbRow): string =>
  p.type === "formula" || p.type === "rollup"
    ? String(r.derived[p.id] ?? "")
    : String(r.vals[p.id] ?? "");
export const numOf = (p: UdbProp, r: UdbRow): number | null => {
  const raw = p.type === "formula" || p.type === "rollup"
    ? r.derived[p.id]
    : r.vals[p.id];
  // an empty cell is not a zero: Number(null) is 0, which would drag an average
  // down and draw a missing measurement as a real point
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
};

export function isEmpty(p: UdbProp, r: UdbRow): boolean {
  if (p.type === "formula" || p.type === "rollup") {
    const d = r.derived[p.id];
    return d == null || d === "" || typeof d === "object";
  }
  if (p.type === "relation") return (r.relations[p.id] ?? []).length === 0;
  const v = r.vals[p.id];
  if (v == null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (p.type === "date") return !dateStart(v);
  return false;
}

// sort

// comparable primitive; null (empty/error) always sorts last regardless of direction.
function sortValue(p: UdbProp, r: UdbRow): number | string | null {
  if (isEmpty(p, r)) return null;
  if (p.type === "formula" || p.type === "rollup") {
    const d = r.derived[p.id];
    return typeof d === "object" ? null : d as number | string;
  }
  if (p.type === "relation") {
    return (r.relations[p.id] ?? []).map((c) => c.title).join(", ")
      .toLowerCase();
  }
  const v = r.vals[p.id];
  switch (p.type) {
    case "number":
      return typeof v === "number" ? v : Number(v);
    case "checkbox":
      return v ? 1 : 0;
    case "date":
      return dateStart(v);
    case "select":
      return (p.config.options ?? []).findIndex((o) => o.id === v);
    case "multi_select": {
      const first = Array.isArray(v) ? v[0] : undefined;
      return (p.config.options ?? []).findIndex((o) => o.id === first);
    }
    default:
      return String(v).toLowerCase();
  }
}

function compareOne(p: UdbProp, a: UdbRow, b: UdbRow, dir: 1 | -1): number {
  const av = sortValue(p, a), bv = sortValue(p, b);
  if (av === null || bv === null) return av === bv ? 0 : av === null ? 1 : -1;
  const cmp = typeof av === "number" && typeof bv === "number"
    ? av - bv
    : av < bv
    ? -1
    : av > bv
    ? 1
    : 0;
  return cmp * dir;
}

// filter

function passes(p: UdbProp, r: UdbRow, f: Filter): boolean {
  if (f.op === "empty") return isEmpty(p, r);
  if (f.op === "not_empty") return !isEmpty(p, r);
  if (f.op === "checked") return r.vals[p.id] === true;
  if (f.op === "unchecked") return r.vals[p.id] !== true;
  if (isEmpty(p, r)) return false; // any value-based op fails on an empty cell
  const val = (f.value ?? "").trim();
  if (!val) return true; // half-filled rule is a no-op, not a "match nothing"

  if (p.type === "select") {
    const id = r.vals[p.id];
    return f.op === "is_not" ? id !== val : id === val;
  }
  if (p.type === "multi_select") {
    const has = ((r.vals[p.id] as string[]) ?? []).includes(val);
    return f.op === "not_contains" ? !has : has;
  }
  if (p.type === "relation") {
    const needle = val.toLowerCase();
    const hit = (r.relations[p.id] ?? []).some((c) =>
      c.title.toLowerCase().includes(needle)
    );
    return f.op === "not_contains" ? !hit : hit;
  }
  if (p.type === "date") {
    const d = dateStart(r.vals[p.id]).slice(0, 10), t = val.slice(0, 10);
    if (f.op === "before") return d < t;
    if (f.op === "after") return d > t;
    return d === t; // "on"
  }
  if (["eq", "neq", "gt", "gte", "lt", "lte"].includes(f.op)) {
    const num = numOf(p, r), target = Number(val);
    if (num === null || Number.isNaN(target)) return true;
    switch (f.op) {
      case "eq":
        return num === target;
      case "neq":
        return num !== target;
      case "gt":
        return num > target;
      case "gte":
        return num >= target;
      case "lt":
        return num < target;
      case "lte":
        return num <= target;
    }
  }
  const text = textOf(p, r).toLowerCase(), needle = val.toLowerCase();
  switch (f.op) {
    case "contains":
      return text.includes(needle);
    case "not_contains":
      return !text.includes(needle);
    case "is":
      return text === needle;
    case "is_not":
      return text !== needle;
  }
  return true;
}

// group by

export type Group = {
  key: string;
  label: string;
  color?: string;
  rows: UdbRow[];
};

// Partition rows into groups keyed by the property's value; empty cells collect
// into a trailing "(empty)" group. Select groups follow the option order.
export function groupRows(rows: UdbRow[], p: UdbProp): Group[] {
  const map = new Map<string, Group>();
  const add = (
    key: string,
    label: string,
    color: string | undefined,
    r: UdbRow,
  ) => {
    let g = map.get(key);
    if (!g) map.set(key, g = { key, label, color, rows: [] });
    g.rows.push(r);
  };
  const opts = p.config.options ?? [];
  for (const r of rows) {
    if (isEmpty(p, r)) {
      add("\0", "(empty)", undefined, r);
      continue;
    }
    if (p.type === "select") {
      const id = String(r.vals[p.id]);
      const o = opts.find((x) => x.id === id);
      add(id, o?.name ?? id, o?.color, r);
    } else if (p.type === "multi_select") {
      const label = ((r.vals[p.id] as string[]) ?? []).map((id) =>
        opts.find((x) => x.id === id)?.name ?? id
      ).join(", ");
      add(label.toLowerCase(), label, undefined, r);
    } else if (p.type === "relation") {
      const label = (r.relations[p.id] ?? []).map((c) => c.title).join(", ");
      add(label.toLowerCase(), label, undefined, r);
    } else if (p.type === "checkbox") {
      const b = r.vals[p.id] === true;
      add(b ? "1" : "0", b ? "Checked" : "Unchecked", undefined, r);
    } else if (p.type === "date") {
      const d = dateStart(r.vals[p.id]).slice(0, 10);
      add(d, d, undefined, r);
    } else {
      const label = textOf(p, r);
      add(label.toLowerCase(), label, undefined, r);
    }
  }
  const empty = map.get("\0");
  const rest = [...map.values()].filter((g) => g !== empty);
  if (p.type === "select") {
    const order = new Map(opts.map((o, i) => [o.id, i]));
    rest.sort((a, b) =>
      (order.get(a.key) ?? opts.length) - (order.get(b.key) ?? opts.length)
    );
  } else if (p.type === "number") {
    rest.sort((a, b) => Number(a.label) - Number(b.label));
  } else if (p.type === "checkbox") {
    rest.sort((a, b) => b.key.localeCompare(a.key)); // checked first
  } else {
    rest.sort((a, b) => a.label.localeCompare(b.label));
  }
  return empty ? [...rest, empty] : rest;
}

export const AGGREGATABLE = new Set(["number", "formula", "rollup"]);

export function aggregate(rows: UdbRow[], p: UdbProp, agg: Agg): number | null {
  const nums = rows.map((r) => numOf(p, r)).filter((n): n is number =>
    n !== null
  );
  if (!nums.length) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  switch (agg) {
    case "sum":
      return sum;
    case "avg":
      return sum / nums.length;
    case "min":
      return Math.min(...nums);
    case "max":
      return Math.max(...nums);
  }
}

export const fmtAgg = (
  n: number,
): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));

// Apply filters (AND) then multi-sort. Returns a new array; input order preserved for ties.
export function applyView(
  rows: UdbRow[],
  props: UdbProp[],
  view: ViewConfig,
): UdbRow[] {
  const byId = new Map(props.map((p) => [p.id, p]));
  const active = view.filters.filter((f) => byId.has(f.propId));
  let out = active.length
    ? rows.filter((r) => active.every((f) => passes(byId.get(f.propId)!, r, f)))
    : rows;
  const sorts = view.sorts.filter((s) => byId.has(s.propId));
  if (sorts.length) {
    out = [...out].sort((a, b) => {
      for (const s of sorts) {
        const c = compareOne(byId.get(s.propId)!, a, b, s.dir);
        if (c) return c;
      }
      return 0;
    });
  }
  return out;
}
