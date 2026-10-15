import type { ReactNode } from "react";
import { Modal } from "../../ui/ui";
import type { DryPreview, DryRun, PreviewCell, PreviewRowOp } from "./api";

const BADGE: Record<PreviewRowOp, string> = {
  new: "border-active/40 text-active",
  changed: "border-paused/40 text-paused",
  same: "border-chipline text-ink-muted",
  kept: "border-chipline text-ink-muted",
  removed: "border-blocked/40 text-blocked",
};

const show = (v: PreviewCell | undefined) =>
  v == null ? "" : typeof v === "object" ? v.start : typeof v === "boolean" ? (v ? "✓" : "") : String(v);

/** "＋N new · ↻N changed · N new columns · ✕N removed" */
export function dryLine(d: DryRun): ReactNode {
  const nc = d.new_columns.length;
  return (
    <>
      ＋{d.created} new · ↻{d.updated} changed
      {nc > 0 && <span className="text-copper"> · {nc} new column{nc > 1 ? "s" : ""}</span>}
      {d.deleted > 0 && <span className="text-blocked"> · ✕{d.deleted} removed</span>}
    </>
  );
}

export function PreviewModal({ dry, preview, saveLabel, canSave, busy, onSave, onClose }: {
  dry: DryRun;
  preview: DryPreview;
  saveLabel: string;
  canSave: boolean;
  busy: boolean;
  onSave: () => void;
  onClose: () => void;
}) {
  const count = (op: PreviewRowOp) => preview.rows.filter((r) => r.op === op).length;
  const same = count("same"), kept = count("kept");
  return (
    <Modal width={760} label="Preview" onClose={onClose}>
      <div className="flex items-center gap-2">
        <h2 className="m-0 flex-1 text-[13px] font-semibold">Preview · nothing written yet</h2>
        <button type="button" className="text-ink-muted hover:text-ink" title="close (esc)" onClick={onClose}>✕</button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[11.5px]">
          <thead>
            <tr>
              <th className="border-b border-line px-1.5 py-1" />
              {preview.columns.map((c) => (
                <th key={c.id} className="whitespace-nowrap border-b border-line px-1.5 py-1 text-left font-medium text-ink-muted">
                  {c.source && <span className="text-copper" title="filled by the query">⇣ </span>}
                  {c.name}
                  {!c.source && <span className="text-ink-muted/60"> (yours)</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((r, i) => {
              const muted = r.op === "kept" || r.op === "removed";
              return (
                <tr key={r.id ?? i} className="border-b border-line-soft">
                  <td className="px-1.5 py-1">
                    <span className={`rounded border px-1.5 py-px text-[10px] ${BADGE[r.op]}`}>{r.op}</span>
                  </td>
                  {preview.columns.map((c) => {
                    const nv = show(r.vals[c.id]), ov = show(r.old[c.id]);
                    const changed = r.op === "changed" && nv !== ov;
                    return (
                      <td key={c.id} className={`max-w-[220px] truncate whitespace-nowrap px-1.5 py-1 ${muted ? "text-ink-muted" : "text-ink-soft"}`}>
                        {changed
                          ? (
                            <>
                              {ov && <span className="mr-1 text-ink-muted line-through">{ov}</span>}
                              <span className="text-paused">{nv}</span>
                            </>
                          )
                          : (r.op === "removed" ? show(r.old[c.id] ?? r.vals[c.id]) : nv)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {preview.total > preview.rows.length && (
        <span className="text-[11px] text-ink-muted">showing {preview.rows.length} of {preview.total}</span>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="min-w-0 flex-1 text-[11.5px] text-ink-soft">
          {dryLine(dry)}
          {same > 0 && ` · ${same} same`}
          {kept > 0 && ` · ${kept} kept`}
        </span>
        <button type="button" className="rounded-md px-2.5 py-1.5 text-xs text-ink-muted hover:text-ink-soft" onClick={onClose}>
          Back
        </button>
        <button
          type="button"
          className="rounded-md bg-copper px-3 py-1.5 text-[12px] font-medium text-copper-ink disabled:opacity-50"
          disabled={busy || !canSave}
          onClick={onSave}
        >
          {saveLabel}
        </button>
      </div>
    </Modal>
  );
}
