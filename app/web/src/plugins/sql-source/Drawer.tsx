// "Fill from a SQL query": the right-side drawer that connects (or edits) a source for one database.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getUdb, type UdbProp } from "../../api";
import { Modal, FIELD_LABEL, IconButton, Select } from "../../ui/ui";
import { TYPE_GLYPH } from "../../udb/PropertyEditor";
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
import { dryLine, PreviewModal } from "./PreviewModal";
import { SqlEditor } from "./SqlEditor";

const NEW = "__new__";
const SKIP = "__skip__";
const DB = "db:";
const field =
  "w-full rounded-md border border-line bg-panel px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-chipline";
const cell = "rounded-md border border-chipline bg-transparent px-1.5 py-0.5 text-[11.5px] text-ink outline-none focus:border-copper/60";
const btn = "rounded-md border border-chipline px-2.5 py-0.5 text-[11.5px] text-ink-soft hover:text-ink disabled:opacity-50";
const UNITS = [{ v: "min", l: "minutes", m: 1 }, { v: "hour", l: "hours", m: 60 }, { v: "day", l: "days", m: 1440 }];
const MIN_EVERY = 5, MAX_EVERY = 30 * 1440;
const clampMin = (n: number) => Math.min(MAX_EVERY, Math.max(MIN_EVERY, Math.round(n) || 0));

type Health = { s: "ok" | "bad" | "checking"; msg: string };
type Target = { t: string; name?: string };
const DOT = { ok: "var(--color-active)", bad: "var(--color-blocked)", checking: "var(--color-chipline)" };

const Section = ({ label, right, children }: { label: string; right?: ReactNode; children: ReactNode }) => (
  <div className="flex flex-col gap-1.5">
    <span className={`${FIELD_LABEL} flex items-center`}>
      {label}
      {right && <span className="ml-auto font-normal tracking-normal">{right}</span>}
    </span>
    {children}
  </div>
);

const shortVersion = (v: unknown) => {
  const s = String(v ?? "");
  return /^PostgreSQL [\d.]+/.exec(s)?.[0] ?? s.slice(0, 40);
};

