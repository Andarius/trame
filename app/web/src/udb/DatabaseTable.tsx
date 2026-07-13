import { memo, type MouseEvent as ReactMouseEvent, useCallback, useDeferredValue, useEffect, useState } from "react";
import { createUdbRow, getUdb, patchUdbRow, type Udb, type UdbMeta, type UdbProp, type UdbRow, updateUdbProp } from "../api";
import { EntityIcon } from "../ui";
import { Cell, IconPicker } from "./cells";
import { PropertyEditor, TYPE_GLYPH } from "./PropertyEditor";
import { RowPanel } from "./RowPanel";
import {
  aggregate,
  applyView,
  fmtAgg,
  groupRows,
  loadTabs,
  saveTabs,
  type ViewConfig,
  type ViewTabs,
  ViewTabsBar,
  ViewToolbar,
} from "./view";

const DEFAULT_WIDTH: Record<string, number> = {
  title: 260,
  text: 190,
  number: 110,
  select: 140,
  multi_select: 180,
  date: 130,
  url: 180,
  checkbox: 64,
  relation: 210,
  formula: 120,
  rollup: 120,
};

function colWidth(p: UdbProp): number {
  if (p.width) return p.width;
  if (p.type === "date" && p.config.end) return 240;
  return DEFAULT_WIDTH[p.type] ?? 150;
}

const udbCache = new Map<string, Udb>(); // last fetch per db, so switching renders instantly

// Memoized: rows can be huge (full LLM transcripts in text cells), so toolbar
// interactions must not re-render every row. Callbacks passed in must be stable.
const TableRow = memo(function TableRow(
  { row: r, props, grid, iconOpen, onIconFor, onOpenRow, onPatch, onPickIcon, reload }: {
    row: UdbRow;
    props: UdbProp[];
    grid: string;
    iconOpen: boolean;
    onIconFor: (rowId: string | null) => void;
    onOpenRow: (rowId: string) => void;
    onPatch: (rowId: string, propId: string, value: unknown) => void;
    onPickIcon: (rowId: string, icon: string | null) => void;
    reload: () => void;
  },
) {
  return (
    <div
      className="group grid items-start border-b border-line-soft transition-colors hover:bg-panel/40"
      style={{ gridTemplateColumns: grid }}
    >
      {props.map((p, i) => (
        <div key={p.id} className="relative flex min-w-0 items-center border-r border-line-soft/60 py-0.5 last:border-r-0">
          {i === 0 && (
            <button type="button"
              className={`ml-1 shrink-0 rounded p-0.5 text-[13px] leading-none transition-opacity hover:bg-panel ${
                r.icon ? "" : "opacity-0 group-hover:opacity-50"
              }`}
              title="row icon"
              onClick={() => onIconFor(r.id)}
            >
              <EntityIcon icon={r.icon} fallback="◌" className={r.icon ? "" : "text-ink-muted"} />
            </button>
          )}
          {i === 0 && iconOpen && (
            <IconPicker
              current={r.icon}
              onPick={(icon) => onPickIcon(r.id, icon)}
              onClose={() => onIconFor(null)}
            />
          )}
          <div className="min-w-0 flex-1">
            <Cell prop={p} row={r} onPatch={(propId, value) => onPatch(r.id, propId, value)} onSaved={reload} onPropChanged={reload} />
          </div>
          {i === 0 && (
            <button type="button"
              className="mr-1 rounded border border-chipline/60 bg-panel px-1 py-0.5 text-[9px] text-ink-muted opacity-0 transition-opacity hover:text-ink group-hover:opacity-100"
              title="open row"
              onClick={() => onOpenRow(r.id)}
            >
              ⤢
            </button>
          )}
        </div>
      ))}
      <div />
    </div>
  );
});

