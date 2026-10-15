// SQL source client: types and calls against /api/plugins/sql-source.
import { useCallback, useEffect, useState } from "react";

export type Column = { name: string; type: string };
export type RefreshStatus = {
  rows: number;
  created: number;
  updated: number;
  deleted: number;
  new_columns: Column[];
  claimed_columns: string[];
  refreshed_at: string;
  error: string | null;
};
export type SourceStatus = {
  id: string;
  name: string;
  db_id: string;
  interval_min: number;
  paused: boolean;
  connection: string;
  running: boolean;
  last: RefreshStatus | null;
  next_at: string | null;
};
export type Connection = { id: string; name: string; host: string; hasDsn: boolean };
/** One query column's target: a database column name, or null to skip it. */
export type ColumnMap = { from: string; to: string | null };
export type SourceDef = {
  id: string;
  name: string;
  connection_id: string;
  query: string;
  db_id: string;
  key_column: string;
  interval_min: number;
  delete_missing: boolean;
  paused: boolean;
  columns?: ColumnMap[];
};
export type PreviewResult = { columns: Column[]; rows: Record<string, unknown>[]; count: number; ms: number };
export type PreviewCell = number | string | boolean | { start: string } | null;
export type PreviewRowOp = "new" | "changed" | "same" | "kept" | "removed";
/** Dry-run table: `vals`/`old` are keyed by preview column id; rows are capped server-side. */
export type DryPreview = {
  columns: { id: string; name: string; type: string; source: boolean }[];
  rows: { id: string | null; op: PreviewRowOp; vals: Record<string, PreviewCell>; old: Record<string, PreviewCell> }[];
  total: number;
};
export type DryRun = {
  rows: number;
  created: number;
  updated: number;
  deleted: number;
  new_columns: Column[];
  claimed_columns: string[];
  preview?: DryPreview;
};
/** What POST /sources takes; `dsn` becomes a saved connection named `connection_name`. */
export type SourceInput = Omit<SourceDef, "id" | "connection_id" | "paused" | "columns"> & {
  columns: ColumnMap[];
  id?: string;
  connection_id?: string;
  dsn?: string;
  connection_name?: string;
  paused?: boolean;
  dry_run?: boolean;
};

const BASE = "/api/plugins/sql-source";
const CHANGED = "sql-source-changed";

export const notifyChanged = () => dispatchEvent(new Event(CHANGED));

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, body === undefined ? undefined : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${r.status}`);
  return json as T;
}

// throws while the plugin is disabled or its host is not running
export const getStatus = () => call<{ sources: SourceStatus[] }>("/status").then((r) => r.sources);
export const getSettings = () => call<{ enabled: boolean; connections: Connection[]; sources: SourceDef[] }>("/settings");
export const saveConnections = (connections: { id?: string; name: string; dsn?: string }[]) =>
  call<{ connections: Connection[] }>("/settings", { connections }).then((r) => (notifyChanged(), r));
export const preview = (b: { connection_id?: string; dsn?: string; query: string }) =>
  call<PreviewResult & { ok: true }>("/preview", b);
export const dryRun = (b: SourceInput) => call<{ dry_run: DryRun }>("/sources", { ...b, dry_run: true }).then((r) => r.dry_run);
export const saveSource = (b: SourceInput) => call<{ source: SourceDef }>("/sources", b).then((r) => (notifyChanged(), r));
export const pauseSource = (id: string, paused: boolean) =>
  call(`/sources/${encodeURIComponent(id)}/pause`, { paused }).then(notifyChanged);
export const disconnectSource = (id: string) => call(`/sources/${encodeURIComponent(id)}/delete`, {}).then(notifyChanged);
export const refreshSource = (id: string) =>
  call<{ status: RefreshStatus }>(`/refresh/${encodeURIComponent(id)}`, {}).then((r) => (notifyChanged(), r.status));

/** Sources (all, or those filling `dbId`) with their live status; null while disabled or unreachable. */
export function useSources(dbId?: string) {
  const [sources, setSources] = useState<SourceStatus[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(
    () =>
      getStatus().then((all) => setSources(dbId ? all.filter((s) => s.db_id === dbId) : all))
        .catch(() => setSources(null)),
    [dbId],
  );
  useEffect(() => {
    void load();
    addEventListener(CHANGED, load);
    return () => removeEventListener(CHANGED, load);
  }, [load]);
  const refresh = async (id: string, after?: () => void) => {
    setBusy(id);
    await refreshSource(id).catch(() => {});
    setBusy(null);
    await load();
    after?.();
  };
  return { sources, busy, refresh, load };
}

/** "hourly" / "every 15 min" / "by hand". */
export const scheduleLabel = (min: number) =>
  min === 0 ? "by hand" : min === 60 ? "hourly" : min === 1440 ? "daily" : `every ${min} min`;

/** Last-refresh summary: "N new, M changed" or the error text. */
export const lastLabel = (l: RefreshStatus | null) =>
  !l ? "never refreshed" : l.error ?? `${l.created} new, ${l.updated} changed`;
