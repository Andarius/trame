import { useEffect, useState } from "react";
import { type BoardData, type ClaudeSession, type TailStep, transcriptTail } from "../api";
import { openTerminal } from "../term/term-api";
import { SECTION_LABEL, timeAgo } from "../ui/ui";
import { AgentIcon } from "./agents";
import { agentCmd, ResumeButton, resumeCmd } from "./AgentSessions";
import { agentLabel, useResumeMode } from "./resume-modes";

const short = (path: string) => path.replace(/^\/home\/[^/]+/, "~");

// A past session, opened from Recent: what it was, where it left off, and how to pick it up again
export function RecentSession(
  { session, board, onOpenSession, onResumed }: {
    session: ClaudeSession;
    board: BoardData | null;
    onOpenSession: (card: string) => void;
    onResumed: (term: string) => void; // the shell it now runs in
  },
) {
  const modePick = useResumeMode();
  const [tail, setTail] = useState<{ steps: TailStep[]; more: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    setTail(null);
    setError(null);
    transcriptTail(session.source, session.claudeId).then(
      (t) => live && setTail(t),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [session.source, session.claudeId]);
  const card = board?.sessions.find((s) => s.id === session.claudeId || s.claude_id === session.claudeId);
  const agent = session.source === "codex" ? "codex" : "claude";
  const resume = async () => {
    try {
      const info = await openTerminal({
        cwd: session.repoPath,
        command: agentCmd(session),
        title: `${agentLabel(agent)} · ${session.title}`,
        card: card?.id ?? null,
      });
      onResumed(info.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const copy = async () => {
    await navigator.clipboard.writeText(resumeCmd(session)).catch(() => {});
    setCopied(true);
  };
  const btn = "rounded-md border border-line px-3 py-1.5 text-[12.5px] text-ink-soft hover:text-ink";

  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4 px-8 py-7">
      <div className="flex flex-col gap-1.5">
        <h2 className="text-[18px] font-semibold text-ink">{session.title}</h2>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-faint">
          <span className="flex items-center gap-1.5">
            <AgentIcon a={{ harness: agent, icon: null }} />
            {agentLabel(agent)}
          </span>
          {session.repoPath && <span>{short(session.repoPath)}</span>}
          {session.branch && <span>⎇ {session.branch}</span>}
          <span>last active {timeAgo(session.lastActive)}</span>
          {card && (
            <button type="button" className="text-ink-muted hover:text-ink" onClick={() => onOpenSession(card.id)}>
              card: {card.title} ↗
            </button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {session.repoPath && (
          <button type="button" className={`${btn} border-copper/60 bg-copper/10 text-ink`} onClick={() => void resume()}>
            ↻ Resume in a tab
          </button>
        )}
        <ResumeButton session={session} card={card?.id} onCopied={() => setCopied(true)} modePick={modePick} />
        <button type="button" className={btn} onClick={() => void copy()}>{copied ? "Copied" : "Copy command"}</button>
      </div>
      <section className="flex flex-col gap-1 rounded-lg border border-line bg-block px-4 py-3 font-mono text-[12px] leading-relaxed">
        <div className={`${SECTION_LABEL} pb-1 font-sans`}>WHERE YOU LEFT OFF</div>
        {error && <p className="text-ink-muted">{error}</p>}
        {!error && !tail && <p className="text-ink-faint">reading the transcript…</p>}
        {tail?.more && <p className="text-ink-faint">… earlier messages</p>}
        {tail?.steps.map((s, i) => <ReplayStep key={i} step={s} />)}
        {tail && tail.steps.length === 0 && <p className="text-ink-faint">Nothing said yet.</p>}
        {tail && tail.steps.length > 0 && (
          <p className="mt-1 flex items-center gap-2 text-[11px] text-ink-faint">
            <span className="h-px flex-1 bg-line" />resume to continue<span className="h-px flex-1 bg-line" />
          </p>
        )}
      </section>
      <section className="flex flex-col gap-1 rounded-lg border border-line px-4 py-3">
        <div className={SECTION_LABEL}>COMMAND</div>
        <code className="break-all font-mono text-[11.5px] text-ink-soft">{resumeCmd(session)}</code>
      </section>
    </div>
  );
}

const SHOWN_TOOLS = 4;
// markdown emphasis reads as noise in a terminal-style replay
const plain = (text: string) => text.replace(/\*\*(.+?)\*\*/g, "$1");

// one step of the tail, drawn the way Claude Code prints it
function ReplayStep({ step }: { step: TailStep }) {
  if (step.role === "tools") {
    const rest = step.tools.length - SHOWN_TOOLS;
    return (
      <div className="text-ink-soft">
        {step.tools.slice(0, SHOWN_TOOLS).map((t, i) => (
          <div key={i} className="truncate" title={t}>
            <span className="text-live">⏺</span> {t}
          </div>
        ))}
        {rest > 0 && <div className="pl-4 text-ink-faint" title={step.tools.slice(SHOWN_TOOLS).join("\n")}>⎿ +{rest} more</div>}
      </div>
    );
  }
  if (step.role === "note") return <div className="text-ink-faint">· {step.text}</div>;
  if (step.role === "user") {
    return (
      <div className="mt-2 flex gap-2 whitespace-pre-wrap break-words text-ink">
        <span className="shrink-0 text-copper">&gt;</span>
        <span className="min-w-0">{step.text}</span>
      </div>
    );
  }
  return (
    <div className="flex gap-2 whitespace-pre-wrap break-words text-ink-soft">
      <span className="shrink-0 text-ink">⏺</span>
      <span className="min-w-0">{plain(step.text)}</span>
    </div>
  );
}
