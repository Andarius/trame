import { type ReactNode, useState } from "react";
import type { UdbMeta } from "../api";
import { DatabaseView } from "../udb/DatabaseTable";
import { EntityIcon } from "../ui/ui";

// typing in a field (cell, tab rename, popover search) keeps Esc for itself
const typing = (t: EventTarget) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

// A database shown on a page: placed by a {{trame:db=…}} block, or attached and listed at
// the end. Breakout: it uses the pane's width (100cqw minus the px-8 gutters), not the
// 820px text column. Opens in view mode (tabs and rows); the edit toggle brings back the
// toolbar, paging and new-row chrome for this viewer only.
export function PageDatabase({ dbId, udbs, fallback, handle, className = "" }: {
  dbId: string;
  udbs: UdbMeta[];
  fallback?: { name: string; icon: string | null };
  handle?: ReactNode; // the editor's drag handle, when the database is a page block
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const meta = udbs.find((d) => d.id === dbId) ?? fallback;
  return (
    <div
      className={`group/db relative left-1/2 flex w-[min(1400px,100cqw_-_4rem)] -translate-x-1/2 flex-col gap-1 ${className}`}
      onKeyDown={(e) => {
        if (editing && e.key === "Escape" && !e.defaultPrevented && !typing(e.target)) setEditing(false);
      }}
    >
      <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink">
        {handle && <span className="relative -ml-6 h-5 w-[22px] shrink-0">{handle}</span>}
        <EntityIcon icon={meta?.icon ?? null} fallback="⌗" className="text-ink-muted" />
        {meta?.name ?? "Database"}
        <button
          type="button"
          aria-pressed={editing}
          title={editing ? "Back to view (Esc)" : "Edit: filters, sorts, columns, new rows"}
          onClick={() => setEditing((v) => !v)}
          className={`ml-1 rounded-md px-1.5 py-0.5 text-[11px] font-normal transition-colors ${
            editing
              ? "bg-copper/15 text-copper"
              : "text-ink-muted opacity-0 hover:bg-panel hover:text-ink-soft focus-visible:opacity-100 group-hover/db:opacity-100"
          }`}
        >
          {editing ? "Done" : "Edit"}
        </button>
      </div>
      <DatabaseView dbId={dbId} epoch={0} udbs={udbs} compact={!editing} />
    </div>
  );
}
