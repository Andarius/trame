// "Fill from a SQL query": the right-side drawer that connects (or edits) a source for one database.
import { useEffect, useRef, useState } from "react";
import { getUdb } from "../../api";
import { FIELD_LABEL, IconButton, Select } from "../../ui/ui";
import {
  type Connection,
  dryRun,
  type DryRun,
  getSettings,
  type PreviewResult,
  preview,
  saveSource,
  type SourceDef,
  type SourceInput,
} from "./api";

const NEW = "__new__";
const field =
  "w-full rounded-md border border-line bg-panel px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-chipline";
const SCHEDULES = [{ v: 0, l: "By hand" }, { v: 15, l: "15 min" }, { v: 60, l: "Hourly" }, { v: 1440, l: "Daily" }];

function Seg<T extends string | number>({ options, value, onChange }: {
  options: { v: T; l: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-chipline">
      {options.map((o) => (
        <button
          key={String(o.v)}
          type="button"
          onClick={() => onChange(o.v)}
          className={`px-2.5 py-0.5 text-[11px] ${value === o.v ? "bg-card text-ink" : "text-ink-muted hover:text-ink-soft"}`}
        >
          {o.l}
        </button>
      ))}
    </div>
  );
}

const Section = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-1.5">
    <span className={FIELD_LABEL}>{label}</span>
    {children}
  </div>
);

