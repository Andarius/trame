import { useEffect, useState } from "react";
import { type BoardData, type ClaudeSession, type TailStep, transcriptTail } from "../api";
import { openTerminal } from "../term/term-api";
import { SECTION_LABEL, timeAgo } from "../ui/ui";
import { AgentIcon } from "./agents";
import { agentCmd, ResumeButton, resumeCmd } from "./AgentSessions";
import { agentLabel, useResumeMode } from "./resume-modes";
import { ReplayTerminal } from "../term/ReplayTerminal";

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
      <section className="flex flex-col gap-2">
        <div className={SECTION_LABEL}>WHERE YOU LEFT OFF</div>
        {error && <p className="text-[12.5px] text-ink-muted">{error}</p>}
        {!error && !tail && <p className="text-[12.5px] text-ink-faint">reading the transcript…</p>}
        {tail && <ReplayTerminal text={replay(tail)} className="h-[460px] border border-line" />}
      </section>
      <section className="flex flex-col gap-1 rounded-lg border border-line px-4 py-3">
        <div className={SECTION_LABEL}>COMMAND</div>
        <code className="break-all font-mono text-[11.5px] text-ink-soft">{resumeCmd(session)}</code>
      </section>
    </div>
  );
}

const SHOWN_TOOLS = 4;
const ESC = "\x1b[";
const dim = (t: string) => `${ESC}2m${t}${ESC}0m`;
const green = (t: string) => `${ESC}32m${t}${ESC}0m`;
const copper = (t: string) => `${ESC}38;2;217;130;91m${t}${ESC}0m`;
// a reply's later lines sit under its first, past the marker
const indent = (t: string) => t.replace(/\r?\n/g, "\r\n  ");
// markdown emphasis reads as noise in a terminal
const plain = (t: string) => t.replace(/\*\*(.+?)\*\*/g, "$1");
// `Bash(cargo test)`: the name bold, like Claude Code prints a tool call
const tool = (t: string) => t.replace(/^([^(]+)/, `${ESC}1m$1${ESC}22m`);

// the tail as Claude Code printed it: > prompts, ⏺ tool calls and replies, notes dimmed
const replay = ({ steps, more }: { steps: TailStep[]; more: boolean }) => {
  const out: string[] = [];
  if (more) out.push(dim("… earlier messages"), "");
  for (const s of steps) {
    if (s.role === "tools") {
      for (const t of s.tools.slice(0, SHOWN_TOOLS)) out.push(`${green("⏺")} ${tool(t)}`);
      if (s.tools.length > SHOWN_TOOLS) out.push(dim(`  ⎿ +${s.tools.length - SHOWN_TOOLS} more`));
    } else if (s.role === "note") out.push(dim(`· ${s.text}`), "");
    else if (s.role === "user") out.push(`${copper(">")} ${indent(s.text)}`, "");
    else out.push(`⏺ ${indent(plain(s.text))}`, "");
  }
  if (!steps.length) out.push(dim("Nothing said yet."));
  else out.push(dim("── resume to continue ──"));
  return out.join("\r\n");
};
