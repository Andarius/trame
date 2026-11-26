import { SECTION_LABEL } from "../ui/ui";
import { type RunStatus, useAgentDest, useAgentRuns } from "./agent-run";

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
        <button
          key={r.id}
          type="button"
          title={`${r.cwd}\n${r.sessionId}`}
          className={`flex items-start gap-1.5 rounded-md px-2 py-1 text-left text-[12.5px] ${selected === r.id ? "bg-active-row text-ink" : "text-ink-muted hover:text-ink-soft"}`}
          onClick={() => onSelect(r.id)}
        >
          <span className={`w-3.5 shrink-0 text-center font-mono text-[12px] ${MARK[r.status].tone}`}>{MARK[r.status].mark}</span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{r.cwd.split("/").pop()}</span>
            <span className="truncate text-[11px] text-ink-faint">
              {r.provider === "codex" ? "Codex" : "Claude"} · {r.status}
            </span>
          </span>
        </button>
      ))}
    </section>
  );
}
