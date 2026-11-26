import { SECTION_LABEL } from "../ui/ui";
import { deleteRun, type RunStatus, useAgentDest, useAgentRuns } from "./agent-run";
import { AgentIcon } from "./agents";

const MARK: Record<RunStatus, { mark: string; tone: string }> = {
  starting: { mark: "◌", tone: "text-ink-faint" },
  ready: { mark: "●", tone: "text-live" },
  busy: { mark: "●", tone: "text-wait" },
  interrupting: { mark: "●", tone: "text-wait" },
  stopped: { mark: "○", tone: "text-ink-faint" },
  failed: { mark: "!", tone: "text-blocked" },
};

// The runs Trame owns in the agent view, above Recent; hidden until the user opts in or one exists.
export function AgentRuns({ selected, onSelect }: { selected: string | null; onSelect: (run: string) => void }) {
  const [claude] = useAgentDest("claude");
  const [codex] = useAgentDest("codex");
  const runs = useAgentRuns(claude === "agent" || codex === "agent" || selected !== null);
  if (!runs.length) return null;
  return (
    <section className="flex flex-col gap-0.5">
      <div className={`px-2 pb-1 ${SECTION_LABEL}`}>AGENT VIEW</div>
      {runs.map((r) => (
        <div key={r.id} className="group/run relative">
        <button
          type="button"
          title={`${r.cwd}\n${r.sessionId}`}
          className={`flex w-full items-start gap-1.5 rounded-md px-2 py-1 text-left text-[12.5px] ${selected === r.id ? "bg-active-row text-ink" : "text-ink-muted hover:text-ink-soft"}`}
          onClick={() => onSelect(r.id)}
        >
          {/* the agent's logo, its run state as a dot in the corner */}
          <span className="relative mt-0.5 shrink-0" title={r.status}>
            <AgentIcon a={{ harness: r.provider ?? "claude", icon: null }} />
            <span className={`absolute -bottom-1 -right-1 font-mono text-[9px] leading-none ${MARK[r.status].tone}`}>
              {MARK[r.status].mark}
            </span>
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{r.cwd.split("/").pop()}</span>
            <span className="truncate text-[11px] text-ink-faint">
              {r.provider === "codex" ? "Codex" : "Claude"} · {r.status}
            </span>
          </span>
        </button>
        {/* stops the run and drops it; the conversation stays resumable from Recent */}
        <button
          type="button"
          title="close this run"
          aria-label="close this run"
          className="absolute right-1.5 top-1.5 hidden rounded px-1 text-[11px] text-ink-faint hover:bg-hover hover:text-ink group-hover/run:block"
          onClick={() => void deleteRun(r.id).catch(() => {})}
        >
          ✕
        </button>
        </div>
      ))}
    </section>
  );
}
