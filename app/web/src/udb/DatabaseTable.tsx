import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useState } from "react";
import { createUdbRow, getUdb, patchUdbRow, type Udb, type UdbMeta, type UdbProp, updateUdbProp } from "../api";
import { EntityIcon } from "../ui";
import { Cell, IconPicker } from "./cells";
import { PropertyEditor, TYPE_GLYPH } from "./PropertyEditor";
import { RowPanel } from "./RowPanel";

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

export function DatabaseView({ dbId, epoch, udbs }: { dbId: string; epoch: number; udbs: UdbMeta[] }) {
  const [data, setData] = useState<Udb | null>(null);
  const [editor, setEditor] = useState<{ prop: UdbProp | null } | null>(null); // null prop = create
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [iconFor, setIconFor] = useState<string | null>(null); // row id with the icon picker open
  const [widths, setWidths] = useState<Record<string, number>>({}); // live values while dragging

  const reload = useCallback(() => {
    getUdb(dbId).then(setData).catch(() => {});
  }, [dbId]);
  useEffect(reload, [reload, epoch]);
  useEffect(() => {
    setOpenRow(null);
    setWidths({});
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

  const patch = (rowId: string) => (propId: string, value: unknown) =>
    patchUdbRow(rowId, { [propId]: value }).then(reload);
  const addRow = () => createUdbRow(dbId).then((r) => {
    reload();
    setOpenRow(r.id);
  });

  const row = openRow ? data.rows.find((r) => r.id === openRow) ?? null : null;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-auto px-6 py-4">
        <div className="w-max min-w-full">
          {/* header */}
          <div className="grid border-b border-line" style={{ gridTemplateColumns: grid }}>
            {props.map((p) => (
              <div key={p.id} className="relative border-r border-line-soft last:border-r-0">
                <button type="button"
                  className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] font-medium text-ink-muted transition-colors hover:bg-panel/60 hover:text-ink-soft"
                  onClick={() => setEditor({ prop: p })}
                  title={p.type}
                >
                  <span className="text-[10px] opacity-60">{TYPE_GLYPH[p.type] ?? "?"}</span>
                  <span className="truncate">{p.name}</span>
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
          {/* rows */}
          {data.rows.map((r) => (
            <div
              key={r.id}
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
                      onClick={() => setIconFor(r.id)}
                    >
                      <EntityIcon icon={r.icon} fallback="◌" className={r.icon ? "" : "text-ink-muted"} />
                    </button>
                  )}
                  {i === 0 && iconFor === r.id && (
                    <IconPicker
                      current={r.icon}
                      onPick={(icon) => patchUdbRow(r.id, {}, icon).then(reload)}
                      onClose={() => setIconFor(null)}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <Cell prop={p} row={r} onPatch={patch(r.id)} onSaved={reload} onPropChanged={reload} />
                  </div>
                  {i === 0 && (
                    <button type="button"
                      className="mr-1 rounded border border-chipline/60 bg-panel px-1 py-0.5 text-[9px] text-ink-muted opacity-0 transition-opacity hover:text-ink group-hover:opacity-100"
                      title="open row"
                      onClick={() => setOpenRow(r.id)}
                    >
                      ⤢
                    </button>
                  )}
                </div>
              ))}
              <div />
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
