// Multi-column sort + filter + group-by (with per-group aggregates) for the database table
// (Notion-style views). All client-side over the fetched rows (the stored sort_key order is
// untouched) and persisted per-database in localStorage — see load/saveView. AND-combined filters.
// The data half lives in view-core.ts (pure, unit-tested); it is re-exported here.
import { useState } from "react";
import type { UdbProp } from "../api";
import { EntityIcon, Popover, Select } from "../ui";
import { TYPE_GLYPH } from "./PropertyEditor";
import {
  CHART_AGGS,
  CHART_COLORS,
  CHART_KINDS,
  type ChartConfig,
  type ChartSeries,
  KIND_LABEL,
  MAX_SERIES,
  sanitizeChart,
} from "./chart.ts";
import {
  type Agg,
  AGGREGATABLE,
  type Filter,
  type FilterOp,
  NO_VALUE,
  OP_LABEL,
  opsFor,
  type ViewConfig,
} from "./view-core.ts";

export * from "./view-core.ts";

// persistence (per-device, per-db) — named view tabs, each with its own config

export type ViewTab = { id: string; name: string; config: ViewConfig };
export type ViewTabs = { tabs: ViewTab[]; active: string };

const emptyConfig = (): ViewConfig => ({ sorts: [], filters: [] });
const isEmptyConfig = (c: ViewConfig) =>
  !c.sorts.length && !c.filters.length && !c.groupBy && !c.chart &&
  !c.hidden?.length;
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

// A chart view: bars of the row count per group. Counting needs no numeric
// column, so the chart draws something the moment it opens — an empty chart
// asking to be configured is the mistake a bare column config already makes.
export const newChartTab = (props: UdbProp[]): ViewTab =>
  newTab("Chart", {
    sorts: [],
    filters: [],
    chart: {
      kind: "bar",
      // no grouping column worth guessing → one bar per row
      x: props.find((p) => p.type === "select" || p.type === "relation")?.id ??
        null,
      series: [{ propId: null, agg: "count" }],
    },
  });

