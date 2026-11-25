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
    </div>
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
