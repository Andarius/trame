import { useEffect, useState } from "react";
import { clearSelection, IconButton } from "../ui/ui";
import { renderInline } from "./md-inline";
import type { TableOps } from "./md-types";

// GFM pipe-table row: strip outer pipes, split on unescaped `|`
export function parseTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}
export const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
// A column's width is the dash count of its separator cell (× PX_PER_DASH) —
// valid GFM either way, so it survives export, sync and any agent rewrite.
export const PX_PER_DASH = 8;
export const colWidth = (c: string) => {
  const n = (c.match(/-/g) ?? []).length;
  return n > 3 ? n * PX_PER_DASH : null;
};

export const colAlign = (c: string) =>
  c.startsWith(":") && c.endsWith(":")
    ? "text-center"
    : c.endsWith(":")
    ? "text-right"
    : "text-left";

// grow a cell editor to its content — a one-line input hid the rest of a long cell
function fitCell(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

// Card-framed table. When editable: click selects a row (shift = range,
// ctrl/cmd = toggle), ↑/↓ moves the selection, Delete removes it, Escape clears.
export function MdTable(
  { header, align, rows, lines, hdrIdx, ops }: {
    header: string[];
    align: (string | undefined)[];
    rows: string[][];
    lines: string[];
    hdrIdx: number;
    ops?: TableOps;
  },
) {
  const editable = Boolean(ops?.onEdit);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  // double-clicked cell being edited in place (raw markdown only via the ✏️ toolbar)
  const [editing, setEditing] = useState<{ ri: number; ci: number } | null>(
    null,
  );
  const [draft, setDraft] = useState("");
  // column being dragged by its header edge, with the live width
  const [drag, setDrag] = useState<{ ci: number; px: number } | null>(null);
  const base = hdrIdx + 2;
  const widths = parseTableRow(lines[hdrIdx + 1]).map(colWidth);
  const widthOf = (ci: number) =>
    drag?.ci === ci ? drag.px : widths[ci] ?? null;
  const sized = header.some((_, ci) => widthOf(ci) !== null);
  // the table needs at least the sum of its columns; autos get a readable share
  const minW = sized
    ? header.reduce((t, _, ci) => t + (widthOf(ci) ?? 120), editable ? 76 : 0)
    : null;
  const setColWidth = (ci: number, px: number) => {
    const cells = parseTableRow(lines[hdrIdx + 1]);
    const cur = (cells[ci] ?? "---").trim();
    const n = Math.max(4, Math.min(160, Math.round(px / PX_PER_DASH)));
    cells[ci] = `${cur.startsWith(":") ? ":" : ""}${"-".repeat(n)}${
      cur.endsWith(":") ? ":" : ""
    }`;
    const next = [...lines];
    next[hdrIdx + 1] = `| ${cells.join(" | ")} |`;
    ops?.onEdit?.(next.join("\n"));
  };
  // drag the right edge of a header cell; commit once, on release
  const startResize = (ci: number, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).parentElement as HTMLElement;
    const x0 = e.clientX, w0 = th.offsetWidth;
    const at = (ev: PointerEvent) => Math.max(40, w0 + ev.clientX - x0);
    const move = (ev: PointerEvent) => setDrag({ ci, px: at(ev) });
    const up = (ev: PointerEvent) => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      setDrag(null);
      setColWidth(ci, at(ev));
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  };
  // comment anchor for a row: its raw line, pipes stripped (see onCommentRow)
  const anchorOf = (ri: number) =>
    lines[base + ri].replaceAll("|", " ").trim().slice(0, 80);

  const apply = (rowLines: string[], nextSel: Set<number>) => {
    const next = [...lines];
    next.splice(base, rows.length, ...rowLines);
    setSel(nextSel);
    ops?.onEdit?.(next.join("\n"));
  };
  const moveSel = (dir: -1 | 1) => {
    if (!sel.size) return;
    const rl = lines.slice(base, base + rows.length);
    const flags = rl.map((_, idx) => sel.has(idx));
    const idxs = [...rl.keys()];
    if (dir === 1) idxs.reverse();
    for (const idx of idxs) {
      if (!flags[idx]) continue;
      const j = idx + dir;
      if (j < 0 || j >= rl.length || flags[j]) continue;
      [rl[idx], rl[j]] = [rl[j], rl[idx]];
      [flags[idx], flags[j]] = [flags[j], flags[idx]];
    }
    apply(rl, new Set(flags.flatMap((f, idx) => (f ? [idx] : []))));
  };
  const removeSel = () => {
    if (!sel.size) return;
    apply(
      lines.slice(base, base + rows.length).filter((_, idx) => !sel.has(idx)),
      new Set(),
    );
  };
  const rowLines = () => lines.slice(base, base + rows.length);
  const removeRow = (ri: number) =>
    apply(rowLines().filter((_, idx) => idx !== ri), new Set());
  const addRow = () => {
    apply(
      [...rowLines(), `| ${header.map(() => "").join(" | ")} |`],
      new Set(),
    );
    setEditing({ ri: rows.length, ci: 0 });
    setDraft("");
  };
  // rewrite one cell in its raw line; `then` chains Tab-editing into the next cell
  const commitCell = (
    ri: number,
    ci: number,
    value: string,
    then: { ri: number; ci: number } | null,
  ) => {
    const cells = parseTableRow(lines[base + ri]);
    cells[ci] = value.replaceAll("|", "\\|").trim();
    const next = [...lines];
    next[base + ri] = `| ${cells.join(" | ")} |`;
    setEditing(then);
    if (then) setDraft(parseTableRow(next[base + then.ri])[then.ci] ?? "");
    ops?.onEdit?.(next.join("\n"));
  };

  useEffect(() => {
    if (!sel.size) return;
    const key = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return; // cell edit owns the keys
      if (e.key === "ArrowUp") {
        e.preventDefault();
        moveSel(-1);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        moveSel(1);
      } else if (e.key === "Escape") {
        setSel(new Set());
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        removeSel();
      }
    };
    const clear = () => setSel(new Set());
    document.addEventListener("keydown", key);
    document.addEventListener("mousedown", clear);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("mousedown", clear);
    };
  });

  // checkbox column mirrors the List/database selection layout (shiftRange-style)
  const boxClick = (ri: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setSel((cur) => {
      const next = new Set(cur);
      if (e.shiftKey && anchor !== null) {
        const on = !cur.has(ri);
        const [lo, hi] = [Math.min(anchor, ri), Math.max(anchor, ri)];
        for (let k = lo; k <= hi; k++) {
          if (on) next.add(k);
          else next.delete(k);
        }
        return next;
      }
      if (next.has(ri)) next.delete(ri);
      else next.add(ri);
      return next;
    });
    setAnchor(ri);
  };

  return (
    <div
      // wider than the 820px text column (px-8 gutters) → grow into the margins
      className={`md-table-card group/table my-2 overflow-x-auto rounded-lg border border-line bg-block px-3 py-1 ${
        editable && minW && minW > 756
          ? "relative left-1/2 w-[min(1400px,100cqw_-_4rem)] -translate-x-1/2"
          : ""
      }`}
    >
      <table
        style={minW ? { minWidth: minW } : undefined}
        className={`w-full border-collapse text-[0.92em] ${
          sized ? "table-fixed" : ""
        }`}
      >
        {sized && (
          <colgroup>
            {editable && <col style={{ width: 24 }} />}
            {header.map((_, ci) => (
              <col
                key={ci}
                style={widthOf(ci) !== null
                  ? { width: widthOf(ci)! }
                  : undefined}
              />
            ))}
            {editable && <col style={{ width: 52 }} />}
          </colgroup>
        )}
        <thead>
          <tr>
            {editable && (
              <th className="w-6 border-b border-line px-1 py-2">
                <input
                  type="checkbox"
                  title="Select all rows"
                  className={`h-3.5 w-3.5 accent-[#c98a63] ${
                    sel.size ? "" : "opacity-0 hover:opacity-100"
                  }`}
                  checked={rows.length > 0 && sel.size === rows.length}
                  onChange={(e) =>
                    setSel(
                      e.target.checked
                        ? new Set(rows.map((_, idx) => idx))
                        : new Set(),
                    )}
                  onMouseDown={(e) =>
                    e.stopPropagation()}
                />
              </th>
            )}
            {header.map((h, ci) => (
              <th
                key={ci}
                className={`relative border-b border-line px-2.5 py-2 text-[0.8em] font-medium uppercase tracking-wider text-ink-muted ${
                  align[ci] ?? "text-left"
                }`}
              >
                {renderInline(h)}
                {editable && (
                  <span
                    title="Drag to resize this column"
                    onPointerDown={(e) => startResize(ci, e)}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    // the hairline shows on table hover: an invisible grip is
                    // one nobody finds
                    className="absolute -right-1.5 top-0 z-10 h-full w-3 cursor-col-resize after:absolute after:inset-y-1 after:left-1/2 after:w-px after:bg-copper/40 after:opacity-0 group-hover/table:after:opacity-100 hover:after:w-0.5 hover:after:bg-copper hover:after:opacity-100"
                  />
                )}
              </th>
            ))}
            {editable && <th className="w-0 border-b border-line" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => {
            const nComments = ops?.rowComments?.(anchorOf(ri)) ?? 0;
            return (
              <tr
                key={ri}
                className={`group/row border-b border-line-soft/50 last:border-0 ${
                  sel.has(ri) || nComments ? "bg-copper/[0.06]" : ""
                }`}
              >
                {editable && (
                  <td className="w-6 px-1 py-1.5 align-top">
                    <input
                      type="checkbox"
                      title="Select row — shift-click ranges, ↑↓ move, Del remove"
                      className={`h-3.5 w-3.5 accent-[#c98a63] ${
                        sel.size ? "" : "opacity-0 group-hover/row:opacity-100"
                      }`}
                      checked={sel.has(ri)}
                      readOnly
                      // no text selection on shift-click; keep block select/clear out of it
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        if (e.shiftKey) e.preventDefault();
                      }}
                      // toggle in onClick (not onChange): change events have no shiftKey
                      onClick={(e) => boxClick(ri, e)}
                    />
                  </td>
                )}
                {r.map((c, ci) => (
                  <td
                    key={ci}
                    title={editable &&
                        !(editing?.ri === ri && editing?.ci === ci)
                      ? "Double-click to edit"
                      : undefined}
                    onDoubleClick={(e) => {
                      if (!editable) return;
                      e.stopPropagation();
                      clearSelection();
                      setEditing({ ri, ci });
                      setDraft(c);
                    }}
                    className={`px-2.5 py-1.5 align-top text-ink-soft ${
                      align[ci] ?? "text-left"
                    }`}
                  >
                    {editing?.ri === ri && editing?.ci === ci
                      ? (
                        <textarea
                          autoFocus
                          rows={1}
                          ref={fitCell}
                          value={draft}
                          onChange={(e) => {
                            setDraft(e.target.value);
                            fitCell(e.target);
                          }}
                          onBlur={() => {
                            if (editing?.ri === ri && editing?.ci === ci) {
                              commitCell(ri, ci, draft, null);
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commitCell(ri, ci, draft, null);
                            } else if (e.key === "Escape") {
                              setEditing(null);
                            } else if (e.key === "Tab") {
                              e.preventDefault();
                              const d = e.shiftKey ? -1 : 1;
                              let nri = ri, nci = ci + d;
                              if (nci >= r.length) {
                                nri = ri + 1;
                                nci = 0;
                              } else if (nci < 0) {
                                nri = ri - 1;
                                nci = r.length - 1;
                              }
                              commitCell(
                                ri,
                                ci,
                                draft,
                                nri >= 0 && nri < rows.length
                                  ? { ri: nri, ci: nci }
                                  : null,
                              );
                            }
                          }}
                          style={{ font: "inherit" }}
                          className="block w-full resize-none overflow-hidden border-0 border-b border-copper/60 bg-transparent p-0 text-ink outline-none"
                        />
                      )
                      : renderInline(c)}
                  </td>
                ))}
                {editable && (
                  <td className="w-0 whitespace-nowrap px-1 py-1 align-top">
                    {ops?.onCommentRow && (
                      <button
                        type="button"
                        title={nComments
                          ? `${nComments} comment${
                            nComments > 1 ? "s" : ""
                          } on this row — add another`
                          : "Comment on this row"}
                        onClick={(e) => {
                          e.stopPropagation();
                          ops.onCommentRow?.(anchorOf(ri));
                        }}
                        className={`flex items-center gap-0.5 rounded px-1 text-[11px] hover:bg-panel hover:text-copper ${
                          nComments
                            ? "text-copper"
                            : "text-ink-muted opacity-0 group-hover/row:opacity-100"
                        }`}
                      >
                        💬{nComments > 0 && (
                          <span className="text-[10px] font-medium">
                            {nComments}
                          </span>
                        )}
                      </button>
                    )}
                    <IconButton tone="danger" aria-label="Delete this row"
                      title="Delete this row"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeRow(ri);
                      }}
                      className="rounded px-1 text-[11px] opacity-0 hover:bg-panel group-hover/row:opacity-100"
                    >
                      ×
                    </IconButton>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {editable && (
        <button
          type="button"
          title="Add a row at the end"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            addRow();
          }}
          className="my-1 w-full rounded px-2 py-1 text-left text-[0.8em] text-ink-muted opacity-0 hover:bg-panel hover:text-copper group-hover/table:opacity-100"
        >
          + Row
        </button>
      )}
    </div>
  );
}