const key = (dbId: string) => `trame:udbtabs:${dbId}`;
// validate an untrusted tabs bundle (localStorage OR the server `views` column); null = not usable
export function parseTabs(raw: unknown): ViewTabs | null {
  const v = raw as { tabs?: unknown; active?: unknown } | null;
  if (v && Array.isArray(v.tabs)) {
    const tabs = (v.tabs as ViewTab[]).filter((t) =>
      t && typeof t.id === "string" && t.config
    ).map((t) =>
      // an unusable chart config drops out and the tab falls back to a grid
      t.config.chart
        ? {
          ...t,
          config: { ...t.config, chart: sanitizeChart(t.config.chart) },
        }
        : t
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
  const tab = newTab("Table", emptyConfig());
  return { tabs: [tab], active: tab.id };
}
export const saveTabs = (dbId: string, v: ViewTabs) => {
  if (isDefaultTabs(v)) localStorage.removeItem(key(dbId));
  else localStorage.setItem(key(dbId), JSON.stringify(v));
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
  const addChart = () => {
    const t = newChartTab(props);
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
                {t.config.chart && (
                  <span className="mr-1 text-[10px] text-copper">▂▅</span>
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
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11.5px] text-ink-soft hover:bg-panel"
              onClick={addChart}
            >
              <span className="text-[11px] text-copper">▂▅</span> Chart view
            </button>
            <p className="px-2 pt-1 text-[10px] text-ink-muted/60">
              Summary = one row per group, aggregates only. Chart = the same
              aggregates drawn.
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
  const [open, setOpen] = useState<
    "sort" | "filter" | "group" | "columns" | "chart" | null
  >(null);
  const sortable = props;
  const byId = new Map(props.map((p) => [p.id, p]));
  const groupProp = view.groupBy ? byId.get(view.groupBy) : undefined;
  const aggProps = props.filter((p) => AGGREGATABLE.has(p.type));
  const hidden = new Set(view.hidden ?? []);
  const hideable = props.filter((p) => p.type !== "title"); // title stays visible
  const toggleHidden = (id: string) => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange({ ...view, hidden: next.size ? [...next] : undefined });
  };

  const addSort = () => {
    const used = new Set(view.sorts.map((s) => s.propId));
    const p = sortable.find((x) => !used.has(x.id)) ?? sortable[0];
    if (p) {
      onChange({ ...view, sorts: [...view.sorts, { propId: p.id, dir: 1 }] });
    }
  };
  const cfg = view.chart;
  const setChart = (patch: Partial<ChartConfig>) =>
    cfg && onChange({ ...view, chart: { ...cfg, ...patch } });
  const setSeries = (i: number, patch: Partial<ChartSeries>) =>
    setChart({
      series: cfg!.series.map((s, j) => (j === i ? { ...s, ...patch } : s)),
    });
  // a pie is one measure; the extras are kept but ignored until the kind changes
  const onePie = cfg?.kind === "pie";

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

      {cfg && (
        <div className="relative">
          <button
            type="button"
            className={chip(true)}
            onClick={() => setOpen((o) => (o === "chart" ? null : "chart"))}
          >
            ▂▅ Chart · {KIND_LABEL[cfg.kind]}
          </button>
          {open === "chart" && (
            <Popover
              onClose={() => setOpen(null)}
              className="w-[300px] max-w-[92vw] p-2"
            >
              <div className="flex items-center gap-1">
                <span className="w-14 shrink-0 text-[10px] text-ink-muted/60">
                  Chart
                </span>
                <div className="min-w-0 flex-1">
                  <Select
                    value={cfg.kind}
                    options={CHART_KINDS.map((k) => ({
                      value: k,
                      label: KIND_LABEL[k],
                    }))}
                    onChange={(v) =>
                      setChart({ kind: v as ChartConfig["kind"] })}
                  />
                </div>
              </div>
              <div className="mt-1.5 flex items-center gap-1">
                <span className="w-14 shrink-0 text-[10px] text-ink-muted/60">
                  {cfg.kind === "pie" ? "Slices" : "X axis"}
                </span>
                <div className="min-w-0 flex-1">
                  <Select
                    value={cfg.x ?? ""}
                    placeholder="pick a property"
                    options={propOpts(props)}
                    onChange={(v) => setChart({ x: v || null })}
                  />
                </div>
              </div>
              <div className="mt-1.5 border-t border-line-soft pt-1.5">
                <p className="px-1 pb-1 text-[10px] text-ink-muted/60">
                  {onePie ? "Measure (a pie draws one)" : "Measures"}
                </p>
                <div className="flex flex-col gap-1">
                  {cfg.series.map((s, i) => (
                    <div key={i} className="flex items-center gap-1">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                        style={{ background: CHART_COLORS[i] }}
                      />
                      <div className="min-w-0 flex-[1.3]">
                        <Select
                          value={s.propId ?? ""}
                          options={[
                            { value: "", label: "# Count of rows" },
                            ...propOpts(aggProps),
                          ]}
                          onChange={(v) =>
                            setSeries(i, {
                              propId: v || null,
                              agg: v && s.agg === "count" ? "sum" : s.agg,
                            })}
                        />
                      </div>
                      {s.propId && (
                        <div className="w-[84px] shrink-0">
                          <Select
                            value={s.agg === "count" ? "sum" : s.agg}
                            options={CHART_AGGS.map((a) => ({
                              value: a,
                              label: a,
                            }))}
                            onChange={(v) =>
                              setSeries(i, { agg: v as ChartSeries["agg"] })}
                          />
                        </div>
                      )}
                      {cfg.series.length > 1 && (
                        <button
                          type="button"
                          className="w-5 shrink-0 text-[10px] text-ink-muted hover:text-blocked"
                          title="remove this measure"
                          onClick={() =>
                            setChart({
                              series: cfg.series.filter((_, j) => j !== i),
                            })}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {!onePie && cfg.series.length < MAX_SERIES && (
                  <button
                    type="button"
                    className="mt-1 px-1 text-[11px] text-ink-muted hover:text-copper"
                    onClick={() =>
                      setChart({
                        series: [...cfg.series, {
                          propId: aggProps[0]?.id ?? null,
                          agg: aggProps[0] ? "sum" : "count",
                        }],
                      })}
                  >
                    ＋ Add measure
                  </button>
                )}
              </div>
              <div className="mt-1.5 flex flex-col gap-1 border-t border-line-soft pt-1.5">
                {cfg.kind === "bar" && cfg.series.length > 1 && (
                  <label className="flex cursor-pointer items-center gap-2 px-1 text-[11px] text-ink-soft">
                    <input
                      type="checkbox"
                      checked={!!cfg.stacked}
                      onChange={(e) => setChart({ stacked: e.target.checked })}
                    />
                    Stack the series
                  </label>
                )}
                {cfg.kind === "pie" && (
                  <label className="flex cursor-pointer items-center gap-2 px-1 text-[11px] text-ink-soft">
                    <input
                      type="checkbox"
                      checked={!!cfg.donut}
                      onChange={(e) => setChart({ donut: e.target.checked })}
                    />
                    Donut
                  </label>
                )}
                <label className="flex cursor-pointer items-center gap-2 px-1 text-[11px] text-ink-soft">
                  <input
                    type="checkbox"
                    checked={!!cfg.labels}
                    onChange={(e) => setChart({ labels: e.target.checked })}
                  />
                  Value labels on the marks
                </label>
              </div>
            </Popover>
          )}
        </div>
      )}

      <div className="relative">
        <button
          type="button"
          className={chip(hidden.size > 0)}
          onClick={() => setOpen((o) => (o === "columns" ? null : "columns"))}
        >
          ⊟ Columns{hidden.size > 0 && ` · ${hidden.size} hidden`}
        </button>
        {open === "columns" && (
          <Popover
            onClose={() => setOpen(null)}
            className="w-[240px] max-w-[92vw] p-2"
          >
            <div className="flex flex-col gap-0.5">
              {hideable.map((p) => (
                <label
                  key={p.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[11px] text-ink-soft hover:bg-panel/70"
                >
                  <input
                    type="checkbox"
                    checked={!hidden.has(p.id)}
                    onChange={() => toggleHidden(p.id)}
                  />
                  <span className="inline-flex w-4 shrink-0 justify-center text-[10px] opacity-60">
                    {p.config.icon
                      ? (
                        <EntityIcon
                          icon={p.config.icon}
                          className="text-[11px]"
                        />
                      )
                      : TYPE_GLYPH[p.type] ?? "?"}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                </label>
              ))}
              {hideable.length === 0 && (
                <p className="px-1 py-1.5 text-[11px] text-ink-muted/70">
                  Only the title column — nothing to hide.
                </p>
              )}
            </div>
            {hidden.size > 0 && (
              <div className="mt-1.5 border-t border-line-soft pt-1.5">
                <button
                  type="button"
                  className="text-[11px] text-ink-muted hover:text-copper"
                  onClick={() => onChange({ ...view, hidden: undefined })}
                >
                  Show all
                </button>
              </div>
            )}
          </Popover>
        )}
      </div>
    </div>
  );
}