/** `editId` prefills from that existing source; the button then reads "Save & refresh". */
export function SqlSourceDrawer({ dbId, editId, onClose, onDone }: {
  dbId: string;
  editId?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [existing, setExisting] = useState<SourceDef | null>(null);
  const [connId, setConnId] = useState("");
  const [dsn, setDsn] = useState("");
  const [connName, setConnName] = useState("");
  const [query, setQuery] = useState("");
  const [run, setRun] = useState<PreviewResult | null>(null);
  const [running, setRunning] = useState(false);
  const [keyColumn, setKeyColumn] = useState("");
  const [interval, setIntervalMin] = useState(60);
  const [deleteMissing, setDeleteMissing] = useState(false);
  const [name, setName] = useState("");
  const [dry, setDry] = useState<DryRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    getSettings().then((s) => {
      setConnections(s.connections);
      const src = editId ? s.sources.find((x) => x.id === editId) : undefined;
      if (src) {
        setExisting(src);
        setConnId(src.connection_id);
        setQuery(src.query);
        setKeyColumn(src.key_column);
        setIntervalMin(src.interval_min);
        setDeleteMissing(src.delete_missing);
        setName(src.name);
      } else setConnId(s.connections[0]?.id ?? NEW);
    }).catch((e) => setError((e as Error).message));
    if (!editId) getUdb(dbId).then((u) => setName((n) => n || u.db.name)).catch(() => {});
  }, [dbId, editId]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", h);
    return () => removeEventListener("keydown", h);
  }, [onClose]);

  const isNew = connId === NEW;
  const input = (): SourceInput => ({
    id: existing?.id,
    name: name.trim() || "SQL source",
    ...(isNew ? { dsn: dsn.trim(), connection_name: connName.trim() || undefined } : { connection_id: connId }),
    query,
    db_id: dbId,
    key_column: keyColumn,
    interval_min: interval,
    delete_missing: deleteMissing,
  });
  const ready = !!query.trim() && (isNew ? !!dsn.trim() : !!connId) && !!keyColumn;

  // any input change invalidates the dry-run summary
  const touch = () => setDry(null);

  // debounced dry-run once the key is chosen; any input change refreshes it
  useEffect(() => {
    if (!ready) return;
    const n = ++seq.current;
    const t = setTimeout(() =>
      dryRun(input()).then((d) => n === seq.current && (setDry(d), setError(null)))
        .catch((e) => n === seq.current && (setDry(null), setError((e as Error).message))), 400);
    return () => clearTimeout(t);
  }, [ready, keyColumn, connId, dsn, query, deleteMissing]); // eslint-disable-line react-hooks/exhaustive-deps

  const doRun = async () => {
    setRunning(true);
    setRunError(null);
    try {
      const r = await preview({ ...(isNew ? { dsn: dsn.trim() } : { connection_id: connId }), query });
      setRun(r);
      if (!r.columns.some((c) => c.name === keyColumn)) setKeyColumn("");
    } catch (e) {
      setRun(null);
      setRunError((e as Error).message);
    }
    setRunning(false);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveSource(input());
      onClose();
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  const columns = run?.columns.map((c) => c.name) ?? (keyColumn ? [keyColumn] : []);
  const connOptions = [
    ...connections.map((c) => ({ value: c.id, label: c.host ? `${c.name} · ${c.host}` : c.name })),
    { value: NEW, label: "＋ new connection" },
  ];

  return (
    <div className="fixed inset-y-0 right-0 z-40 flex w-[400px] max-w-full flex-col overflow-y-auto border-l border-line bg-sidebar shadow-[-16px_0_40px_rgba(0,0,0,0.35)]">
      <div className="flex items-center gap-2 px-4 pb-1 pt-3.5">
        <span className="text-[13px] text-copper">⇣</span>
        <h2 className="m-0 flex-1 text-[13px] font-semibold">Fill from a SQL query</h2>
        <IconButton tone="close" className="rounded-md px-1.5 py-0.5 text-[13px] hover:bg-panel" title="close (esc)" onClick={onClose}>
          ✕
        </IconButton>
      </div>
      <div className="flex flex-col gap-4 px-4 pb-4 pt-2">
        <p className="m-0 rounded-md border border-copper/30 px-2.5 py-2 text-[11px] text-ink-soft">
          Query results become rows here and <b>sync to your hub and devices</b>. The connection string never leaves
          this laptop.
        </p>

        <Section label="1 · CONNECTION">
          <Select
            value={connId}
            placeholder="pick a connection"
            options={connOptions}
            onChange={(v) => (setConnId(v), setRun(null), touch())}
          />
          {isNew && (
            <>
              <input
                type="password"
                autoComplete="off"
                aria-label="Connection string"
                className={`${field} font-mono text-[11px]`}
                placeholder="postgres://user:pass@host:5432/db  or  host=… dbname=…"
                value={dsn}
                onChange={(e) => (setDsn(e.target.value), setRun(null), touch())}
              />
              <input
                aria-label="Connection name"
                className={field}
                placeholder="Connection name (optional)"
                value={connName}
                onChange={(e) => setConnName(e.target.value)}
              />
            </>
          )}
        </Section>

        <Section label="2 · QUERY">
          <textarea
            aria-label="Query"
            className={`${field} min-h-[110px] resize-y font-mono text-[11px]`}
            placeholder='select id, label as "Name", value from kr'
            value={query}
            onChange={(e) => (setQuery(e.target.value), touch())}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-md border border-chipline px-2.5 py-0.5 text-[11.5px] text-ink-soft hover:text-ink disabled:opacity-50"
              disabled={running || !query.trim() || (isNew ? !dsn.trim() : !connId)}
              onClick={doRun}
            >
              ▶ Run
            </button>
            {running && <span className="text-[11px] text-ink-muted">running…</span>}
            {run && <span className="text-[11px] text-active">{run.count} rows · {run.ms} ms</span>}
          </div>
          {runError && <p className="m-0 break-words text-[11px] text-blocked">{runError}</p>}
          {run && (
            <div className="overflow-x-auto rounded-md border border-line-soft">
              <table className="w-full border-collapse text-[10.5px]">
                <thead>
                  <tr>
                    {run.columns.map((c) => (
                      <th key={c.name} className="whitespace-nowrap px-1.5 py-0.5 text-left font-medium text-ink-muted/70" title={c.type}>
                        {c.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {run.rows.map((r, i) => (
                    <tr key={i} className="border-t border-line-soft">
                      {run.columns.map((c) => (
                        <td key={c.name} className="max-w-[140px] truncate whitespace-nowrap px-1.5 py-0.5 text-ink-soft">
                          {r[c.name] == null ? "" : String(r[c.name])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <Section label="3 · MATCH ROWS BY">
          <Select
            value={keyColumn}
            placeholder={run || existing ? "pick the key column" : "run the query first"}
            options={columns.map((c) => ({ value: c, label: c }))}
            onChange={(v) => setKeyColumn(v)}
          />
        </Section>

        <Section label="4 · KEEP IT FRESH">
          <Seg options={SCHEDULES} value={interval} onChange={setIntervalMin} />
        </Section>

        <Section label="WHEN A KEY DISAPPEARS FROM THE RESULTS">
          <Seg
            options={[{ v: "keep", l: "Keep the row" }, { v: "remove", l: "Remove it" }]}
            value={deleteMissing ? "remove" : "keep"}
            onChange={(v) => setDeleteMissing(v === "remove")}
          />
        </Section>

        <Section label="NAME">
          <input aria-label="Name" className={field} value={name} onChange={(e) => setName(e.target.value)} />
        </Section>

        {dry && (
          <div className="flex flex-col gap-0.5 rounded-md border border-line bg-panel px-2.5 py-2 text-[11px]">
            <span className={FIELD_LABEL}>CONNECTING WILL</span>
            <span className="text-active">＋ create {dry.created} rows</span>
            {dry.updated > 0 && <span className="text-ink-soft">↻ update {dry.updated} rows</span>}
            {dry.deleted > 0 && <span className="text-blocked">✕ remove {dry.deleted} rows</span>}
            {dry.new_columns.length > 0 && (
              <span className="text-copper">
                ＋ add columns {dry.new_columns.map((c) => `${c.name} (${c.type})`).join(", ")}
              </span>
            )}
            {dry.claimed_columns.map((c) => (
              <span key={c} className="text-copper">
                ⇣ fill the existing <b>{c}</b> column (read-only from now on)
              </span>
            ))}
            <span className="text-ink-muted/70">your other columns stay editable</span>
          </div>
        )}
        {error && <p className="m-0 break-words text-[11px] text-blocked">{error}</p>}

        <div className="flex items-center justify-end gap-2">
          <button type="button" className="rounded-md px-2.5 py-1.5 text-xs text-ink-muted hover:text-ink-soft" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-md bg-copper px-3 py-1.5 text-[12px] font-medium text-copper-ink disabled:opacity-50"
            disabled={busy || !ready || !dry}
            onClick={submit}
          >
            {existing ? "Save & refresh" : "Connect & fill"}
          </button>
        </div>
      </div>
    </div>
  );
}
