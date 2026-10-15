// Sidebar panel: every source on this device with its status and a Refresh button.
import type { PanelProps } from "../index";
import { EmptyState, timeAgo } from "../../ui/ui";
import { scheduleLabel, useSources } from "./api";

export function SqlSourcePanel({ onOpenSettings }: Pick<PanelProps, "onOpenSettings">) {
  const { sources, busy, refresh } = useSources();
  if (sources === null) return <EmptyState page>SQL source is unavailable.</EmptyState>;
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
        <div key={s.id} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
          <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${s.last?.error ? "bg-blocked" : "bg-active"}`} />
          <span className="min-w-0 flex-1 truncate text-[12.5px]">{s.name || s.id}</span>
          <span className="text-[11px] text-ink-muted/70">{s.paused ? "paused" : scheduleLabel(s.interval_min)}</span>
          <span
            className={`text-[11px] ${s.last?.error ? "text-blocked" : "text-ink-muted/70"}`}
            title={s.last?.error ?? undefined}
          >
            {s.last ? (s.last.error ? "refresh failed" : timeAgo(s.last.refreshed_at)) : "never refreshed"}
          </span>
          <button
            type="button"
            className="rounded-md border border-chipline px-2 py-0.5 text-[11px] text-ink-soft hover:text-ink disabled:opacity-50"
            disabled={busy === s.id || s.running}
            onClick={() => refresh(s.id)}
          >
            {busy === s.id ? "Refreshing…" : "⇣ Refresh"}
          </button>
        </div>
      ))}
    </div>
  );
}
