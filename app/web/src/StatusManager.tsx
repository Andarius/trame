import { useState } from "react";
import {
  createStatus,
  deleteStatus,
  moveStatus as apiMoveStatus,
  type StatusDef,
  updateStatus,
} from "./api";
import { appConfirm, IconButton, MENU_LABEL } from "./ui";

const STATUS_PALETTE = [
  "#7bd88f",
  "#5fb8e8",
  "#7a9ee7",
  "#b590e7",
  "#e08bc4",
  "#e06c75",
  "#e3925e",
  "#e3c567",
  "#9aa4b2",
  "#6b7280",
];

// Board-column manager (lives in the "Columns" popover): reorder, rename, recolor,
// flag done-like (terminal), delete, and add statuses. All edits hit the synced DB.
export function StatusManager(
  { statuses, onChanged }: { statuses: StatusDef[]; onChanged: () => void },
) {
  const [paletteFor, setPaletteFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = (p: Promise<unknown>) => {
    setBusy(true);
    p.then(onChanged).finally(() => setBusy(false));
  };
  return (
    <div className="mt-1 border-t border-line-soft pt-1.5">
      <div className={`px-2 pb-1 ${MENU_LABEL}`}>
        STATUSES
      </div>
      {statuses.map((s, i) => (
        <div key={s.id}>
          <div className="flex items-center gap-1 px-1.5 py-0.5">
            <div className="flex flex-col leading-none">
              <button
                type="button"
                disabled={i === 0 || busy}
                onClick={() => run(apiMoveStatus(s.id, -1))}
                className="text-[7px] text-ink-muted hover:text-ink disabled:opacity-25"
                title="move up"
              >
                ▲
              </button>
              <button
                type="button"
                disabled={i === statuses.length - 1 || busy}
                onClick={() => run(apiMoveStatus(s.id, 1))}
                className="text-[7px] text-ink-muted hover:text-ink disabled:opacity-25"
                title="move down"
              >
                ▼
              </button>
            </div>
            <button
              type="button"
              onClick={() => setPaletteFor((c) => (c === s.id ? null : s.id))}
              className="h-3 w-3 shrink-0 rounded-full ring-1 ring-inset ring-white/10"
              style={{ background: s.color }}
              title="change color"
            />
            <input
              defaultValue={s.label}
              key={s.label}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== s.label) run(updateStatus(s.id, { label: v }));
              }}
              onKeyDown={(e) =>
                e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-xs text-ink-soft outline-none hover:bg-panel/60 focus:border-chipline focus:bg-panel"
            />
            <button
              type="button"
              onClick={() => run(updateStatus(s.id, { terminal: !s.terminal }))}
              disabled={busy}
              className={`shrink-0 rounded px-1 text-[10px] ${
                s.terminal
                  ? "text-copper"
                  : "text-ink-muted/50 hover:text-ink-muted"
              }`}
              title={s.terminal
                ? "done-like column (click to unset)"
                : "mark as a done-like column"}
            >
              ⚑
            </button>
            <IconButton disabled={statuses.length <= 1 || busy}
              onClick={() =>
                appConfirm(
                  `Delete the "${s.label}" status? Sessions in it move to another column.`,
                ).then((ok) => ok && run(deleteStatus(s.id)))}
              className="shrink-0 rounded px-1 text-[11px] text-ink-muted/60 hover:text-blocked disabled:opacity-25"
              title="delete status"
            >
              ✕
            </IconButton>
          </div>
          {paletteFor === s.id && (
            <div className="flex flex-wrap gap-1 px-2 pb-1.5 pt-0.5">
              {STATUS_PALETTE.map((c) => (
                <button
                  type="button"
                  key={c}
                  onClick={() => {
                    setPaletteFor(null);
                    if (c !== s.color) run(updateStatus(s.id, { color: c }));
                  }}
                  className={`h-4 w-4 rounded-full ring-1 ring-inset ${
                    c === s.color ? "ring-white/70" : "ring-white/10"
                  }`}
                  style={{ background: c }}
                />
              ))}
            </div>
          )}
        </div>
      ))}
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          run(createStatus({ label: "New status", color: STATUS_PALETTE[2] }))}
        className="mt-0.5 flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11.5px] text-ink-muted/70 hover:text-copper disabled:opacity-50"
      >
        <span className="text-[11px]">＋</span> Add status
      </button>
    </div>
  );
}

