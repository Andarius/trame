import { useEffect, useState } from "react";
import { type BoardData, type ClaudeSession, type TailStep, transcriptTail } from "../api";
import { openTerminal } from "../term/term-api";
import { moveIn } from "../term/move-in";
import { enumCodec, SECTION_LABEL, timeAgo, useLocalStorage } from "../ui/ui";
import { AgentIcon } from "./agents";
import { agentCmd, ResumeButton, resumeCmd } from "./AgentSessions";
import { agentLabel, useResumeMode } from "./resume-modes";
import { ReplayTerminal } from "../term/ReplayTerminal";
import { AgentHistory } from "./AgentHistory";
import { heldBy, startRun, useAgentDest } from "./agent-run";

const VIEW_CODEC = enumCodec<"summary" | "history">(["summary", "history"]);

const short = (path: string) => path.replace(/^\/home\/[^/]+/, "~");

// A past session, opened from Recent: what it was, where it left off, and how to pick it up again
export function RecentSession(
  { session, board, onOpenSession, onResumed, onAgent }: {
    session: ClaudeSession;
    board: BoardData | null;
    onOpenSession: (card: string) => void;
    onResumed: (term: string) => void; // the shell it now runs in
    onAgent: (run: string) => void; // the agent-view run it now continues in
  },
) {
  const modePick = useResumeMode();
  const [view, setView] = useLocalStorage<"summary" | "history">("trame:recentView", "summary", VIEW_CODEC);
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
  // open in another terminal: resuming beside it would fork the conversation, so it moves here instead
  const elsewhere = !!session.live && session.live.kind !== "bg" && session.source !== "codex";
  const resume = async () => {
    try {
      if (elsewhere) {
        const info = await moveIn({ session: session.claudeId, card: card?.id ?? null, title: `${agentLabel(agent)} · ${session.title}` });
        if (info) onResumed(info.id);
        return;
      }
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
  const [dest] = useAgentDest(agent);
  // the agent view continues a conversation nobody else is writing to
  const viaAgent = dest === "agent" && agent === "claude" && !!session.repoPath && !session.live;
  const openAgent = async () => {
    try {
      const r = await startRun({ cwd: session.repoPath!, resume: session.claudeId });
      onAgent(r.id);
    } catch (e) {
      const run = heldBy(e);
      if (run) return onAgent(run);
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const copy = async () => {
    await navigator.clipboard.writeText(resumeCmd(session)).catch(() => {});
    setCopied(true);
  };
  const btn = "rounded-md border border-line px-3 py-1.5 text-[12.5px] text-ink-soft hover:text-ink";

  const title = <h2 className="text-[18px] font-semibold text-ink">{session.title}</h2>;
  const facts = [
    <span key="agent" className="flex items-center gap-1.5">
      <AgentIcon a={{ harness: agent, icon: null }} />
      {agentLabel(agent)}
    </span>,
    session.repoPath && <span key="repo">{short(session.repoPath)}</span>,
    session.branch && <span key="branch">⎇ {session.branch}</span>,
    <span key="active">last active {timeAgo(session.lastActive)}</span>,
    session.live && (
      <span key="live" className="text-live" title={agentCmd(session)}>
        ● {session.live.kind === "bg" ? "running in the background" : "open in another terminal"}
      </span>
    ),
    card && (
      <button key="card" type="button" className="text-left text-ink-muted hover:text-ink" onClick={() => onOpenSession(card.id)}>
        card: {card.title} ↗
      </button>
    ),
  ];
  const actions = (
    <>
      {viaAgent && (
        <button type="button" className={`${btn} border-copper/60 bg-copper/10 text-ink`} onClick={() => void openAgent()}>
          ✳ Continue in agent view
        </button>
      )}
      {session.repoPath && (
        <button type="button" className={viaAgent ? btn : `${btn} border-copper/60 bg-copper/10 text-ink`} onClick={() => void resume()}>
          {session.live?.kind === "bg" ? "↻ Attach in a tab" : elsewhere ? "↘ Move into Trame" : "↻ Resume in a tab"}
        </button>
      )}
      <ResumeButton session={session} card={card?.id} onCopied={() => setCopied(true)} modePick={modePick} />
      <button type="button" className={btn} onClick={() => void copy()}>{copied ? "Copied" : "Copy command"}</button>
    </>
  );
  const views = (
    <div className="flex gap-1 text-[11.5px]">
      {(["summary", "history"] as const).map((v) => (
        <button
          key={v}
          type="button"
          className={`rounded-md px-2 py-0.5 ${view === v ? "bg-copper/15 text-ink" : "text-ink-muted hover:text-ink"}`}
          onClick={() => setView(v)}
        >
          {v === "summary" ? "Summary" : "Full history"}
        </button>
      ))}
    </div>
  );

  // the whole conversation fills the page; the session's facts move to the rail beside it
  if (view === "history") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-6 py-3">
          {title}
          {views}
          <div className="ml-auto flex flex-wrap gap-2">{actions}</div>
        </div>
        {error && <p className="px-6 pt-2 text-[12.5px] text-ink-muted">{error}</p>}
        <AgentHistory
          source={session.source}
          id={session.claudeId}
          live={!!session.live}
          className="flex-1"
          side={
            <section className="flex flex-col gap-1.5 text-ink-faint">
              <div className={SECTION_LABEL}>SESSION</div>
              {facts}
              <code className="mt-1 break-all font-mono text-[10.5px] text-ink-muted" title="resume command">{resumeCmd(session)}</code>
            </section>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4 px-8 py-7">
      <div className="flex flex-col gap-1.5">
        {title}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-faint">{facts}</div>
      </div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <div className={SECTION_LABEL}>WHERE YOU LEFT OFF</div>
          <div className="ml-auto">{views}</div>
        </div>
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

// the tail as Claude Code printed it: > prompts, ● tool calls and replies, notes dimmed
const replay = ({ steps, more }: { steps: TailStep[]; more: boolean }) => {
  const out: string[] = [];
  if (more) out.push(dim("… earlier messages"), "");
  for (const s of steps) {
    if (s.role === "tools") {
      for (const t of s.tools.slice(0, SHOWN_TOOLS)) out.push(`${green("●")} ${tool(t)}`);
      if (s.tools.length > SHOWN_TOOLS) out.push(dim(`  ⎿ +${s.tools.length - SHOWN_TOOLS} more`));
    } else if (s.role === "note") out.push(dim(`· ${s.text}`), "");
    else if (s.role === "user") out.push(`${copper(">")} ${indent(s.text)}`, "");
    else out.push(`● ${indent(plain(s.text))}`, "");
  }
  if (!steps.length) out.push(dim("Nothing said yet."));
  else out.push(dim("── resume to continue ──"));
  return out.join("\r\n");
};
