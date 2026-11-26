import { useEffect, useRef, useState } from "react";
import { termToken } from "../term/term-api";
import { type AgentDest, type Provider, useAgentDest } from "./agent-run";

const PROVIDERS: { p: Provider; label: string; ready: boolean }[] = [
  { p: "claude", label: "Claude Code", ready: true },
  { p: "codex", label: "Codex", ready: true },
];

// Per-provider choice of where new and resumed sessions open; absent means the terminal.
export function AgentViewSettings() {
  return (
    <div className="flex max-w-[620px] flex-col gap-4">
      <div className="text-[14px] font-semibold">Agent view</div>
      <p className="m-0 text-[12.5px] leading-relaxed text-ink-muted">
        The agent view runs the agent without a terminal: Trame shows its conversation, asks you to approve tools, answer its
        questions and review plans, and keeps typing local. It is experimental. The installed CLI still signs in by itself;
        Trame never handles its login.
      </p>
      {PROVIDERS.map(({ p, label, ready }) => <Row key={p} p={p} label={label} ready={ready} />)}
      <RelaySettings />
    </div>
  );
}

type RelayAction = "enable" | "disable" | "restart";
type RelayStatus = {
  enabled: boolean;
  available: boolean;
  phase: "off" | "unavailable" | "setupRequired" | "external" | "starting" | "running" | "error";
  detail: string;
  setupCommand: string | null;
};

async function relayRequest(action?: RelayAction): Promise<RelayStatus> {
  const response = await fetch("/api/agent-relay", {
    method: action ? "POST" : "GET",
    headers: { "content-type": "application/json", "x-trame-term": await termToken() },
    body: action ? JSON.stringify(action) : undefined,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.error ?? "Unable to reach the relay settings.");
  return data as RelayStatus;
}

function RelaySettings() {
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const request = useRef({ id: 0 });
  const changing = useRef(false);

  useEffect(() => {
    const pending = request.current;
    const refresh = async () => {
      if (changing.current) return;
      const id = ++pending.id;
      try {
        const next = await relayRequest();
        if (id === pending.id) {
          setStatus(next);
          setError(null);
        }
      } catch (err) {
        if (id === pending.id) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => {
      pending.id++;
      clearInterval(timer);
    };
  }, []);

  const change = async (action: RelayAction) => {
    if (changing.current) return;
    changing.current = true;
    const pending = request.current;
    const id = ++pending.id;
    setWorking(true);
    setError(null);
    try {
      const next = await relayRequest(action);
      if (id === pending.id) setStatus(next);
    } catch (err) {
      if (id === pending.id) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (id === pending.id) setWorking(false);
      changing.current = false;
    }
  };

  const button =
    "rounded-md border border-line px-2.5 py-1 text-[12.5px] text-ink-soft hover:text-ink disabled:opacity-50";
  const canRestart = status?.enabled && (
    status.phase === "running" || status.phase === "setupRequired" || status.phase === "error"
  );
  return (
    <section className="flex flex-col gap-2 border-t border-line pt-4">
      <h3 className="text-[14px] font-semibold">Agent relay</h3>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={status?.enabled ?? false}
          disabled={working || !(status?.available || status?.enabled)}
          className={`${button} ${status?.enabled ? "border-copper/50 bg-copper/10 text-ink" : ""}`}
          onClick={() => void change(status?.enabled ? "disable" : "enable")}
        >
          Manage relay with Trame
        </button>
        {canRestart && (
          <button type="button" className={button} disabled={working} onClick={() => void change("restart")}>
            {status.phase === "running" ? "Restart relay" : "Retry relay"}
          </button>
        )}
      </div>
      <p role="status" className={`m-0 text-[12.5px] ${error || status?.phase === "error" ? "text-blocked" : "text-ink-muted"}`}>
        {error ?? status?.detail ?? "Checking relay…"}
      </p>
      {status?.setupCommand && <code className="select-all break-all text-[11.5px] text-ink-soft">{status.setupCommand}</code>}
    </section>
  );
}

function Row({ p, label, ready }: { p: Provider; label: string; ready: boolean }) {
  const [dest, setDest] = useAgentDest(p);
  const seg = (on: boolean) =>
    `rounded-md px-3 py-1 text-[12.5px] ${on ? "bg-copper/15 text-ink" : "text-ink-muted hover:text-ink"} disabled:opacity-50`;
  return (
    <div className="flex items-center gap-4">
      <span className="w-28 text-[13px] text-ink-soft">{label}</span>
      <div className="flex gap-1 rounded-lg border border-line p-0.5">
        {(["terminal", "agent"] as AgentDest[]).map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={dest === d}
            disabled={!ready && d === "agent"}
            className={seg(dest === d)}
            onClick={() => setDest(d)}
          >
            {d === "terminal" ? "Terminal" : "Agent view (beta)"}
          </button>
        ))}
      </div>
      {!ready && <span className="text-[11.5px] text-ink-faint">not available yet</span>}
    </div>
  );
}