export function DatabaseView({ dbId, epoch, udbs }: { dbId: string; epoch: number; udbs: UdbMeta[] }) {
  const [data, setData] = useState<Udb | null>(() => udbCache.get(dbId) ?? null);
  const [editor, setEditor] = useState<{ prop: UdbProp | null } | null>(null); // null prop = create
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [iconFor, setIconFor] = useState<string | null>(null); // row id with the icon picker open
  const [widths, setWidths] = useState<Record<string, number>>({}); // live values while dragging
  const [tabState, setTabState] = useState<ViewTabs>(() => loadTabs(dbId)); // named view tabs (per-device)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set()); // collapsed group keys (per-mount)

  const activeTab = tabState.tabs.find((t) => t.id === tabState.active) ?? tabState.tabs[0];
  const view = activeTab.config;
  // the grid re-renders at deferred priority so toolbar typing / tab switches stay responsive
  const deferredView = useDeferredValue(view);
  const changeTabs = (v: ViewTabs) => {
    setTabState(v);
    saveTabs(dbId, v);
    if (v.active !== tabState.active) setCollapsed(new Set());
  };
  const changeView = (c: ViewConfig) =>
    changeTabs({ ...tabState, tabs: tabState.tabs.map((t) => (t.id === activeTab.id ? { ...t, config: c } : t)) });
  // header caret 3-state cycle: absent → asc → desc → removed (composes into the multi-sort list)
  const cycleSort = (propId: string) => {
    const cur = view.sorts.find((s) => s.propId === propId);
    const sorts = !cur
      ? [...view.sorts, { propId, dir: 1 as const }]
      : cur.dir === 1
      ? view.sorts.map((s) => (s.propId === propId ? { ...s, dir: -1 as const } : s))
      : view.sorts.filter((s) => s.propId !== propId);
    changeView({ ...view, sorts });
  };
  // PropertyEditor sort buttons set/replace/remove this column's rule in place
  const setColSort = (propId: string, dir: 1 | -1 | null) => {
    const sorts = dir === null
      ? view.sorts.filter((s) => s.propId !== propId)
      : view.sorts.some((s) => s.propId === propId)
      ? view.sorts.map((s) => (s.propId === propId ? { ...s, dir } : s))
      : [...view.sorts, { propId, dir }];
    changeView({ ...view, sorts });
  };

  const reload = useCallback(() => {
    getUdb(dbId).then((d) => {
      udbCache.set(dbId, d);
      setData(d);
    }).catch(() => {});
  }, [dbId]);
  // stable callbacks so memoized rows survive toolbar re-renders
  const patchRow = useCallback(
    (rowId: string, propId: string, value: unknown) => patchUdbRow(rowId, { [propId]: value }).then(reload),
    [reload],
  );
  const pickIcon = useCallback(
    (rowId: string, icon: string | null) => patchUdbRow(rowId, {}, icon).then(reload),
    [reload],
  );
  useEffect(reload, [reload, epoch]);
  useEffect(() => {
    setOpenRow(null);
    setWidths({});
    setTabState(loadTabs(dbId));
    setCollapsed(new Set());
  }, [dbId]);

  const startResize = (p: UdbProp) => (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[p.id] ?? colWidth(p);
    const width = (ev: MouseEvent) => Math.max(64, Math.round(startW + ev.clientX - startX));
    const move = (ev: MouseEvent) => setWidths((w) => ({ ...w, [p.id]: width(ev) }));
    const up = (ev: MouseEvent) => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      updateUdbProp(p.id, { width: width(ev) }).then(reload).catch(() => {});
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  if (!data) return <p className="p-6 text-ink-muted">Loading…</p>;
  const props = data.properties;
  const grid = props.map((p) => `${widths[p.id] ?? colWidth(p)}px`).join(" ") + " minmax(44px, 1fr)";

  // filtered + multi-sorted view (natural sort_key order when the view is empty)
  const rows = applyView(data.rows, props, deferredView);
  const groupProp = deferredView.groupBy ? props.find((p) => p.id === deferredView.groupBy) ?? null : null;
  const aggsOf = (groupRowsArr: UdbRow[]) =>
    props.flatMap((p) => {
      const agg = deferredView.aggs?.[p.id];
      if (!agg) return [];
      const n = aggregate(groupRowsArr, p, agg);
      return n === null ? [] : [`${p.name} ${agg} ${fmtAgg(n)}`];
    });
  const toggleGroup = (key: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const sortDirOf = (id: string) => view.sorts.find((s) => s.propId === id)?.dir ?? null;
  const sortRank = (id: string) => view.sorts.findIndex((s) => s.propId === id); // 0-based priority

  const addRow = () => createUdbRow(dbId).then((r) => {
    reload();
    setOpenRow(r.id);
  });

  const row = openRow ? rows.find((r) => r.id === openRow) ?? null : null;

  const renderRow = (r: UdbRow) => (
    <TableRow
      key={r.id}
      row={r}
      props={props}
      grid={grid}
      iconOpen={iconFor === r.id}
      onIconFor={setIconFor}
      onOpenRow={setOpenRow}
      onPatch={patchRow}
      onPickIcon={pickIcon}
      reload={reload}
    />
  );

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 px-6 pt-2">
          <ViewTabsBar state={tabState} onChange={changeTabs} />
        </div>
        <div className="flex items-center gap-2 border-b border-line-soft px-6 py-2">
          <ViewToolbar props={props} view={view} onChange={changeView} />
          <span className="flex-1" />
          {(view.filters.length > 0 || view.sorts.length > 0) && (
            <span className="text-[11px] text-ink-muted/70">
              {rows.length} of {data.rows.length}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1 overflow-auto px-6 py-4">
        <div className="w-max min-w-full">
          {/* header */}
          <div className="grid border-b border-line" style={{ gridTemplateColumns: grid }}>
            {props.map((p) => (
              <div key={p.id} className="group relative flex items-center border-r border-line-soft last:border-r-0">
                <button type="button"
                  className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left text-[11px] font-medium text-ink-muted transition-colors hover:bg-panel/60 hover:text-ink-soft"
                  onClick={() => setEditor({ prop: p })}
                  title={p.type}
                >
                  <span className="text-[10px] opacity-60">{TYPE_GLYPH[p.type] ?? "?"}</span>
                  <span className="truncate">{p.name}</span>
                </button>
                <button type="button"
                  className={`flex shrink-0 items-center gap-0.5 px-1 py-1.5 text-[9px] transition-colors hover:text-ink ${
                    sortDirOf(p.id) ? "text-copper" : "text-transparent hover:text-ink-muted group-hover:text-ink-muted/60"
                  }`}
                  title={sortDirOf(p.id) ? "cycle sort (asc → desc → off)" : "sort by this column"}
                  onClick={() => cycleSort(p.id)}
                >
                  {sortDirOf(p.id) ? (sortDirOf(p.id) === 1 ? "▲" : "▼") : "↕"}
                  {sortDirOf(p.id) && view.sorts.length > 1 && (
                    <span className="text-[7px] leading-none">{sortRank(p.id) + 1}</span>
                  )}
                </button>
                <div
                  className="absolute -right-[3px] top-0 z-10 h-full w-[7px] cursor-col-resize after:absolute after:left-[3px] after:top-0 after:h-full after:w-[1px] after:bg-transparent hover:after:bg-copper/70"
                  title="drag to resize"
                  onMouseDown={startResize(p)}
                />
                {editor && editor.prop?.id === p.id && (
                  <PropertyEditor
                    dbId={dbId}
                    prop={p}
                    allProps={props}
                    udbs={udbs}
                    sortDir={sortDirOf(p.id)}
                    onSort={(dir) => setColSort(p.id, dir)}
                    onClose={() => setEditor(null)}
                    onSaved={reload}
                  />
                )}
              </div>
            ))}
            <div className="relative">
              <button type="button"
                className="w-full px-2 py-1.5 text-left text-[13px] text-ink-muted/60 transition-colors hover:bg-panel/60 hover:text-ink-soft"
                title="add column"
                onClick={() => setEditor({ prop: null })}
              >
                +
              </button>
              {editor && editor.prop === null && (
                <PropertyEditor
                  dbId={dbId}
                  prop={null}
                  allProps={props}
                  udbs={udbs}
                  onClose={() => setEditor(null)}
                  onSaved={reload}
                />
              )}
            </div>
          </div>
          {/* rows — flat, or grouped with a collapsible aggregate header per group */}
          {!groupProp && rows.map(renderRow)}
          {groupProp && groupRows(rows, groupProp).map((g) => (
            <div key={g.key}>
              <button type="button"
                className="flex w-full items-center gap-2 border-b border-line-soft bg-panel/30 px-2 py-1.5 text-left transition-colors hover:bg-panel/60"
                title={collapsed.has(g.key) ? "expand group" : "collapse group"}
                onClick={() => toggleGroup(g.key)}
              >
                <span className="text-[9px] text-ink-muted">{collapsed.has(g.key) ? "▸" : "▾"}</span>
                {g.color
                  ? (
                    <span
                      className="rounded px-1.5 py-0.5 text-[10.5px] font-medium leading-none"
                      style={{ color: g.color, background: g.color + "24" }}
                    >
                      {g.label}
                    </span>
                  )
                  : <span className="text-[11.5px] font-medium text-ink-soft">{g.label}</span>}
                <span className="text-[10.5px] text-ink-muted/70">{g.rows.length}</span>
                {aggsOf(g.rows).map((s) => (
                  <span key={s} className="ml-2 shrink-0 text-[10.5px] tabular-nums text-ink-muted/80">{s}</span>
                ))}
              </button>
              {!collapsed.has(g.key) && g.rows.map(renderRow)}
            </div>
          ))}
          {/* footer */}
          <button type="button"
            className="w-full px-2 py-1.5 text-left text-xs text-ink-muted/70 transition-colors hover:bg-panel/40 hover:text-ink-soft"
            onClick={addRow}
          >
            ＋ New row
          </button>
          {data.rows.length === 0 && (
            <p className="px-2 pt-4 text-[12px] text-ink-muted/60">
              No rows yet — add one, or add columns with the “+” header cell.
            </p>
          )}
          {data.rows.length > 0 && rows.length === 0 && (
            <p className="px-2 pt-4 text-[12px] text-ink-muted/60">No rows match the current filter.</p>
          )}
        </div>
        </div>
      </div>
      {row && (
        <RowPanel
          key={row.id}
          db={data.db}
          properties={props}
          row={row}
          onClose={() => setOpenRow(null)}
          onSaved={reload}
        />
      )}
    </div>
  );
}
