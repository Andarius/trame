// SQL source: refresh user databases from a read-only query on an external Postgres.
// Connection strings stay in the device-local settings slice; only the rows sync.
import { getPluginSettings, inTransaction, isPluginEnabled, type Plugin, type PluginSettings } from "../api.ts";
import { applyRefresh, type RefreshCounts, runSourceQuery, scrub, type Source, SourceError } from "./refresh.ts";

const ID = "sql-source";
const TICK_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Status = RefreshCounts & { refreshed_at: string; error: string | null };

// per source id; in memory, like the other plugins' poll state
const status = new Map<string, Status>();
const attempted = new Map<string, number>();
const running = new Map<string, Promise<Status>>();

const json = (data: unknown, code = 200) =>
  new Response(JSON.stringify(data), { status: code, headers: { "content-type": "application/json" } });

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function parseSources(raw: unknown): Source[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s) => s && typeof s === "object").map((s) => ({
    id: str(s.id),
    name: str(s.name),
    dsn: str(s.dsn),
    query: typeof s.query === "string" ? s.query : "",
    db_id: UUID.test(str(s.db_id)) ? str(s.db_id) : "",
    key_column: str(s.key_column),
    interval_min: Math.min(1440, Math.max(0, Math.round(Number(s.interval_min) || 0))),
    delete_missing: s.delete_missing === true,
  })).filter((s) => s.id);
}

async function sources(): Promise<Source[]> {
  return parseSources((await getPluginSettings(ID)).sources);
}

async function refreshOnce(source: Source): Promise<Status> {
  attempted.set(source.id, Date.now());
  const at = new Date().toISOString();
  try {
    if (!source.dsn) throw new SourceError("no connection string");
    if (!source.db_id) throw new SourceError("no target database");
    if (!source.key_column) throw new SourceError("no key column");
    const result = await runSourceQuery(source.dsn, source.query);
    const counts = await inTransaction((ctx) => applyRefresh(ctx, source, result));
    return { ...counts, refreshed_at: at, error: null };
  } catch (e) {
    const message = scrub(e instanceof Error ? e.message : String(e), source.dsn);
    if (!(e instanceof SourceError)) console.error(`sql-source: refresh of ${source.id} failed: ${message}`);
    return { rows: 0, created: 0, updated: 0, deleted: 0, refreshed_at: at, error: message };
  }
}

/** One refresh per source at a time; a second caller joins the running one. */
export function refresh(source: Source): Promise<Status> {
  const busy = running.get(source.id);
  if (busy) return busy;
  const run = refreshOnce(source).then((s) => {
    status.set(source.id, s);
    return s;
  }).finally(() => running.delete(source.id));
  running.set(source.id, run);
  return run;
}

const due = (s: Source, now: number) =>
  s.interval_min > 0 && now - (attempted.get(s.id) ?? 0) >= s.interval_min * 60_000;

async function tick(all = false): Promise<void> {
  const now = Date.now();
  for (const s of await sources()) if (all || due(s, now)) await refresh(s);
}

function view(s: Source) {
  const { dsn, ...rest } = s;
  return { ...rest, hasDsn: Boolean(dsn) };
}

function nextAt(s: Source): string | null {
  if (!s.interval_min) return null;
  return new Date((attempted.get(s.id) ?? Date.now()) + s.interval_min * 60_000).toISOString();
}

const plugin: Plugin = {
  id: ID,
  label: "SQL source",
  glyph: "⇣",
  description: "Refresh databases from a read-only query on an external Postgres.",
  ungatedRoutes: ["/test"],

  onEnabled() {
    tick(true).catch(console.error);
  },

  start() {
    const loop = async () => {
      if (await isPluginEnabled(ID)) await tick().catch(console.error); // toggle applies next tick
      setTimeout(loop, TICK_MS);
    };
    loop();
  },

  async routes(req, subPath) {
    if (subPath === "/status") {
      return json({
        sources: (await sources()).map((s) => ({
          id: s.id,
          name: s.name,
          db_id: s.db_id,
          interval_min: s.interval_min,
          running: running.has(s.id),
          last: status.get(s.id) ?? null,
          next_at: nextAt(s),
        })),
      });
    }
    const m = subPath.match(/^\/refresh\/([^/]+)$/);
    if (m && req.method === "POST") {
      const source = (await sources()).find((s) => s.id === decodeURIComponent(m[1]));
      if (!source) return json({ error: "unknown source" }, 404);
      const s = await refresh(source);
      return json({ ok: s.error === null, ...s });
    }
    if (subPath === "/test" && req.method === "POST") {
      // draft fields win over the saved source, so a source is testable before it is saved
      const body = await req.json().catch(() => ({}));
      const saved = (await sources()).find((s) => s.id === str(body.id));
      const dsn = str(body.dsn) || saved?.dsn || "";
      const query = typeof body.query === "string" ? body.query : saved?.query ?? "";
      if (!dsn) return json({ ok: false, error: "no connection string" });
      try {
        const { columns } = await runSourceQuery(dsn, `select * from (\n${query.trim().replace(/;\s*$/, "")}\n) as q limit 0`);
        return json({ ok: true, columns: columns.map((c) => c.name) });
      } catch (e) {
        return json({ ok: false, error: scrub(e instanceof Error ? e.message : String(e), dsn) });
      }
    }
    return null;
  },

  // dsn is write-only: an empty one keeps the stored value; sources missing from the list are dropped
  sanitizeSettings(raw, current) {
    const patch: PluginSettings = {};
    if (!Array.isArray(raw.sources)) return patch;
    const before = parseSources(current.sources);
    patch.sources = parseSources(
      raw.sources.map((s: Record<string, unknown>) => ({ ...s, id: str(s?.id) || crypto.randomUUID() })),
    ).map((s) => ({ ...s, dsn: s.dsn || before.find((b) => b.id === s.id)?.dsn || "" }));
    return patch;
  },

  settingsView(slice) {
    return { sources: parseSources(slice.sources).map(view) };
  },
};

export default plugin;
