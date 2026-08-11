// Multi-column sort + filter + group-by (with per-group aggregates) for the database table
// (Notion-style views). All client-side over the fetched rows (the stored sort_key order is
// untouched) and persisted per-database in localStorage — see load/saveView. AND-combined filters.
import { useState } from "react";
import type { UdbProp, UdbRow } from "../api";
import { Popover, Select } from "../ui";
import { TYPE_GLYPH } from "./PropertyEditor";

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
export type ViewConfig = {
  sorts: Sort[];
  filters: Filter[];
  groupBy?: string | null;
  aggs?: Record<string, Agg | null>;
  summary?: boolean;
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
const OP_LABEL: Record<FilterOp, string> = {
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
const NO_VALUE = new Set<FilterOp>([
  "empty",
  "not_empty",
  "checked",
  "unchecked",
]);
const catOf = (p: UdbProp): Cat => CAT[p.type] ?? "text";
const opsFor = (p: UdbProp): readonly FilterOp[] => OPS[catOf(p)];

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
const numOf = (p: UdbProp, r: UdbRow): number | null => {
  const raw = p.type === "formula" || p.type === "rollup"
    ? r.derived[p.id]
    : r.vals[p.id];
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

// persistence (per-device, per-db) — named view tabs, each with its own config

export type ViewTab = { id: string; name: string; config: ViewConfig };
export type ViewTabs = { tabs: ViewTab[]; active: string };

const emptyConfig = (): ViewConfig => ({ sorts: [], filters: [] });
const isEmptyConfig = (c: ViewConfig) =>
  !c.sorts.length && !c.filters.length && !c.groupBy;
export const newTab = (
  name: string,
  config: ViewConfig = emptyConfig(),
): ViewTab => ({
  id: crypto.randomUUID(),
  name,
  config,
});
// A summary view: aggregate-only (one read-only row per group), like a DB view.
// Defaults the group-by to the first select/relation, else the first non-title prop.
export const newSummaryTab = (props: UdbProp[]): ViewTab => {
  const groupBy =
    props.find((p) => p.type === "select" || p.type === "relation")?.id ??
      props.find((p) => p.type !== "title")?.id ?? null;
  return newTab("Summary", {
    sorts: [],
    filters: [],
    summary: true,
    groupBy,
    aggs: {},
  });
};

const key = (dbId: string) => `trame:udbtabs:${dbId}`;
// migration chain: udbtabs ← udbview (single config) ← udbsort (single sort)
function legacyView(dbId: string): ViewConfig {
  try {
    const v = JSON.parse(
      localStorage.getItem(`trame:udbview:${dbId}`) ?? "null",
    );
    if (v && Array.isArray(v.sorts) && Array.isArray(v.filters)) return v;
    const old = JSON.parse(
      localStorage.getItem(`trame:udbsort:${dbId}`) ?? "null",
    );
    if (old && typeof old.propId === "string") {
      return { sorts: [old], filters: [] };
    }
  } catch { /* fall through */ }
  return emptyConfig();
}
// validate an untrusted tabs bundle (localStorage OR the server `views` column); null = not usable
export function parseTabs(raw: unknown): ViewTabs | null {
  const v = raw as { tabs?: unknown; active?: unknown } | null;
  if (v && Array.isArray(v.tabs)) {
    const tabs = (v.tabs as ViewTab[]).filter((t) =>
      t && typeof t.id === "string" && t.config
    );
    if (tabs.length) {
      return {
        tabs,
        active: tabs.some((t) => t.id === v.active)
          ? (v.active as string)
          : tabs[0].id,
      };
    }
  }
  return null;
}
// the untouched default (single "Table" tab, no sorts/filters); stored as [] server-side so it reads back as default
export const isDefaultTabs = (v: ViewTabs) =>
  v.tabs.length === 1 && v.tabs[0].name === "Table" &&
  isEmptyConfig(v.tabs[0].config);

export function loadTabs(dbId: string): ViewTabs {
  try {
    const parsed = parseTabs(
      JSON.parse(localStorage.getItem(key(dbId)) ?? "null"),
    );
    if (parsed) return parsed;
  } catch { /* fall through */ }
  const tab = newTab("Table", legacyView(dbId));
  return { tabs: [tab], active: tab.id };
}
export const saveTabs = (dbId: string, v: ViewTabs) => {
  if (isDefaultTabs(v)) localStorage.removeItem(key(dbId));
  else localStorage.setItem(key(dbId), JSON.stringify(v));
  localStorage.removeItem(`trame:udbview:${dbId}`); // superseded by the tabs key
};

// UI

// Named view tabs: click to switch, double-click to rename, ✕ to delete, ＋ to add.
export function ViewTabsBar(
  { state, props, onChange }: {
    state: ViewTabs;
    props: UdbProp[];
    onChange: (v: ViewTabs) => void;
  },
) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);

  const rename = (id: string) => {
    const name = draft.trim();
    if (name) {
      onChange({
        ...state,
        tabs: state.tabs.map((t) => (t.id === id ? { ...t, name } : t)),
      });
    }
    setRenaming(null);
  };
  const add = () => {
    const t = newTab(`View ${state.tabs.length + 1}`);
    onChange({ tabs: [...state.tabs, t], active: t.id });
    setAdding(false);
    setRenaming(t.id);
    setDraft(t.name);
  };
  const addSummary = () => {
    const t = newSummaryTab(props);
    onChange({ tabs: [...state.tabs, t], active: t.id });
    setAdding(false);
  };
  const remove = (id: string) => {
    const tabs = state.tabs.filter((t) => t.id !== id);
    onChange({ tabs, active: state.active === id ? tabs[0].id : state.active });
  };

  return (
    <div className="flex items-center gap-1">
      {state.tabs.map((t) =>
        renaming === t.id
          ? (
            <input
              key={t.id}
              autoFocus
              className="h-6 w-[104px] rounded-md border border-copper/50 bg-panel px-2 text-[11.5px] text-ink outline-none"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={(e) => e.target.select()}
              onBlur={() => rename(t.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter") rename(t.id);
                if (e.key === "Escape") setRenaming(null);
              }}
            />
          )
          : (
            // pill with the delete ✕ inside it, space reserved so hover doesn't shift tabs
            <div
              key={t.id}
              className={`group/tab flex h-6 items-center rounded-md transition-colors ${
                t.id === state.active
                  ? "bg-panel text-ink"
                  : "text-ink-muted hover:bg-panel/50 hover:text-ink-soft"
              }`}
            >
              <button
                type="button"
                className={`pl-2 text-[11.5px] ${
                  t.id === state.active ? "font-medium" : ""
                } ${state.tabs.length > 1 ? "pr-0.5" : "pr-2"}`}
                title="double-click to rename"
                onClick={() =>
                  t.id !== state.active && onChange({ ...state, active: t.id })}
                onDoubleClick={() => {
                  setRenaming(t.id);
                  setDraft(t.name);
                }}
              >
                {t.config.summary && (
                  <span className="mr-1 text-[10px] text-copper">Σ</span>
                )}
                {t.name}
              </button>
              {state.tabs.length > 1 && (
                <button
                  type="button"
                  className="w-5 self-stretch text-[9px] text-ink-muted opacity-0 transition-opacity hover:text-blocked group-hover/tab:opacity-70 hover:!opacity-100"
                  title="delete view tab"
                  onClick={() => remove(t.id)}
                >
                  ✕
                </button>
              )}
            </div>
          )
      )}
      <div className="relative">
        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center rounded-md text-[12px] text-ink-muted/60 transition-colors hover:bg-panel/50 hover:text-ink-soft"
          title="new view"
          onClick={() => setAdding((a) => !a)}
        >
          ＋
        </button>
        {adding && (
          <Popover onClose={() => setAdding(false)} className="w-[168px] p-1">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11.5px] text-ink-soft hover:bg-panel"
              onClick={add}
            >
              <span className="text-[11px] text-ink-muted">▦</span> Table view
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11.5px] text-ink-soft hover:bg-panel"
              onClick={addSummary}
            >
              <span className="text-[11px] text-copper">Σ</span> Summary view
            </button>
            <p className="px-2 pt-1 text-[10px] text-ink-muted/60">
              Summary = one row per group, aggregates only
            </p>
          </Popover>
        )}
      </div>
    </div>
  );
}

