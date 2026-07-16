import {
  memo,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createUdbRow,
  getUdb,
  patchUdbRow,
  type Udb,
  type UdbMeta,
  type UdbProp,
  type UdbRow,
  updateUdb,
  updateUdbProp,
} from "../api";
import { EntityIcon, Select } from "../ui";
import { Cell, IconPicker } from "./cells";
import { PropertyEditor, TYPE_GLYPH } from "./PropertyEditor";
import { RowPanel } from "./RowPanel";
import {
  type Agg,
  aggregate,
  applyView,
  fmtAgg,
  type Group,
  groupRows,
  isDefaultTabs,
  loadTabs,
  parseTabs,
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
// Pagination: cap how many rows render at once — a 600-row table otherwise
// mounts ~5k cells on open and stalls the desktop webview. Page size is
// user-selectable and remembered across databases.
const PAGE_ALL = Number.POSITIVE_INFINITY;
const PAGE_SIZE_KEY = "trame:udbpagesize";
const loadPageSize = (): number => {
  const raw = Number(localStorage.getItem(PAGE_SIZE_KEY));
  return [25, 50, 100, 200, PAGE_ALL].includes(raw) ? raw : 50;
};

const TableRow = memo(function TableRow(
  {
    row: r,
    props,
    grid,
    iconOpen,
    onIconFor,
    onOpenRow,
    onPatch,
    onPickIcon,
    reload,
  }: {
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
        <div
          key={p.id}
          className="relative flex min-w-0 items-center border-r border-line-soft/60 py-0.5 last:border-r-0"
        >
          {i === 0 && (
            <button
              type="button"
              className={`ml-1 shrink-0 rounded p-0.5 text-[13px] leading-none transition-opacity hover:bg-panel ${
                r.icon ? "" : "opacity-0 group-hover:opacity-50"
              }`}
              title="row icon"
              onClick={() => onIconFor(r.id)}
            >
              <EntityIcon
                icon={r.icon}
                fallback="◌"
                className={r.icon ? "" : "text-ink-muted"}
              />
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
            <Cell
              prop={p}
              row={r}
              onPatch={(propId, value) => onPatch(r.id, propId, value)}
              onSaved={reload}
              onPropChanged={reload}
            />
          </div>
          {i === 0 && (
            <button
              type="button"
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

// Read-only summary: one row per group with its Count and each configured aggregate — a live,
// non-editable projection of the rows (a "DB view"), rendered instead of the raw grid when on.
function SummaryBody(
  { groupProp, groups, aggProps, aggs }: {
    groupProp: UdbProp;
    groups: Group[];
    aggProps: UdbProp[];
    aggs: Record<string, Agg | null>;
  },
) {
  const grid = `minmax(160px,1.4fr) 72px ${
    aggProps.map(() => "minmax(96px,1fr)").join(" ")
  }`;
  return (
    <>
      <div
        className="grid border-b border-line text-[11px] font-medium text-ink-muted"
        style={{ gridTemplateColumns: grid }}
      >
        <div className="px-2 py-1.5">{groupProp.name}</div>
        <div className="px-2 py-1.5 text-right">Count</div>
        {aggProps.map((p) => (
          <div
            key={p.id}
            className="truncate px-2 py-1.5 text-right"
            title={`${p.name} (${aggs[p.id]})`}
          >
            {p.name} <span className="opacity-55">({aggs[p.id]})</span>
          </div>
        ))}
      </div>
      {groups.map((g) => (
        <div
          key={g.key}
          className="grid border-b border-line-soft last:border-b-0"
          style={{ gridTemplateColumns: grid }}
        >
          <div className="flex items-center px-2 py-1.5">
            {g.color
              ? (
                <span
                  className="rounded px-1.5 py-0.5 text-[10.5px] font-medium leading-none"
                  style={{ color: g.color, background: g.color + "24" }}
                >
                  {g.label}
                </span>
              )
              : <span className="text-[12px] text-ink-soft">{g.label}</span>}
          </div>
          <div className="px-2 py-1.5 text-right text-[12px] tabular-nums text-ink-muted">
            {g.rows.length}
          </div>
          {aggProps.map((p) => {
            const n = aggregate(g.rows, p, aggs[p.id] as Agg);
            return (
              <div
                key={p.id}
                className="px-2 py-1.5 text-right text-[12px] tabular-nums text-ink-soft"
              >
                {n === null ? "—" : fmtAgg(n)}
              </div>
            );
          })}
        </div>
      ))}
      {aggProps.length === 0 && (
        <p className="px-2 pt-4 text-[12px] text-ink-muted/60">
          Pick an aggregate in ▤ Group (avg, sum, …) to fill the columns.
        </p>
      )}
    </>
  );
}

// memo + App's identity-stable polling: the 5s refresh tick must not re-render this huge grid
export const DatabaseView = memo(function DatabaseView(
  { dbId, epoch, udbs, onReadOnly }: {
    dbId: string;
    epoch: number;
    udbs: UdbMeta[];
    onReadOnly?: (ro: boolean) => void; // lets App hide the global "New row" on a read-only summary tab
  },
) {
  const [data, setData] = useState<Udb | null>(() =>
    udbCache.get(dbId) ?? null
  );
  const [editor, setEditor] = useState<{ prop: UdbProp | null } | null>(null); // null prop = create
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [iconFor, setIconFor] = useState<string | null>(null); // row id with the icon picker open
  const [widths, setWidths] = useState<Record<string, number>>({}); // live values while dragging
  // view tabs: localStorage is the instant/offline cache; the hub's udb_databases.views is the
  // cross-device source of truth (LWW-synced). Adopted once per visit on load, written back on edit.
  const [tabState, setTabState] = useState<ViewTabs>(() => loadTabs(dbId));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set()); // collapsed group keys (per-mount)
  const syncedFor = useRef<string | null>(null); // dbId whose hub views we've already adopted this visit
  const pushTimer = useRef<number | undefined>(undefined);
  const pending = useRef<{ id: string; views: unknown } | null>(null);
  // flush the debounced hub write (also on unmount / when leaving the db, so a fresh edit is never dropped)
  const flushPush = useCallback(() => {
    clearTimeout(pushTimer.current);
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    updateUdb(p.id, { views: p.views }).catch(() => {});
  }, []);

  const activeTab = tabState.tabs.find((t) => t.id === tabState.active) ??
    tabState.tabs[0];
  const view = activeTab.config;
  // the grid re-renders at deferred priority so toolbar typing / tab switches stay responsive
  const deferredView = useDeferredValue(view);
  const changeTabs = (v: ViewTabs) => {
    setTabState(v);
    saveTabs(dbId, v);
    // write-through to the hub, debounced (filter typing fires this per keystroke). [] == the untouched default.
    pending.current = { id: dbId, views: isDefaultTabs(v) ? [] : v };
    clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(flushPush, 500);
    if (v.active !== tabState.active) setCollapsed(new Set());
  };
  const changeView = (c: ViewConfig) =>
    changeTabs({
      ...tabState,
      tabs: tabState.tabs.map((
        t,
      ) => (t.id === activeTab.id ? { ...t, config: c } : t)),
    });
  // header caret 3-state cycle: absent → asc → desc → removed (composes into the multi-sort list)
  const cycleSort = (propId: string) => {
    const cur = view.sorts.find((s) => s.propId === propId);
    const sorts = !cur
      ? [...view.sorts, { propId, dir: 1 as const }]
      : cur.dir === 1
      ? view.sorts.map((
        s,
      ) => (s.propId === propId ? { ...s, dir: -1 as const } : s))
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
      // adopt the hub's saved views once per visit (picks up edits made on another device); local edits win after
      if (syncedFor.current !== dbId) {
        syncedFor.current = dbId;
        const server = parseTabs(d.db.views);
        if (server) {
          setTabState(server);
          saveTabs(dbId, server);
        }
      }
    }).catch(() => {});
  }, [dbId]);
  // stable callbacks so memoized rows survive toolbar re-renders
  const patchRow = useCallback(
    (rowId: string, propId: string, value: unknown) =>
      patchUdbRow(rowId, { [propId]: value }).then(reload),
    [reload],
  );
  const pickIcon = useCallback(
    (rowId: string, icon: string | null) =>
      patchUdbRow(rowId, {}, icon).then(reload),
    [reload],
  );
  useEffect(reload, [reload, epoch]);
  useEffect(() => {
    setOpenRow(null);
    setWidths({});
    syncedFor.current = null; // re-adopt the hub's views for the newly-opened db
    setTabState(loadTabs(dbId));
    setCollapsed(new Set());
    return flushPush; // leaving this db (or unmounting): flush any pending hub write for the old db
  }, [dbId, flushPush]);

  const startResize = (p: UdbProp) => (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[p.id] ?? colWidth(p);
    const width = (ev: MouseEvent) =>
      Math.max(64, Math.round(startW + ev.clientX - startX));
    const move = (ev: MouseEvent) =>
      setWidths((w) => ({ ...w, [p.id]: width(ev) }));
    const up = (ev: MouseEvent) => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      updateUdbProp(p.id, { width: width(ev) }).then(reload).catch(() => {});
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  // filtered + multi-sorted view (natural sort_key order when the view is empty);
  // memoized so unrelated state changes don't re-run it over large tables
  const rows = useMemo(
    () => (data ? applyView(data.rows, data.properties, deferredView) : []),
    [data, deferredView],
  );
  const groupProp = (data && deferredView.groupBy && data.properties.find((p) =>
    p.id === deferredView.groupBy
  )) || null;
  const summaryConfigured = !!deferredView.summary; // this tab is a summary (aggregate-only) view
  // a summary view is read-only — tell App so it drops the global "New row" affordance
  const readOnly = summaryConfigured;
  useEffect(() => {
    onReadOnly?.(readOnly);
    return () => onReadOnly?.(false);
  }, [readOnly, onReadOnly]);

  // Grouping is computed over the FULL filtered set so group header counts and
  // aggregates are whole-group (never per-page). Rows then render in group order.
  const groups = useMemo(
    () => (groupProp ? groupRows(rows, groupProp) : null),
    [rows, groupProp],
  );
  // The rows that render as a grid, in group order (collapsed groups contribute
  // none); pagination slices this list.
  const orderedRows = useMemo(
    () => (groups
      ? groups.flatMap((g) => (collapsed.has(g.key) ? [] : g.rows))
      : rows),
    [groups, rows, collapsed],
  );

  // Pagination: render only the current page of ordered rows (default 50).
  // Summary mode (aggregate-only, few rows) is never paged.
  const [pageSize, setPageSize] = useState(loadPageSize);
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [dbId, deferredView, pageSize]); // reset on db/view/size change
  const changePageSize = (v: number) => {
    setPageSize(v);
    try {
      localStorage.setItem(PAGE_SIZE_KEY, String(v));
    } catch { /* private mode */ }
  };
  const paginate = pageSize !== PAGE_ALL && !summaryConfigured;
  const total = orderedRows.length;
  const pageCount = paginate ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  const curPage = Math.min(page, pageCount - 1);
  const pageRows = useMemo(
    () => (paginate
      ? orderedRows.slice(curPage * pageSize, (curPage + 1) * pageSize)
      : orderedRows),
    [orderedRows, paginate, curPage, pageSize],
  );
  const pagedIds = useMemo(() => new Set(pageRows.map((r) => r.id)), [
    pageRows,
  ]);

  if (!data) return <p className="p-6 text-ink-muted">Loading…</p>;
  const props = data.properties;
  const grid = props.map((p) => `${widths[p.id] ?? colWidth(p)}px`).join(" ") +
    " minmax(44px, 1fr)";
  // summary ("DB view") mode: a read-only aggregate table, shown instead of the raw grid
  const summaryMode = !!(groupProp && groups && deferredView.summary);
  // a summary view without a group-by yet — prompt to pick one instead of the grid
  const summaryNeedsGroup = summaryConfigured && !groupProp;
  const aggProps = props.filter((p) => deferredView.aggs?.[p.id]);

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
  const sortDirOf = (id: string) =>
    view.sorts.find((s) => s.propId === id)?.dir ?? null;
  const sortRank = (id: string) => view.sorts.findIndex((s) => s.propId === id); // 0-based priority

  const addRow = () =>
    createUdbRow(dbId).then((r) => {
      reload();
      setOpenRow(r.id);
    });

  // Resolve against the full row set, not the filtered/sorted `rows`: a just-added
  // blank row (or one edited out of the active filter) must stay open in the panel.
  const row = openRow && data
    ? data.rows.find((r) => r.id === openRow) ?? null
    : null;

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

  const renderGroupHeader = (g: Group) => (
    <button
      type="button"
      key={`h:${g.key}`}
      className="flex w-full items-center gap-2 border-b border-line-soft bg-panel/30 px-2 py-1.5 text-left transition-colors hover:bg-panel/60"
      title={collapsed.has(g.key) ? "expand group" : "collapse group"}
      onClick={() => toggleGroup(g.key)}
    >
      <span className="text-[9px] text-ink-muted">
        {collapsed.has(g.key) ? "▸" : "▾"}
      </span>
      {g.color
        ? (
          <span
            className="rounded px-1.5 py-0.5 text-[10.5px] font-medium leading-none"
            style={{ color: g.color, background: g.color + "24" }}
          >
            {g.label}
          </span>
        )
        : (
          <span className="text-[11.5px] font-medium text-ink-soft">
            {g.label}
          </span>
        )}
      <span className="text-[10.5px] text-ink-muted/70">{g.rows.length}</span>
      {aggsOf(g.rows).map((s) => (
        <span
          key={s}
          className="ml-2 shrink-0 text-[10.5px] tabular-nums text-ink-muted/80"
        >
          {s}
        </span>
      ))}
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 px-6 pt-2">
          <ViewTabsBar state={tabState} props={props} onChange={changeTabs} />
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
            {summaryNeedsGroup
              ? (
                <div className="flex flex-col items-start gap-2 px-1 py-8 text-[13px] text-ink-muted">
                  <p className="m-0">
                    This is a summary view — one row per group with aggregates.
                  </p>
                  <p className="m-0 text-ink-muted/70">
                    Open <span className="text-ink-soft">▤ Group</span>{" "}
                    in the toolbar and pick a property to group by.
                  </p>
                </div>
              )
              : summaryMode
              ? (
                <SummaryBody
                  groupProp={groupProp!}
                  groups={groups!}
                  aggProps={aggProps}
                  aggs={deferredView.aggs ?? {}}
                />
              )
              : (
                <>
                  {/* header */}
                  <div
                    className="grid border-b border-line"
                    style={{ gridTemplateColumns: grid }}
                  >
                    {props.map((p) => (
                      <div
                        key={p.id}
                        className="group relative flex items-center border-r border-line-soft last:border-r-0"
                      >
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left text-[11px] font-medium text-ink-muted transition-colors hover:bg-panel/60 hover:text-ink-soft"
                          onClick={() => setEditor({ prop: p })}
                          title={p.type}
                        >
                          {p.config.icon
                            ? (
                              <EntityIcon
                                icon={p.config.icon}
                                className="shrink-0 text-[12px]"
                              />
                            )
                            : (
                              <span className="text-[10px] opacity-60">
                                {TYPE_GLYPH[p.type] ?? "?"}
                              </span>
                            )}
                          <span className="truncate">{p.name}</span>
                        </button>
                        <button
                          type="button"
                          className={`flex shrink-0 items-center gap-0.5 px-1 py-1.5 text-[9px] transition-colors hover:text-ink ${
                            sortDirOf(p.id)
                              ? "text-copper"
                              : "text-transparent hover:text-ink-muted group-hover:text-ink-muted/60"
                          }`}
                          title={sortDirOf(p.id)
                            ? "cycle sort (asc → desc → off)"
                            : "sort by this column"}
                          onClick={() => cycleSort(p.id)}
                        >
                          {sortDirOf(p.id)
                            ? (sortDirOf(p.id) === 1 ? "▲" : "▼")
                            : "↕"}
                          {sortDirOf(p.id) && view.sorts.length > 1 && (
                            <span className="text-[7px] leading-none">
                              {sortRank(p.id) + 1}
                            </span>
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
                      <button
                        type="button"
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
                  {/* rows — current page in group order; headers show whole-group stats */}
                  {groups
                    ? groups.map((g) => {
                      const collapsedG = collapsed.has(g.key);
                      const shown = collapsedG
                        ? []
                        : g.rows.filter((r) => pagedIds.has(r.id));
                      if (!collapsedG && shown.length === 0) return null; // rows on other pages
                      return (
                        <div key={g.key}>
                          {renderGroupHeader(g)}
                          {shown.map(renderRow)}
                        </div>
                      );
                    })
                    : pageRows.map(renderRow)}
                  {/* footer */}
                  <button
                    type="button"
                    className="w-full px-2 py-1.5 text-left text-xs text-ink-muted/70 transition-colors hover:bg-panel/40 hover:text-ink-soft"
                    onClick={addRow}
                  >
                    ＋ New row
                  </button>
                  {data.rows.length === 0 && (
                    <p className="px-2 pt-4 text-[12px] text-ink-muted/60">
                      No rows yet — add one, or add columns with the “+” header
                      cell.
                    </p>
                  )}
                  {data.rows.length > 0 && rows.length === 0 && (
                    <p className="px-2 pt-4 text-[12px] text-ink-muted/60">
                      No rows match the current filter.
                    </p>
                  )}
                </>
              )}
          </div>
        </div>
        {!summaryConfigured && rows.length > 0 && (
          <div className="flex items-center gap-2.5 border-t border-line-soft px-6 py-1.5 text-[11px] text-ink-muted">
            <span>Rows / page</span>
            <div className="w-[70px]">
              <Select
                value={pageSize === PAGE_ALL ? "all" : String(pageSize)}
                onChange={(v) =>
                  changePageSize(v === "all" ? PAGE_ALL : Number(v))}
                options={[
                  { value: "25", label: "25" },
                  { value: "50", label: "50" },
                  { value: "100", label: "100" },
                  { value: "200", label: "200" },
                  { value: "all", label: "All" },
                ]}
                className="rounded-md border border-line bg-panel px-2 py-1 text-[11px] text-ink outline-none focus:border-chipline"
              />
            </div>
            <span className="flex-1" />
            {paginate && (
              <>
                <span className="tabular-nums">
                  {curPage * pageSize + 1}–{Math.min(
                    total,
                    (curPage + 1) * pageSize,
                  )} / {total}
                </span>
                <button
                  type="button"
                  disabled={curPage <= 0}
                  className="rounded-md border border-chipline px-2 py-0.5 transition-colors hover:text-ink-soft disabled:opacity-40"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  ‹
                </button>
                <span className="tabular-nums">{curPage + 1}/{pageCount}</span>
                <button
                  type="button"
                  disabled={curPage >= pageCount - 1}
                  className="rounded-md border border-chipline px-2 py-0.5 transition-colors hover:text-ink-soft disabled:opacity-40"
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                >
                  ›
                </button>
              </>
            )}
          </div>
        )}
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
});
