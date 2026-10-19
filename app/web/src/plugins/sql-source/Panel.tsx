// Sidebar panel: every source on this device with its status; click one to edit it.
import { useState } from "react";
import type { PanelProps } from "../index";
import { appConfirm, EmptyState, timeAgo } from "../../ui/ui";
import { disconnectSource, scheduleLabel, type SourceStatus, useSources } from "./api";
import { SqlSourceDrawer } from "./Drawer";
import { SourceLogo } from "./Logo";

const BTN = "rounded-md border border-chipline px-2 py-0.5 text-[11px] text-ink-soft hover:text-ink disabled:opacity-50";

export function SqlSourcePanel({ onOpenSettings }: Pick<PanelProps, "onOpenSettings">) {
  const { sources, busy, refresh, load } = useSources();
  const [editing, setEditing] = useState<SourceStatus | null>(null);
  if (sources === null) return <EmptyState page>SQL source is unavailable.</EmptyState>;
  const remove = async (s: SourceStatus) => {
    if (!await appConfirm(`Delete "${s.name || s.id}"? Its rows stay; the columns become editable.`, "Delete")) return;
    await disconnectSource(s.id).catch(() => {});
  };
  return (
    <div className="flex flex-col gap-3 px-8 py-6">
      <div className="flex items-center gap-2">
        <h1 className="m-0 flex-1 text-[15px] font-semibold">SQL sources</h1>
        <button
          type="button"
          className="rounded-md border border-chipline px-2 py-1 text-[11px] text-ink-soft hover:text-ink"
          onClick={onOpenSettings}
        >
          Configure
        </button>
      </div>
      {sources.length === 0 && (
        <EmptyState block>No source yet — open a database and press “⇣ Connect”.</EmptyState>
      )}
      {sources.map((s) => (
        <div
          key={s.id}
          className="flex cursor-pointer items-center gap-3 rounded-lg border border-line px-3 py-2 hover:bg-hover"
          onClick={() => setEditing(s)}
        >
          <SourceLogo />
          <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${s.last?.error ? "bg-blocked" : "bg-active"}`} />
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-[12.5px]"
            title="Edit query & schedule"
            onClick={(e) => (e.stopPropagation(), setEditing(s))}
          >
            {s.name || s.id}
          </button>
          <span className="text-[11px] text-ink-muted/70">{s.paused ? "paused" : scheduleLabel(s.interval_min)}</span>
          <span
            className={`text-[11px] ${s.last?.error ? "text-blocked" : "text-ink-muted/70"}`}
            title={s.last?.error ?? undefined}
          >
            {s.last ? (s.last.error ? "refresh failed" : timeAgo(s.last.refreshed_at)) : "never refreshed"}
          </span>
          <button
            type="button"
            className={BTN}
            disabled={busy === s.id || s.running}
            onClick={(e) => (e.stopPropagation(), refresh(s.id))}
          >
            {busy === s.id ? "Refreshing…" : "⇣ Refresh"}
          </button>
          <button
            type="button"
            className="text-[11px] text-ink-muted hover:text-blocked"
            onClick={(e) => (e.stopPropagation(), remove(s))}
          >
            Delete
          </button>
        </div>
      ))}
      {editing && (
        <SqlSourceDrawer dbId={editing.db_id} editId={editing.id} onClose={() => setEditing(null)} onDone={() => void load()} />
      )}
    </div>
  );
}
