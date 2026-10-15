// SQL source settings: one card per source. The connection string is write-only — the
// server answers hasDsn, so an empty field on save keeps the stored one.
import { useEffect, useState } from "react";
import { getPluginSettings, listUdbs, savePluginSettings, type UdbMeta } from "../../api";
import { FIELD_LABEL, Select } from "../../ui/ui";

type Source = {
  id?: string;
  name: string;
  dsn: string; // the draft only; never filled from the server
  hasDsn: boolean;
  query: string;
  db_id: string;
  key_column: string;
  interval_min: number;
  delete_missing: boolean;
};
type Test = { state: "busy" } | { state: "ok"; columns: string[] } | { state: "fail"; error: string };

const ID = "sql-source";
const field =
  "w-full rounded-md border border-line bg-panel px-2.5 py-1.5 font-mono text-[11px] text-ink outline-none focus:border-chipline";
const blank = (): Source => ({
  name: "",
  dsn: "",
  hasDsn: false,
  query: "",
  db_id: "",
  key_column: "",
  interval_min: 0,
  delete_missing: false,
});

function fromView(v: Record<string, unknown>): Source[] {
  return ((v.sources ?? []) as Omit<Source, "dsn">[]).map((s) => ({ ...s, dsn: "" }));
}

export function SqlSourceSettings() {
  const [sources, setSources] = useState<Source[]>([]);
  const [udbs, setUdbs] = useState<UdbMeta[]>([]);
  const [tests, setTests] = useState<Record<number, Test>>({});
  const [saved, setSaved] = useState<"idle" | "busy" | "done" | "fail">("idle");

  useEffect(() => {
    getPluginSettings(ID).then((v) => setSources(fromView(v))).catch(() => {});
    listUdbs().then(setUdbs).catch(() => {});
  }, []);

  const set = (i: number, patch: Partial<Source>) =>
    setSources((all) => all.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  const save = async () => {
    setSaved("busy");
    try {
      const view = await savePluginSettings(ID, {
        sources: sources.map(({ hasDsn: _, dsn, ...s }) => (dsn.trim() ? { ...s, dsn: dsn.trim() } : s)),
      });
      setSources(fromView(view));
      setSaved("done");
    } catch {
      setSaved("fail");
    }
  };

  const test = async (i: number) => {
    const s = sources[i];
    setTests((t) => ({ ...t, [i]: { state: "busy" } }));
    const r = await fetch(`/api/plugins/${ID}/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: s.id, dsn: s.dsn.trim(), query: s.query }),
    }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
    setTests((t) => ({ ...t, [i]: r.ok ? { state: "ok", columns: r.columns } : { state: "fail", error: r.error } }));
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 rounded-md border border-copper/30 px-2.5 py-2 text-[11.5px] text-ink-soft">
        The query runs read-only from this device. Its <b>results become ordinary rows</b> of the target database and
        sync to your hub and your other devices; the connection string stays on this device. Prefer a read-only role.
      </p>
      {sources.map((s, i) => {
        const t = tests[i];
        return (
          <div key={s.id ?? `new-${i}`} className="flex flex-col gap-2 rounded-lg border border-line p-3">
            <div className="flex items-center gap-2">
              <input
                className={`${field} flex-1 font-sans text-[12.5px]`}
                placeholder="Source name"
                aria-label="Source name"
                value={s.name}
                onChange={(e) => set(i, { name: e.target.value })}
              />
              <button
                type="button"
                className="text-[11px] text-ink-muted hover:text-blocked"
                onClick={() => setSources((all) => all.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </div>
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL}>CONNECTION STRING</span>
              <input
                type="password"
                autoComplete="off"
                className={field}
                placeholder={s.hasDsn ? "saved — leave empty to keep it" : "postgres://user:pass@host:5432/db"}
                value={s.dsn}
                onChange={(e) => set(i, { dsn: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL}>QUERY</span>
              <textarea
                className={`${field} min-h-[84px] resize-y`}
                placeholder='select id, label as "Name", value from kr'
                value={s.query}
                onChange={(e) => set(i, { query: e.target.value })}
              />
            </label>
            <div className="flex gap-2">
              <label className="flex min-w-0 flex-1 flex-col gap-1">
                <span className={FIELD_LABEL}>TARGET DATABASE</span>
                <Select
                  value={s.db_id}
                  placeholder="pick a database"
                  options={udbs.map((u) => ({ value: u.id, label: u.name, icon: u.icon }))}
                  onChange={(v) => set(i, { db_id: v })}
                />
              </label>
              <label className="flex w-[130px] flex-col gap-1">
                <span className={FIELD_LABEL}>KEY COLUMN</span>
                <input
                  className={field}
                  placeholder="id"
                  value={s.key_column}
                  onChange={(e) => set(i, { key_column: e.target.value })}
                />
              </label>
              <label className="flex w-[90px] flex-col gap-1">
                <span className={FIELD_LABEL}>EVERY (MIN)</span>
                <input
                  type="number"
                  min={0}
                  className={field}
                  title="0 = refresh by hand only"
                  value={s.interval_min}
                  onChange={(e) => set(i, { interval_min: Number(e.target.value) || 0 })}
                />
              </label>
            </div>
            <label className="flex items-center gap-2 text-[11.5px] text-ink-soft">
              <input
                type="checkbox"
                checked={s.delete_missing}
                onChange={(e) => set(i, { delete_missing: e.target.checked })}
              />
              Remove rows whose key is no longer in the results
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-md border border-chipline px-2 py-1 text-[11px] text-ink-soft hover:text-ink"
                onClick={() => test(i)}
              >
                Test
              </button>
              <span className="min-w-0 flex-1 truncate text-[11px]">
                {t?.state === "busy" && <span className="text-ink-muted">testing…</span>}
                {t?.state === "ok" && <span className="text-[--color-active]">✓ columns: {t.columns.join(", ")}</span>}
                {t?.state === "fail" && <span className="text-blocked" title={t.error}>✕ {t.error}</span>}
              </span>
            </div>
          </div>
        );
      })}
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="rounded-md border border-chipline px-2.5 py-1 text-[11.5px] text-ink-soft hover:text-ink"
          onClick={() => setSources((all) => [...all, blank()])}
        >
          ＋ Add source
        </button>
        <span className="flex-1" />
        {saved === "done" && <span className="text-[11px] text-ink-muted">✓ Saved</span>}
        {saved === "fail" && <span className="text-[11px] text-blocked">save failed</span>}
        <button
          type="button"
          className="rounded-md bg-copper px-3 py-1 text-[11.5px] font-medium text-copper-ink disabled:opacity-50"
          disabled={saved === "busy"}
          onClick={save}
        >
          Save
        </button>
      </div>
    </div>
  );
}
