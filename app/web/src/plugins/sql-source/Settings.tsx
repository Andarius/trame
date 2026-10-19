// SQL source settings: every source (click to edit) and the saved connections. Connection strings are write-only.
import { useCallback, useEffect, useState } from "react";
import { listUdbs, type UdbMeta } from "../../api";
import { appConfirm, FIELD_LABEL, timeAgo } from "../../ui/ui";
import {
  type Connection,
  disconnectSource,
  getSettings,
  saveConnections,
  scheduleLabel,
  type SourceStatus,
  useSources,
} from "./api";
import { SqlSourceDrawer } from "./Drawer";
import { SourceLogo } from "./Logo";

const field =
  "w-full rounded-md border border-line bg-panel px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-chipline";
const smallBtn = "rounded-md border border-chipline px-2 py-0.5 text-[11px] text-ink-soft hover:text-ink disabled:opacity-50";

function Connections() {
  const [conns, setConns] = useState<Connection[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [dsn, setDsn] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => getSettings().then((s) => setConns(s.connections)).catch(() => {}), []);
  useEffect(() => void load(), [load]);

  // the whole list is replaced; a blank dsn keeps the stored one, a missing connection is deleted
  const save = async (list: { id?: string; name: string; dsn?: string }[]) => {
    try {
      setConns((await saveConnections(list)).connections);
      setError(null);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  const keep = (c: Connection) => ({ id: c.id, name: c.name });

  return (
    <div className="flex flex-col gap-2">
      <span className={FIELD_LABEL}>SAVED CONNECTIONS</span>
      {conns.length === 0 && <span className="text-[11.5px] text-ink-muted/70">None yet.</span>}
      {conns.map((c) => (
        <div key={c.id} className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5">
          <SourceLogo size={18} />
          {renaming === c.id
            ? (
              <input
                autoFocus
                aria-label="Connection name"
                className={`${field} flex-1`}
                defaultValue={c.name}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  setRenaming(null);
                  if (v && v !== c.name) save(conns.map((x) => (x.id === c.id ? { ...keep(x), name: v } : keep(x))));
                }}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              />
            )
            : <span className="min-w-0 flex-1 truncate text-[12.5px]">{c.name}</span>}
          <span className="max-w-[160px] truncate text-[11px] text-ink-muted/70">{c.host}</span>
          <button type="button" className={smallBtn} onClick={() => setRenaming(c.id)}>Rename</button>
          <button
            type="button"
            className="text-[11px] text-ink-muted hover:text-blocked"
            onClick={() => save(conns.filter((x) => x.id !== c.id).map(keep))}
          >
            Delete
          </button>
        </div>
      ))}
      {adding
        ? (
          <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
            <input aria-label="Connection name" className={field} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
            <input
              type="password"
              autoComplete="off"
              aria-label="Connection string"
              className={`${field} font-mono text-[11px]`}
              placeholder="postgres://user:pass@host:5432/db"
              value={dsn}
              onChange={(e) => setDsn(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <button type="button" className="text-[11px] text-ink-muted hover:text-ink-soft" onClick={() => setAdding(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="rounded-md bg-copper px-3 py-1 text-[11.5px] font-medium text-copper-ink disabled:opacity-50"
                disabled={!dsn.trim()}
                onClick={async () => {
                  const ok = await save([...conns.map(keep), { name: name.trim() || "Connection", dsn: dsn.trim() }]);
                  if (ok) {
                    setAdding(false);
                    setName("");
                    setDsn("");
                  }
                }}
              >
                Save
              </button>
            </div>
          </div>
        )
        : (
          <div>
            <button type="button" className={smallBtn} onClick={() => setAdding(true)}>＋ Add connection</button>
          </div>
        )}
      {error && <span className="text-[11px] text-blocked">{error}</span>}
    </div>
  );
}

export function SqlSourceSettings() {
  const { sources, busy, refresh, load } = useSources();
  const [udbs, setUdbs] = useState<UdbMeta[]>([]);
  useEffect(() => void listUdbs().then(setUdbs).catch(() => {}), []);
  const dbName = (id: string) => udbs.find((u) => u.id === id)?.name ?? id;
  const [editing, setEditing] = useState<SourceStatus | null>(null);
  const remove = async (s: SourceStatus) => {
    if (!await appConfirm(`Delete "${s.name || s.id}"? Its rows stay; the columns become editable.`, "Delete")) return;
    await disconnectSource(s.id).catch(() => {});
  };
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 rounded-md border border-copper/30 px-2.5 py-2 text-[11.5px] text-ink-soft">
        Queries run read-only from this device. Their <b>results become ordinary rows</b> that sync to your hub and
        devices; connection strings stay here. Sources are created from a database page (“⇣ Connect”); click one below to edit it.
      </p>
      <div className="flex flex-col gap-2">
        <span className={FIELD_LABEL}>SOURCES</span>
        {sources === null && <span className="text-[11.5px] text-ink-muted/70">Turn the plugin on to see its sources.</span>}
        {sources?.length === 0 && <span className="text-[11.5px] text-ink-muted/70">No source yet.</span>}
        {sources?.map((s) => (
          <div
            key={s.id}
            className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-line px-3 py-2 hover:bg-hover"
            onClick={() => setEditing(s)}
          >
            <SourceLogo />
            <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${s.last?.error ? "bg-blocked" : "bg-active"}`} />
            <button
              type="button"
              title="Edit query & schedule"
              className="min-w-0 flex-1 truncate text-left text-[12.5px]"
              onClick={(e) => (e.stopPropagation(), setEditing(s))}
            >
              {s.name || s.id} <span className="text-ink-muted/70">→ {dbName(s.db_id)}</span>
            </button>
            <span className="text-[11px] text-ink-muted/70">{s.paused ? "paused" : scheduleLabel(s.interval_min)}</span>
            <span className={`text-[11px] ${s.last?.error ? "text-blocked" : "text-ink-muted/70"}`} title={s.last?.error ?? undefined}>
              {s.last ? (s.last.error ? "failed" : timeAgo(s.last.refreshed_at)) : "never"}
            </span>
            <button
              type="button"
              className={smallBtn}
              disabled={busy === s.id || s.running}
              onClick={(e) => (e.stopPropagation(), refresh(s.id))}
            >
              {busy === s.id ? "Refreshing…" : "Refresh"}
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
      </div>
      <Connections />
      {editing && (
        <SqlSourceDrawer dbId={editing.db_id} editId={editing.id} onClose={() => setEditing(null)} onDone={() => void load()} />
      )}
    </div>
  );
}