function ResultTable({ run }: { run: PreviewResult }) {
  return (
    <div className="overflow-x-auto rounded-md border border-line-soft">
      <table className="w-full border-collapse text-[11px]">
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
                <td key={c.name} className="max-w-[240px] truncate whitespace-nowrap px-1.5 py-0.5 text-ink-soft">
                  {r[c.name] == null ? "" : String(r[c.name])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** `editId` prefills from that existing source; the button then reads "Save & refresh". */
export function SqlSourceDrawer({ dbId, editId, onClose, onDone }: {
  dbId: string;
  editId?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [existing, setExisting] = useState<SourceDef | null>(null);
  const [props, setProps] = useState<UdbProp[]>([]);
  const [connId, setConnId] = useState("");
  const [dsn, setDsn] = useState("");
  const [connName, setConnName] = useState("");
  const [health, setHealth] = useState<Record<string, Health>>({});
  const [query, setQuery] = useState("");
  const [run, setRun] = useState<PreviewResult | null>(null);
  const [running, setRunning] = useState(false);
  const [targets, setTargets] = useState<Record<string, Target>>({});
  const [keyPick, setKeyPick] = useState<string | null>(null);
  const [mode, setMode] = useState<"manual" | "every">("every");
  const [num, setNum] = useState("1");
  const [unit, setUnit] = useState("hour");
  const [deleteMissing, setDeleteMissing] = useState(false);
  const [name, setName] = useState("");
  const [dry, setDry] = useState<DryRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"editor" | "preview" | null>(null);
  const seq = useRef(0);
  const dsnSeq = useRef(0);

  useEffect(() => {
    getSettings().then((s) => {
      setConnections(s.connections);
      const src = editId ? s.sources.find((x) => x.id === editId) : undefined;
      if (src) {
        setExisting(src);
        setConnId(src.connection_id);
        setQuery(src.query);
        setDeleteMissing(src.delete_missing);
        setName(src.name);
        if (src.interval_min <= 0) setMode("manual");
        else {
          const u = [...UNITS].reverse().find((x) => src.interval_min % x.m === 0) ?? UNITS[0];
          setNum(String(src.interval_min / u.m));
          setUnit(u.v);
        }
      } else setConnId(s.connections[0]?.id ?? NEW);
    }).catch((e) => setError((e as Error).message));
    getUdb(dbId).then((u) => {
      setProps(u.properties);
      if (!editId) setName((n) => n || u.db.name);
    }).catch(() => {});
  }, [dbId, editId]);

  // Esc closes the large editor / preview first, then the drawer
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && !view && onClose();
    addEventListener("keydown", h);
    return () => removeEventListener("keydown", h);
  }, [onClose, view]);

  const isNew = connId === NEW;

  // Connection status
  const check = (key: string, body: { connection_id?: string; dsn?: string }, stale?: () => boolean) => {
    setHealth((h) => ({ ...h, [key]: { s: "checking", msg: "" } }));
    preview({ ...body, query: "select version() as v" })
      .then((r) => ({ s: "ok", msg: shortVersion(r.rows[0]?.v) }) as Health)
      .catch((e) => ({ s: "bad", msg: (e as Error).message }) as Health)
      .then((res) => !stale?.() && setHealth((h) => ({ ...h, [key]: res })));
  };
  useEffect(() => {
    if (connId && connId !== NEW) check(connId, { connection_id: connId });
  }, [connId]);
  useEffect(() => {
    if (!isNew || !dsn.trim()) return;
    const n = ++dsnSeq.current;
    setHealth((h) => ({ ...h, [NEW]: { s: "checking", msg: "" } }));
    const t = setTimeout(() => check(NEW, { dsn: dsn.trim() }, () => n !== dsnSeq.current), 600);
    return () => clearTimeout(t);
  }, [isNew, dsn]);
  const status = health[connId];

  // Column mapping
  const queryCols = run?.columns.map((c) => c.name) ?? existing?.columns?.map((c) => c.from) ??
    (existing?.key_column ? [existing.key_column] : []);
  const propNames = props.map((p) => p.name);
  const defTarget = (q: string): Target => {
    const saved = existing?.columns?.find((c) => c.from === q);
    if (saved) return saved.to === null ? { t: SKIP } : propNames.includes(saved.to) ? { t: DB + saved.to } : { t: NEW, name: saved.to };
    return propNames.includes(q) ? { t: DB + q } : { t: NEW };
  };
  const target = (q: string): Target => targets[q] ?? defTarget(q);
  const resolve = (q: string): string | null => {
    const t = target(q);
    return t.t === SKIP ? null : t.t === NEW ? (t.name ?? q).trim() : t.t.slice(DB.length);
  };
  const titleName = props.find((p) => p.type === "title")?.name;
  const keyColumn = (keyPick && queryCols.includes(keyPick) ? keyPick : null) ??
    (existing && queryCols.includes(existing.key_column) ? existing.key_column : null) ??
    queryCols.find((q) => titleName && resolve(q) === titleName) ?? "";
  const setTarget = (q: string, t: Target) => setTargets((m) => ({ ...m, [q]: t }));
  const pickKey = (q: string) => {
    setKeyPick(q);
    if (target(q).t === SKIP) setTarget(q, { t: NEW });
  };
  const resolved = queryCols.map(resolve);
  const rowError = (q: string, i: number): string | null => {
    const to = resolved[i];
    if (to === null) return null;
    if (!to) return "name required";
    if (resolved.some((o, j) => j !== i && o === to)) return "already used";
    if (target(q).t === NEW && propNames.includes(to)) return "column exists";
    return null;
  };
  const mapErrors = queryCols.map(rowError);
  const columns = queryCols.map((q, i) => ({ from: q, to: resolved[i] }));
  const colsSig = JSON.stringify(columns);

  // Refresh
  const unitM = UNITS.find((u) => u.v === unit)?.m ?? 1;
  const intervalMin = mode === "manual" ? 0 : clampMin((Number(num) || 0) * unitM);
  const settleEvery = (n: string, u: string) => {
    const m = UNITS.find((x) => x.v === u)?.m ?? 1;
    const mins = clampMin((Number(n) || 0) * m);
    const exact = mins % m === 0;
    setUnit(exact ? u : "min");
    setNum(String(exact ? mins / m : mins));
  };
  const nextAt = new Date(Date.now() + intervalMin * 60_000).toLocaleString(
    [],
    intervalMin >= 1440 ? { weekday: "short", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" },
  );

  const input = (): SourceInput => ({
    id: existing?.id,
    name: name.trim() || "SQL source",
    ...(isNew ? { dsn: dsn.trim(), connection_name: connName.trim() || undefined } : { connection_id: connId }),
    query,
    db_id: dbId,
    key_column: keyColumn,
    columns,
    interval_min: intervalMin,
    delete_missing: deleteMissing,
  });
  const valid = !mapErrors.some(Boolean) && !!keyColumn && resolve(keyColumn) !== null;
  const ready = !!query.trim() && (isNew ? !!dsn.trim() : !!connId) && valid;

  // debounced dry-run once the key is chosen; any input change refreshes it
  useEffect(() => {
    setDry(null);
    if (!ready) return;
    const n = ++seq.current;
    const t = setTimeout(() =>
      dryRun(input()).then((d) => n === seq.current && (setDry(d), setError(null)))
        .catch((e) => n === seq.current && (setDry(null), setError((e as Error).message))), 400);
    return () => clearTimeout(t);
  }, [ready, keyColumn, colsSig, connId, dsn, query, deleteMissing]); // eslint-disable-line react-hooks/exhaustive-deps

  const doRun = async () => {
    if (running || !query.trim() || (isNew ? !dsn.trim() : !connId)) return;
    setRunning(true);
    setRunError(null);
    try {
      setRun(await preview({ ...(isNew ? { dsn: dsn.trim() } : { connection_id: connId }), query }));
    } catch (e) {
      setRun(null);
      setRunError((e as Error).message);
    }
    setRunning(false);
  };

  // an existing source runs its query on open, so its columns and preview show at once
  const autoRun = useRef(!!editId);
  useEffect(() => {
    if (!autoRun.current || !query.trim() || !connId || connId === NEW) return;
    autoRun.current = false;
    doRun();
  }, [query, connId]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveSource(input());
      onClose();
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setView(null);
    }
    setBusy(false);
  };

  const connOptions = [
    ...connections.map((c) => ({
      value: c.id,
      label: c.host ? `${c.name} · ${c.host}` : c.name,
      dot: DOT[health[c.id]?.s ?? "checking"],
    })),
    { value: NEW, label: "＋ new connection" },
  ];
  const targetOptions = (q: string, isKey: boolean) => [
    ...props.map((p) => ({ value: DB + p.name, label: `${TYPE_GLYPH[p.type] ?? ""} ${p.name}`.trim() })),
    { value: NEW, label: `＋ new column “${q}”` },
    ...(isKey ? [] : [{ value: SKIP, label: "— skip —" }]),
  ];
  const runnable = !running && !!query.trim() && (isNew ? !!dsn.trim() : !!connId);
  const saveLabel = existing ? "Save & refresh" : "Connect & fill";

  // on body: an inline database sits in the page editor, maybe under a transform
  return createPortal(
    // React bubbles portal events to the inline database, whose Esc would unmount this drawer
    <div onKeyDown={(e) => e.key === "Escape" && e.preventDefault()} className="fixed inset-y-0 right-0 z-40 flex w-[480px] max-w-full flex-col overflow-y-auto border-l border-line bg-sidebar shadow-[-16px_0_40px_rgba(0,0,0,0.35)]">
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
            onChange={(v) => (setConnId(v), setRun(null))}
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
                onChange={(e) => (setDsn(e.target.value), setRun(null))}
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
          {status && (
            <span className={`break-words text-[11px] ${status.s === "ok" ? "text-active" : status.s === "bad" ? "text-blocked" : "text-ink-muted"}`}>
              {status.s === "ok" ? `● connected · ${status.msg}` : status.s === "bad" ? status.msg : "checking…"}
            </span>
          )}
        </Section>

        <Section label="2 · QUERY" right={<span className="text-ink-muted">⌘↵ run</span>}>
          <div className="relative">
            <SqlEditor
              value={query}
              onChange={setQuery}
              onRun={doRun}
              height="190px"
              placeholder='select id, label as "Name", value from kr'
            />
            <IconButton
              tone="close"
              className="absolute right-2 top-1.5 rounded border border-chipline bg-panel px-1.5 text-[11px]"
              title="Open the large editor"
              onClick={() => setView("editor")}
            >
              ⤢
            </IconButton>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className={btn} disabled={!runnable} onClick={doRun}>▶ Run</button>
            {running && <span className="text-[11px] text-ink-muted">running…</span>}
            {run && <span className="text-[11px] text-active">{run.count} rows · {run.ms} ms</span>}
          </div>
          {runError && <p className="m-0 break-words text-[11px] text-blocked">{runError}</p>}
        </Section>

        {queryCols.length > 0 && (
          <Section label="3 · COLUMNS">
            <table className="w-full border-collapse text-[11.5px]">
              <thead>
                <tr className="text-left text-ink-muted">
                  <th className="px-1.5 py-1 font-medium">Query column</th>
                  <th className="px-1.5 py-1 font-medium">→ Database column</th>
                  <th className="px-1.5 py-1 font-medium">Key</th>
                </tr>
              </thead>
              <tbody>
                {queryCols.map((q, i) => {
                  const t = target(q);
                  const isKey = q === keyColumn;
                  return (
                    <tr key={q} className="border-t border-line-soft align-top">
                      <td className="whitespace-nowrap px-1.5 py-1 pt-1.5 text-ink-soft">{q}</td>
                      <td className="px-1.5 py-1">
                        <Select
                          value={t.t}
                          className={cell}
                          options={targetOptions(q, isKey)}
                          onChange={(v) => setTarget(q, { t: v, name: t.name })}
                        />
                        {t.t === NEW && (
                          <input
                            aria-label={`New column name for ${q}`}
                            className={`${cell} mt-1 w-full`}
                            value={t.name ?? q}
                            onChange={(e) => setTarget(q, { t: NEW, name: e.target.value })}
                          />
                        )}
                        {mapErrors[i] && <span className="text-[10.5px] text-blocked">{mapErrors[i]}</span>}
                      </td>
                      <td className="px-1.5 py-1 pt-1.5">
                        <input
                          type="radio"
                          name="key-col"
                          className="accent-copper"
                          aria-label={`Key: ${q}`}
                          checked={isKey}
                          onChange={() => pickKey(q)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <span className="text-[11px] text-ink-muted">
              Each target is an existing column, a new one (rename inline) or skip. The key row (◉) matches query rows to database rows.
            </span>
          </Section>
        )}

        <Section label="4 · REFRESH">
          <div className="flex items-center gap-2">
            <div className="w-[150px]">
              <Select
                value={mode}
                options={[{ value: "manual", label: "Manual only" }, { value: "every", label: "Every" }]}
                onChange={(v) => setMode(v as "manual" | "every")}
              />
            </div>
            {mode === "every" && (
              <>
                <input
                  type="number"
                  min={1}
                  aria-label="Refresh every"
                  className={`${field} !w-[64px]`}
                  value={num}
                  onChange={(e) => setNum(e.target.value)}
                  onBlur={() => settleEvery(num, unit)}
                />
                <div className="w-[110px]">
                  <Select
                    value={unit}
                    options={UNITS.map((u) => ({ value: u.v, label: u.l }))}
                    onChange={(v) => settleEvery(num, v)}
                  />
                </div>
              </>
            )}
          </div>
          {mode === "every" && <span className="text-[11px] text-ink-muted">Min 5 minutes, max 30 days. Next: {nextAt}</span>}
        </Section>

        <Section label="WHEN A KEY DISAPPEARS FROM THE RESULTS">
          <Select
            value={deleteMissing ? "remove" : "keep"}
            options={[{ value: "keep", label: "Keep the row" }, { value: "remove", label: "Remove it" }]}
            onChange={(v) => setDeleteMissing(v === "remove")}
          />
        </Section>

        <Section label="NAME">
          <input aria-label="Name" className={field} value={name} onChange={(e) => setName(e.target.value)} />
        </Section>

        {error && <p className="m-0 break-words text-[11px] text-blocked">{error}</p>}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="flex basis-full flex-col gap-0.5 text-[11.5px] text-ink-soft">
            {dry ? dryLine(dry) : <span className="text-ink-muted">pick a key to see what will change</span>}
            {dry && dry.claimed_columns.length > 0 && (
              <span className="text-copper">⇣ fills existing: {dry.claimed_columns.join(", ")} (read-only)</span>
            )}
          </div>
          <button type="button" className="rounded-md px-2.5 py-1.5 text-xs text-ink-muted hover:text-ink-soft" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`${btn} py-1.5`}
            disabled={!dry?.preview}
            title={dry?.preview ? undefined : "run the query first"}
            onClick={() => setView("preview")}
          >
            ⊞ Preview
          </button>
          <button
            type="button"
            className="rounded-md bg-copper px-3 py-1.5 text-[12px] font-medium text-copper-ink disabled:opacity-50"
            disabled={busy || !ready || !dry}
            onClick={submit}
          >
            {saveLabel}
          </button>
        </div>
      </div>

      {view === "editor" && (
        <Modal width={Math.min(1000, innerWidth - 48)} label="Large query editor" onClose={() => setView(null)}>
          <div className="flex items-center gap-2">
            <span className="text-copper">⇣</span>
            <h2 className="m-0 flex-1 text-[13px] font-semibold">
              Query · {isNew ? "new connection" : connections.find((c) => c.id === connId)?.name}
              {status && <span className="ml-2 inline-block h-[7px] w-[7px] rounded-full" style={{ background: DOT[status.s] }} />}
            </h2>
            <button type="button" className={btn} disabled={!runnable} onClick={doRun}>▶ Run ⌘↵</button>
            <IconButton tone="close" title="close (esc)" onClick={() => setView(null)}>✕</IconButton>
          </div>
          <SqlEditor value={query} onChange={setQuery} onRun={doRun} height="max(40vh, 240px)" />
          {running && <span className="text-[11px] text-ink-muted">running…</span>}
          {run && <span className="text-[11px] text-active">{run.count} rows · {run.ms} ms</span>}
          {runError && <p className="m-0 break-words text-[11px] text-blocked">{runError}</p>}
          {run && <ResultTable run={run} />}
        </Modal>
      )}
      {view === "preview" && dry?.preview && (
        <PreviewModal
          dry={dry}
          preview={dry.preview}
          saveLabel={saveLabel}
          canSave={ready}
          busy={busy}
          onSave={submit}
          onClose={() => setView(null)}
        />
      )}
    </div>,
    document.body,
  );
}
