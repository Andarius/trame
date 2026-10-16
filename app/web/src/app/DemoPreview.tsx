// Prototype only: two local instances stand in for the in-app workspace switch.
import { useState } from "react";
import type { AppStatus } from "../api.ts";

const REAL_URL = "http://127.0.0.1:8798";
const DEMO_URL = "http://127.0.0.1:8799";

export const isDemo = (status: AppStatus | null | undefined) => status?.nodeId === "demo";

const STEPS = ["Downloading demo-f1", "Starting the demo workspace", "Loading sample data"];
const DURATION = 3200;
const BUNDLE_MB = 1.2;

function useSwitch(target: string) {
  const [pct, setPct] = useState<number | null>(null);
  const start = () => {
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / DURATION);
      setPct(1 - (1 - p) ** 2); // ease-out, like a real download tailing off
      if (p < 1) requestAnimationFrame(tick);
      else location.href = target;
    };
    requestAnimationFrame(tick);
  };
  const step = pct === null ? null : Math.min(STEPS.length - 1, Math.floor(pct * STEPS.length));
  return { pct, step, start };
}

function Progress({ pct, step }: { pct: number; step: number }) {
  const label = step === 0
    ? `${STEPS[0]} · ${Math.min(BUNDLE_MB, (pct * STEPS.length * BUNDLE_MB)).toFixed(1)} / ${BUNDLE_MB} MB`
    : STEPS[step];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="h-2 overflow-hidden rounded-full bg-line/40">
        <div className="h-full rounded-full bg-copper" style={{ width: `${pct * 100}%` }} />
      </div>
      <div className="flex justify-between text-xs text-ink-muted">
        <span>{label}…</span>
        <span className="tabular-nums">{Math.round(pct * 100)}%</span>
      </div>
    </div>
  );
}

// the demo remembers which instance opened it, so Exit goes back there
function returnUrl() {
  const fromQuery = new URLSearchParams(location.search).get("return");
  try {
    if (fromQuery) sessionStorage.setItem("demo-return", fromQuery);
    return sessionStorage.getItem("demo-return") ?? REAL_URL;
  } catch {
    return fromQuery ?? REAL_URL;
  }
}

export function DemoBanner() {
  const exit = useSwitch(returnUrl());
  const [resetting, setResetting] = useState(false);
  return (
    <div className="flex items-center gap-3 border-b border-copper/50 bg-copper/15 px-6 py-2 text-sm">
      <span className="rounded bg-copper px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-copper-ink">
        Demo
      </span>
      <span className="text-ink-soft">
        You're exploring sample data. Nothing here touches your workspace, and changes are discarded on reset.
      </span>
      <span className="flex-1" />
      <button
        type="button"
        onClick={() => {
          setResetting(true);
          setTimeout(() => location.reload(), 1200);
        }}
        className="rounded-md border border-line px-2.5 py-1 text-xs text-ink-soft hover:text-ink"
      >
        {resetting ? "Resetting…" : "Reset demo"}
      </button>
      <button
        type="button"
        onClick={exit.start}
        className="rounded-md bg-copper px-2.5 py-1 text-xs font-medium text-copper-ink"
      >
        {exit.step === null ? "Exit demo" : "Back to your workspace…"}
      </button>
    </div>
  );
}

export function WelcomeCard() {
  const demo = useSwitch(`${DEMO_URL}/?return=${encodeURIComponent(location.origin)}`);
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border border-line bg-panel p-7">
        <h2 className="text-lg font-semibold text-ink">Welcome to Trame</h2>
        <p className="mt-2 text-sm text-ink-muted">
          Your board is empty. Sessions show up here as soon as a coding agent starts tracking its work.
        </p>
        <div className="mt-6 flex flex-col gap-2.5">
          {demo.pct === null
            ? (
              <button
                type="button"
                onClick={demo.start}
                className="rounded-md bg-copper px-3 py-2 text-sm font-medium text-copper-ink"
              >
                Explore a demo workspace
              </button>
            )
            : <Progress pct={demo.pct} step={demo.step ?? 0} />}
          <button
            type="button"
            className="rounded-md border border-line px-3 py-2 text-sm text-ink-soft hover:text-ink"
          >
            Set up tracking with Claude Code or Codex
          </button>
        </div>
        <p className="mt-4 text-xs text-ink-muted/70">
          The demo opens in this window with sample projects, pages and a database. Exit at any time to come back here.
        </p>
      </div>
    </div>
  );
}