const chip = (active: boolean) =>
  `flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] transition-colors ${
    active
      ? "border-copper/50 text-copper"
      : "border-line text-ink-muted hover:text-ink-soft"
  }`;
const propOpts = (props: UdbProp[]) =>
  props.map((p) => ({
    value: p.id,
    label: `${TYPE_GLYPH[p.type] ?? "?"}  ${p.name}`,
  }));

// value editor for one filter rule (option dropdown / date / text), or nothing
function FilterValue(
  { prop, filter, onChange }: {
    prop: UdbProp;
    filter: Filter;
    onChange: (v: string) => void;
  },
) {
  if (NO_VALUE.has(filter.op)) return null;
  const cls =
    "w-full rounded-md border border-chipline bg-transparent px-2 py-1 text-[11px] text-ink outline-none focus:border-copper/60";
  if (prop.type === "select" || prop.type === "multi_select") {
    const opts = prop.config.options ?? [];
    return (
      <Select
        value={filter.value ?? ""}
        placeholder="choose…"
        options={opts.map((o) => ({
          value: o.id,
          label: o.name,
          dot: o.color,
        }))}
        onChange={onChange}
      />
    );
  }
  if (prop.type === "date") {
    return (
      <input
        type="date"
        className={cls}
        value={filter.value ?? ""}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <input
      className={cls}
      placeholder="value…"
      value={filter.value ?? ""}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function ViewToolbar(
  { props, view, onChange }: {
    props: UdbProp[];
    view: ViewConfig;
    onChange: (v: ViewConfig) => void;
  },
) {
  const [open, setOpen] = useState<"sort" | "filter" | "group" | null>(null);
  const sortable = props;
  const byId = new Map(props.map((p) => [p.id, p]));
  const groupProp = view.groupBy ? byId.get(view.groupBy) : undefined;
  const aggProps = props.filter((p) => AGGREGATABLE.has(p.type));

  const addSort = () => {
    const used = new Set(view.sorts.map((s) => s.propId));
    const p = sortable.find((x) => !used.has(x.id)) ?? sortable[0];
    if (p) {
      onChange({ ...view, sorts: [...view.sorts, { propId: p.id, dir: 1 }] });
    }
  };
  const addFilter = () => {
    const p = props[0];
    if (p) {
      onChange({
        ...view,
        filters: [...view.filters, {
          propId: p.id,
          op: opsFor(p)[0],
          value: "",
        }],
      });
    }
  };

  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <button
          type="button"
          className={chip(view.filters.length > 0)}
          onClick={() => setOpen((o) => (o === "filter" ? null : "filter"))}
        >
          ▽ Filter{view.filters.length > 0 && ` · ${view.filters.length}`}
        </button>
        {open === "filter" && (
          <Popover
            onClose={() => setOpen(null)}
            className="w-[420px] max-w-[92vw] p-2"
          >
            {view.filters.length === 0 && (
              <p className="px-1 py-1.5 text-[11px] text-ink-muted/70">
                No filters — rows matching every rule are shown.
              </p>
            )}
            <div className="flex flex-col gap-1.5">
              {view.filters.map((f, i) => {
                const p = byId.get(f.propId) ?? props[0];
                const set = (patch: Partial<Filter>) =>
                  onChange({
                    ...view,
                    filters: view.filters.map((
                      x,
                      j,
                    ) => (j === i ? { ...x, ...patch } : x)),
                  });
                return (
                  // flex-wrap + min-widths: controls shrink to fit, then wrap to a new
                  // line rather than overflowing the popover and overlapping each other
                  <div key={i} className="flex flex-wrap items-center gap-1">
                    <span className="w-9 shrink-0 text-[10px] text-ink-muted/60">
                      {i === 0 ? "Where" : "and"}
                    </span>
                    <div className="min-w-[92px] flex-[1.4]">
                      <Select
                        value={f.propId}
                        options={propOpts(props)}
                        onChange={(v) => {
                          const np = byId.get(v)!;
                          set({ propId: v, op: opsFor(np)[0], value: "" });
                        }}
                      />
                    </div>
                    <div className="min-w-[84px] flex-1">
                      <Select
                        value={f.op}
                        options={opsFor(p).map((o) => ({
                          value: o,
                          label: OP_LABEL[o],
                        }))}
                        onChange={(v) => set({ op: v as FilterOp })}
                      />
                    </div>
                    {!NO_VALUE.has(f.op) && (
                      <div className="min-w-[80px] flex-1">
                        <FilterValue
                          prop={p}
                          filter={f}
                          onChange={(v) => set({ value: v })}
                        />
                      </div>
                    )}
                    <button
                      type="button"
                      className="shrink-0 px-1 text-ink-muted hover:text-blocked"
                      title="remove"
                      onClick={() =>
                        onChange({
                          ...view,
                          filters: view.filters.filter((_, j) => j !== i),
                        })}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="mt-1.5 flex items-center gap-3 border-t border-line-soft pt-1.5">
              <button
                type="button"
                className="text-[11px] text-ink-muted hover:text-copper"
                onClick={addFilter}
              >
                ＋ Add filter
              </button>
              {view.filters.length > 0 && (
                <button
                  type="button"
                  className="text-[11px] text-ink-muted hover:text-blocked"
                  onClick={() => onChange({ ...view, filters: [] })}
                >
                  Clear all
                </button>
              )}
            </div>
          </Popover>
        )}
      </div>

      <div className="relative">
        <button
          type="button"
          className={chip(view.sorts.length > 0)}
          onClick={() => setOpen((o) => (o === "sort" ? null : "sort"))}
        >
          ⇅ Sort{view.sorts.length > 0 && ` · ${view.sorts.length}`}
        </button>
        {open === "sort" && (
          <Popover
            onClose={() => setOpen(null)}
            className="w-[300px] max-w-[92vw] p-2"
          >
            {view.sorts.length === 0 && (
              <p className="px-1 py-1.5 text-[11px] text-ink-muted/70">
                No sorts — rows keep their manual order.
              </p>
            )}
            <div className="flex flex-col gap-1.5">
              {view.sorts.map((s, i) => {
                const move = (dir: -1 | 1) => {
                  const j = i + dir;
                  if (j < 0 || j >= view.sorts.length) return;
                  const next = [...view.sorts];
                  [next[i], next[j]] = [next[j], next[i]];
                  onChange({ ...view, sorts: next });
                };
                return (
                  <div key={i} className="flex items-center gap-1">
                    <div className="flex flex-col leading-none">
                      <button
                        type="button"
                        disabled={i === 0}
                        className="text-[7px] text-ink-muted hover:text-ink disabled:opacity-25"
                        onClick={() => move(-1)}
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        disabled={i === view.sorts.length - 1}
                        className="text-[7px] text-ink-muted hover:text-ink disabled:opacity-25"
                        onClick={() => move(1)}
                      >
                        ▼
                      </button>
                    </div>
                    <div className="min-w-0 flex-1">
                      <Select
                        value={s.propId}
                        options={propOpts(props)}
                        onChange={(v) =>
                          onChange({
                            ...view,
                            sorts: view.sorts.map((
                              x,
                              j,
                            ) => (j === i ? { ...x, propId: v } : x)),
                          })}
                      />
                    </div>
                    <div className="flex shrink-0 rounded-md bg-panel p-[2px]">
                      {([[1, "↑ Asc"], [-1, "↓ Desc"]] as const).map((
                        [d, lbl],
                      ) => (
                        <button
                          type="button"
                          key={d}
                          className={`rounded px-1.5 py-0.5 text-[10px] ${
                            s.dir === d
                              ? "bg-tab-active text-ink"
                              : "text-ink-muted hover:text-ink-soft"
                          }`}
                          onClick={() =>
                            onChange({
                              ...view,
                              sorts: view.sorts.map((
                                x,
                                j,
                              ) => (j === i ? { ...x, dir: d } : x)),
                            })}
                        >
                          {lbl}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="shrink-0 px-1 text-ink-muted hover:text-blocked"
                      title="remove"
                      onClick={() =>
                        onChange({
                          ...view,
                          sorts: view.sorts.filter((_, j) => j !== i),
                        })}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="mt-1.5 flex items-center gap-3 border-t border-line-soft pt-1.5">
              <button
                type="button"
                className="text-[11px] text-ink-muted hover:text-copper"
                onClick={addSort}
              >
                ＋ Add sort
              </button>
              {view.sorts.length > 0 && (
                <button
                  type="button"
                  className="text-[11px] text-ink-muted hover:text-blocked"
                  onClick={() => onChange({ ...view, sorts: [] })}
                >
                  Clear all
                </button>
              )}
            </div>
          </Popover>
        )}
      </div>

      <div className="relative">
        <button
          type="button"
          className={chip(!!groupProp)}
          onClick={() => setOpen((o) => (o === "group" ? null : "group"))}
        >
          ▤ Group{groupProp && ` · ${groupProp.name}`}
        </button>
        {open === "group" && (
          <Popover
            onClose={() => setOpen(null)}
            className="w-[300px] max-w-[92vw] p-2"
          >
            <div className="flex items-center gap-1">
              <span className="w-14 shrink-0 text-[10px] text-ink-muted/60">
                Group by
              </span>
              <div className="min-w-0 flex-1">
                <Select
                  value={view.groupBy ?? ""}
                  placeholder="none"
                  options={[
                    { value: "", label: "— none —" },
                    ...propOpts(props),
                  ]}
                  onChange={(v) => onChange({ ...view, groupBy: v || null })}
                />
              </div>
            </div>
            {groupProp && (
              <label className="mt-1.5 flex cursor-pointer items-center gap-2 px-1 text-[11px] text-ink-soft">
                <input
                  type="checkbox"
                  checked={!!view.summary}
                  onChange={(e) =>
                    onChange({ ...view, summary: e.target.checked })}
                />
                Summary table — one read-only row per group (like a DB view)
              </label>
            )}
            {groupProp && aggProps.length > 0 && (
              <div className="mt-1.5 border-t border-line-soft pt-1.5">
                <p className="px-1 pb-1 text-[10px] text-ink-muted/60">
                  Aggregates shown on each group (count is always shown)
                </p>
                <div className="flex flex-col gap-1">
                  {aggProps.map((p) => (
                    <div key={p.id} className="flex items-center gap-1">
                      <span className="min-w-0 flex-1 truncate px-1 text-[11px] text-ink-soft">
                        {TYPE_GLYPH[p.type] ?? "?"} {p.name}
                      </span>
                      <div className="w-[112px] shrink-0">
                        <Select
                          value={view.aggs?.[p.id] ?? ""}
                          placeholder="none"
                          options={[
                            { value: "", label: "— none —" },
                            ...(["sum", "avg", "min", "max"] as const).map((
                              a,
                            ) => ({ value: a, label: a })),
                          ]}
                          onChange={(v) =>
                            onChange({
                              ...view,
                              aggs: {
                                ...view.aggs,
                                [p.id]: (v || null) as Agg | null,
                              },
                            })}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Popover>
        )}
      </div>
    </div>
  );
}
