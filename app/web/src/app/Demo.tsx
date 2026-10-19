// Welcome card for an empty board and the demo workspace banner (desktop app only).
import { useEffect, useState } from "react";
import { demoAction, type DemoState, getDemo, getStatus } from "../api.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quiet = async <T,>(f: () => Promise<T>) => {
  try {
    return await f();
  } catch {
    return null; // the backend is restarting
  }
};
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

type Tick = (pct: number, label: string) => void;

// waits for the backend to come back with a new boot id, then until `done` says so
async function afterRestart(boot: string | undefined, demo: boolean, tick: Tick, base: number) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("The workspace took too long to start.");
    await sleep(300);
    const status = await quiet(getStatus);
    if (!status || status.boot === boot) continue;
    if (status.demo !== demo) {
      throw new Error(demo ? "The demo workspace could not start." : "Your workspace could not start.");
    }
    if (!demo) return;
    const d = await quiet(getDemo);
    if (!d) continue;
    if (d.phase === "failed") throw new Error(d.error ?? "Loading the sample data failed.");
    if (d.ops) tick(base + (1 - base) * d.done / d.ops, `Loading sample data · ${d.done}/${d.ops}`);
    if (d.phase === "ready") return;
  }
}

async function enterDemo(tick: Tick) {
  let d: DemoState = await getDemo();
  if (!d.seeded) {
    await demoAction("download");
    for (;;) {
      await sleep(250);
      d = await getDemo();
      if (d.phase === "failed") throw new Error(d.error ?? "The download failed.");
      if (d.phase !== "downloading") break;
      tick(
        d.total ? 0.5 * d.received / d.total : 0.05,
        `Downloading sample data · ${mb(d.received)}${d.total ? ` / ${mb(d.total)}` : ""}`,
      );
    }
  }
  tick(0.5, "Starting the demo workspace");
  const { boot } = await getStatus();
  await demoAction("enter");
  await afterRestart(boot, true, tick, 0.6);
  tick(1, "Opening the demo");
  location.reload();
}

function Progress({ pct, label }: { pct: number; label: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="h-2 overflow-hidden rounded-full bg-line/40">
        <div className="h-full rounded-full bg-copper transition-[width] duration-200" style={{ width: `${pct * 100}%` }} />
      </div>
      <div className="flex justify-between gap-3 text-xs text-ink-muted">
        <span className="truncate">{label}…</span>
        <span className="tabular-nums">{Math.round(pct * 100)}%</span>
      </div>
    </div>
  );
}

// true in the desktop app, outside the demo itself
export function useDemoAvailable() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    quiet(() => Promise.all([getDemo(), getStatus()])).then((r) => setAvailable(!!r && r[0].available && !r[1].demo));
  }, []);
  return available;
}

// "Explore a demo workspace" button with download/restart progress
export function DemoLauncher({ className }: { className?: string }) {
  const [progress, setProgress] = useState<{ pct: number; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const explore = () => {
    setError(null);
    setProgress({ pct: 0, label: "Downloading sample data" });
    enterDemo((pct, label) => setProgress({ pct, label })).catch((e: Error) => {
      setProgress(null);
      setError(e.message);
    });
  };
  return (
    <div className={`flex flex-col gap-2.5 ${className ?? ""}`}>
      {progress ? <Progress pct={progress.pct} label={progress.label} /> : (
        <button
          type="button"
          onClick={explore}
          className="rounded-md bg-copper px-3 py-2 text-sm font-medium text-copper-ink"
        >
          {error ? "Try the demo again" : "Explore a demo workspace"}
        </button>
      )}
      {error && <p className="m-0 text-xs text-blocked">{error}</p>}
    </div>
  );
}

export function WelcomeCard({ onImport, onDismiss }: { onImport: () => void; onDismiss: () => void }) {
  const canDemo = useDemoAvailable();
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border border-line bg-panel p-7">
        <h2 className="text-lg font-semibold text-ink">Welcome to Trame</h2>
        <p className="mt-2 text-sm text-ink-muted">
          Your board is empty. Sessions show up here as soon as a coding agent starts tracking its work.
        </p>
        <div className="mt-6 flex flex-col gap-2.5">
          {canDemo && <DemoLauncher />}
          <button
            type="button"
            onClick={onImport}
            className="rounded-md border border-line px-3 py-2 text-sm text-ink-soft hover:text-ink"
          >
            Import your Claude Code or Codex sessions
          </button>
          <button
            type="button"
            onClick={onDismiss}
            title="show the empty board"
            className="self-center rounded-md px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
          >
            Skip
          </button>
        </div>
        {canDemo && (
          <p className="mt-4 text-xs text-ink-muted/70">
            The demo opens in this window with sample projects, pages and databases. Your workspace stays untouched;
            exit at any time to come back. It is also in Settings.
          </p>
        )}
      </div>
    </div>
  );
}

export function DemoBanner() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (action: "exit" | "reset") => {
    setError(null);
    setBusy(action === "exit" ? "Back to your workspace" : "Resetting the demo");
    (async () => {
      const { boot } = await getStatus();
      await demoAction(action);
      await afterRestart(boot, action === "reset", (_, label) => setBusy(label), 0);
      location.reload();
    })().catch((e: Error) => {
      setBusy(null);
      setError(e.message);
    });
  };
  return (
    <div className="flex items-center gap-3 border-b border-copper/50 bg-copper/15 px-6 py-2 text-sm">
      <span className="rounded bg-copper px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-copper-ink">
        Demo
      </span>
      <span className="min-w-0 truncate text-ink-soft">
        {error ?? busy ?? "You're exploring sample data. Your workspace is untouched; Reset restores the demo."}
        {busy && "…"}
      </span>
      <span className="flex-1" />
      <button
        type="button"
        disabled={!!busy}
        onClick={() => run("reset")}
        className="rounded-md border border-line px-2.5 py-1 text-xs text-ink-soft hover:text-ink disabled:opacity-60"
      >
        Reset demo
      </button>
      <button
        type="button"
        disabled={!!busy}
        onClick={() => run("exit")}
        className="rounded-md bg-copper px-2.5 py-1 text-xs font-medium text-copper-ink disabled:opacity-60"
      >
        Exit demo
      </button>
    </div>
  );
}
