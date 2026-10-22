import { useEffect, useMemo, useRef, useState } from "react";
import { type DiagProcess, type Diagnostics as Snapshot, getDiagnostics } from "../api";
import { SECTION_LABEL, timeAgo } from "../ui/ui";

const PERIOD_MS = 2000;
const HISTORY = 90; // 3 minutes of samples

type Sample = { at: number; rss: number; cpu: number; httpBytes: number };

export const formatBytes = (n: number | null | undefined): string => {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
};

export const formatDuration = (s: number): string => {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(s % 60)}s`;
};

const formatCount = (n: number | null | undefined): string => (n == null ? "—" : n.toLocaleString());

// CPU share of one core between two samples (ms timestamps, cumulative CPU seconds)
export const cpuRate = (prevAt: number, prevCpu: number, at: number, cpu: number): number | null => {
  if (at <= prevAt) return null;
  return Math.max(0, (cpu - prevCpu) / ((at - prevAt) / 1000));
};

const totals = (s: Snapshot) => ({
  rss: s.processes.reduce((a, p) => a + p.rss, 0),
  cpu: s.processes.reduce((a, p) => a + p.cpuSeconds, 0),
  swap: s.processes.reduce((a, p) => a + (p.swap ?? 0), 0),
});

// one series, no legend: the tile's label names it
function Sparkline({ values, max, color, format }: { values: number[]; max?: number; color: string; format: (v: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const w = 160;
  const h = 36;
  // headroom keeps a flat series off the top edge
  const top = (max ?? Math.max(1e-9, ...values)) * 1.15;
  const pts = values.map((v, i) => [
    values.length > 1 ? (i / (values.length - 1)) * w : w,
    h - 2 - (Math.min(v, top) / top) * (h - 4),
  ]);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = pts.length ? `${d} L${w},${h} L${pts[0][0].toFixed(1)},${h} Z` : "";
  const hi = hover != null ? pts[hover] : null;
  return (
    <div className="relative" style={{ width: w, height: h }}>
      <svg
        width={w}
        height={h}
        aria-hidden
        className="block overflow-visible"
        onMouseMove={(e) => {
          if (values.length < 2) return;
          const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
          setHover(Math.round((x / w) * (values.length - 1)));
        }}
        onMouseLeave={() => setHover(null)}
      >
        {area && <path d={area} fill={color} opacity={0.12} />}
        {pts.length > 1 && <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />}
        {hi && <circle cx={hi[0]} cy={hi[1]} r={3.5} fill={color} stroke="var(--color-panel)" strokeWidth={2} />}
      </svg>
      {hi && hover != null && (
        <div
          className="pointer-events-none absolute -top-6 whitespace-nowrap rounded border border-line bg-panel px-1.5 py-0.5 text-[10.5px] text-ink"
          style={{ left: Math.min(hi[0], w - 48) }}
        >
          {format(values[hover])}
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, hint, children }: { label: string; value: string; hint?: string; children?: React.ReactNode }) {
  return (
    <div className="flex min-w-[200px] flex-1 flex-col gap-1 rounded-lg border border-line bg-panel px-4 py-3">
      <div className={SECTION_LABEL}>{label.toUpperCase()}</div>
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="text-[20px] font-semibold leading-tight text-ink">{value}</div>
          {hint && <div className="text-[11px] text-ink-faint">{hint}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-baseline justify-between gap-4 text-[12.5px]">
    <span className="text-ink-muted">{label}</span>
    <span className="tabular-nums text-ink">{value}</span>
  </div>
);

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 rounded-lg border border-line bg-panel px-4 py-3">
      <div className={`${SECTION_LABEL} pb-1`}>{title.toUpperCase()}</div>
      {children}
    </section>
  );
}

const ROLE_HINT: Record<string, string> = {
  backend: "the app itself: HTTP API, sync, terminals",
  renderer: "WebKit page process: this UI's DOM and JS heap",
  "webkit network": "WebKit's HTTP process for the UI",
  "webkit gpu": "WebKit's GPU process",
  "plugin host": "out-of-tree plugins",
  "postgres supervisor": "keeps PostgreSQL tied to the app's lifetime",
  "postgres server": "the bundled PostgreSQL",
  "postgres worker": "a PostgreSQL connection or helper",
  "terminal shell": "a shell opened from Terminals",
};

export function Diagnostics() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Sample[]>([]);
  const prevProcs = useRef<Map<number, { at: number; cpu: number }>>(new Map());
  const [rates, setRates] = useState<Map<number, number>>(new Map());
  const [paused, setPaused] = useState(false);
  const [domNodes, setDomNodes] = useState(0);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!live) return;
      try {
        const s = await getDiagnostics();
        if (!live) return;
        const at = Date.now();
        const t = totals(s);
        setSnap(s);
        setError(null);
        setDomNodes(document.getElementsByTagName("*").length);
        setHistory((h) => [...h, { at, rss: t.rss, cpu: t.cpu, httpBytes: s.traffic.httpBytesIn + s.traffic.httpBytesOut }].slice(-HISTORY));
        const next = new Map<number, number>();
        for (const p of s.processes) {
          const prev = prevProcs.current.get(p.pid);
          const r = prev ? cpuRate(prev.at, prev.cpu, at, p.cpuSeconds) : null;
          if (r != null) next.set(p.pid, r);
        }
        prevProcs.current = new Map(s.processes.map((p) => [p.pid, { at, cpu: p.cpuSeconds }]));
        setRates(next);
      } catch (e) {
        if (live) setError(String(e));
      }
      if (live && !paused) timer = setTimeout(tick, PERIOD_MS);
    };
    tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [paused]);

  const series = useMemo(() => {
    const rss = history.map((s) => s.rss);
    const cpu = history.slice(1).map((s, i) => cpuRate(history[i].at, history[i].cpu, s.at, s.cpu) ?? 0);
    const net = history.slice(1).map((s, i) => Math.max(0, (s.httpBytes - history[i].httpBytes) / ((s.at - history[i].at) / 1000)));
    return { rss, cpu, net };
  }, [history]);

  if (!snap) {
    return <p className="p-6 text-ink-muted">{error ? `Diagnostics unavailable: ${error}` : "Sampling…"}</p>;
  }
  const t = totals(snap);
  const cpuNow = series.cpu.at(-1) ?? 0;
  const netNow = series.net.at(-1) ?? 0;
  const sys = snap.system;
  const memUsed = sys.memTotal != null && sys.memAvailable != null ? sys.memTotal - sys.memAvailable : null;
  // postgres names its helpers in their process title (checkpointer, walwriter, a client connection)
  const byRole = (p: DiagProcess) => (p.role === "postgres worker" && p.args.length ? p.args.join(" ") : ROLE_HINT[p.role] ?? p.name);

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3 text-[12px] text-ink-muted">
          <span>
            Trame v{snap.version} · pid {snap.pid} · up {formatDuration(snap.uptimeSeconds)}
          </span>
          <span className="text-ink-faint">sampled every {PERIOD_MS / 1000}s{error ? ` · last fetch failed: ${error}` : ""}</span>
          <span className="flex-1" />
          <button
            type="button"
            className="rounded-md border border-chipline px-2.5 py-1 text-[11.5px] text-ink-muted hover:text-ink-soft"
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? "Resume" : "Pause"}
          </button>
        </div>

        <div className="flex flex-wrap gap-3">
          <Tile label="Memory" value={formatBytes(t.rss)} hint={t.swap > 0 ? `+ ${formatBytes(t.swap)} swapped out` : "resident, all processes"}>
            <Sparkline values={series.rss} color="var(--color-chart-1)" format={formatBytes} />
          </Tile>
          <Tile
            label="CPU"
            value={`${Math.round(cpuNow * 100)}%`}
            hint={`of one core${sys.cpus ? ` · ${sys.cpus} cores` : ""} · ${formatDuration(t.cpu)} total`}
          >
            <Sparkline values={series.cpu} max={Math.max(1, ...series.cpu)} color="var(--color-chart-3)" format={(v) => `${Math.round(v * 100)}%`} />
          </Tile>
          <Tile label="Local HTTP" value={`${formatBytes(netNow)}/s`} hint={`${formatCount(snap.traffic.httpRequests)} requests since start`}>
            <Sparkline values={series.net} color="var(--color-chart-4)" format={(v) => `${formatBytes(v)}/s`} />
          </Tile>
        </div>

        <section className="overflow-hidden rounded-lg border border-line bg-panel">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className={`${SECTION_LABEL} text-left`}>
                <th className="px-4 py-2 font-medium">PROCESS</th>
                <th className="px-3 py-2 font-medium">PID</th>
                <th className="px-3 py-2 text-right font-medium">MEMORY</th>
                <th className="px-3 py-2 text-right font-medium">SWAP</th>
                <th className="px-3 py-2 text-right font-medium">CPU</th>
                <th className="px-3 py-2 text-right font-medium">THREADS</th>
                <th className="px-3 py-2 text-right font-medium">FDS</th>
                <th className="px-4 py-2 text-right font-medium">SOCKETS</th>
              </tr>
            </thead>
            <tbody>
              {snap.processes.map((p) => {
                const r = rates.get(p.pid);
                const depth = p.pid === snap.pid ? 0 : p.ppid === snap.pid ? 1 : 2;
                return (
                  <tr key={p.pid} className="border-t border-line-soft">
                    <td className="px-4 py-1.5" style={{ paddingLeft: 16 + depth * 14 }}>
                      <span className="text-ink">{p.role}</span>
                      <span className="ml-2 text-[11px] text-ink-faint" title={[p.name, ...p.args].join(" ")}>{byRole(p)}</span>
                    </td>
                    <td className="px-3 py-1.5 tabular-nums text-ink-muted">{p.pid}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-ink">{formatBytes(p.rss)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-ink-muted">{p.swap ? formatBytes(p.swap) : "—"}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-ink">{r == null ? "…" : `${Math.round(r * 100)}%`}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-ink-muted">{formatCount(p.threads)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-ink-muted">{formatCount(p.fds)}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums text-ink-muted">{formatCount(p.sockets)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3">
          <Card title="Hub sync">
            <Row label="Last sync" value={snap.lastSync ? `${timeAgo(snap.lastSync.at)} · ${snap.lastSync.pulled}↓ ${snap.lastSync.pushed}↑` : "never"} />
            <Row label="Requests" value={formatCount(snap.traffic.hubRequests)} />
            <Row label="Sent" value={formatBytes(snap.traffic.hubBytesOut)} />
            <Row label="Received" value={formatBytes(snap.traffic.hubBytesIn)} />
            <Row label="Realtime messages" value={`${formatCount(snap.traffic.wsMessages)} · ${formatBytes(snap.traffic.wsBytesIn)}`} />
          </Card>
          <Card title="Local HTTP">
            <Row label="Requests" value={formatCount(snap.traffic.httpRequests)} />
            <Row label="Received" value={formatBytes(snap.traffic.httpBytesIn)} />
            <Row label="Sent" value={formatBytes(snap.traffic.httpBytesOut)} />
            <Row label="Sockets open" value={formatCount(snap.processes.reduce((a, p) => a + (p.sockets ?? 0), 0))} />
          </Card>
          <Card title="Database">
            <Row label="Size on disk" value={formatBytes(snap.db?.size)} />
            <Row label="Connections" value={formatCount(snap.db?.connections)} />
          </Card>
          <Card title="This window">
            <Row label="DOM nodes" value={formatCount(domNodes)} />
            <Row label="Samples kept" value={`${history.length} / ${HISTORY}`} />
          </Card>
          <Card title="System">
            <Row label="Memory used" value={memUsed != null ? `${formatBytes(memUsed)} / ${formatBytes(sys.memTotal)}` : formatBytes(sys.memTotal)} />
            <Row label="Load (1 · 5 · 15 min)" value={sys.load ? sys.load.map((l) => l.toFixed(2)).join(" · ") : "—"} />
          </Card>
        </div>
      </div>
    </div>
  );
}
