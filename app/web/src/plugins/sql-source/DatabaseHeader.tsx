// SQL source: the plugin's status/refresh client, the toolbar control on a database it fills,
// and the sidebar panel listing every source.
import { useCallback, useEffect, useState } from "react";
import type { PanelProps } from "../index";
import { EmptyState, timeAgo } from "../../ui/ui";

export type RefreshStatus = {
  rows: number;
  created: number;
  updated: number;
  deleted: number;
  refreshed_at: string;
  error: string | null;
};
export type SourceStatus = {
  id: string;
  name: string;
  db_id: string;
  interval_min: number;
  running: boolean;
  last: RefreshStatus | null;
  next_at: string | null;
};

const BASE = "/api/plugins/sql-source";

// throws while the plugin is disabled or its host is not running: callers then show nothing
export async function getStatus(): Promise<SourceStatus[]> {
  const r = await fetch(`${BASE}/status`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return ((await r.json()) as { sources: SourceStatus[] }).sources;
}

export async function refreshSource(id: string): Promise<RefreshStatus> {
  const r = await fetch(`${BASE}/refresh/${encodeURIComponent(id)}`, { method: "POST" });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body as RefreshStatus;
}

function LastRefresh({ last }: { last: RefreshStatus | null }) {
  if (!last) return <span className="text-[11px] text-ink-muted/70">never refreshed</span>;
  if (last.error) {
    return <span className="text-[11px] text-blocked" title={last.error}>refresh failed: {last.error}</span>;
  }
  return (
    <span
      className="text-[11px] text-ink-muted/70"
      title={`${last.rows} rows · ${last.created} new · ${last.updated} changed · ${last.deleted} removed`}
    >
      refreshed {timeAgo(last.refreshed_at)}
    </span>
  );
}

// every source, or only those filling `dbId`
function useSources(dbId?: string) {
  const [sources, setSources] = useState<SourceStatus[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(
    () =>
      getStatus().then((all) => setSources(dbId ? all.filter((s) => s.db_id === dbId) : all))
        .catch(() => setSources(null)),
    [dbId],
  );
  useEffect(() => void load(), [load]);
  const refresh = async (id: string, after?: () => void) => {
    setBusy(id);
    await refreshSource(id).catch(() => {});
    setBusy(null);
    await load();
    after?.();
  };
  return { sources, busy, refresh };
}

export function SqlSourceDatabaseHeader({ dbId, onDone }: { dbId: string; onDone: () => void }) {
  const { sources, busy, refresh } = useSources(dbId);
  if (!sources?.length) return null;
  return (
    <>
      {sources.map((s) => (
        <span key={s.id} className="flex min-w-0 items-center gap-2">
          <LastRefresh last={s.last} />
          <button
            type="button"
            className="shrink-0 rounded-md border border-chipline px-2 py-0.5 text-[11px] text-ink-soft transition-colors hover:text-ink disabled:opacity-50"
            title={`refresh from the SQL source “${s.name || s.id}”`}
            disabled={busy === s.id}
            onClick={() => refresh(s.id, onDone)}
          >
            {busy === s.id ? "Refreshing…" : "⇣ Refresh"}
          </button>
        </span>
      ))}
    </>
  );
}

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
      {sources.length === 0 && <EmptyState block>No source yet — add one in the settings.</EmptyState>}
      {sources.map((s) => (
        <div key={s.id} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-[12.5px]">{s.name || s.id}</span>
          <span className="text-[11px] text-ink-muted/70">
            {s.interval_min ? `every ${s.interval_min} min` : "manual"}
          </span>
          <LastRefresh last={s.last} />
          <button
            type="button"
            className="rounded-md border border-chipline px-2 py-0.5 text-[11px] text-ink-soft hover:text-ink disabled:opacity-50"
            disabled={busy === s.id}
            onClick={() => refresh(s.id)}
          >
            {busy === s.id ? "Refreshing…" : "⇣ Refresh"}
          </button>
        </div>
      ))}
    </div>
  );
}
