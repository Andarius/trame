import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "../md/md";
import { SECTION_LABEL } from "../ui/ui";
import { finalReply, type Keyed, type Tool, toolArg, toolDiffs, toTurns } from "./agent-history";
import { deleteRun, type Interaction, MODES, type Reply, restartRun, runToTerminal, type RunStatus, useAgentRun } from "./agent-run";
import { Diffs, HistoryRail, resultsOf, ToolInput, TurnView } from "./AgentHistory";

const STATUS: Record<RunStatus, { label: string; tone: string }> = {
  starting: { label: "starting", tone: "text-ink-faint" },
  ready: { label: "ready", tone: "text-live" },
  busy: { label: "working", tone: "text-wait" },
  interrupting: { label: "stopping the turn", tone: "text-wait" },
  stopped: { label: "stopped", tone: "text-ink-faint" },
  failed: { label: "failed", tone: "text-blocked" },
};
const btn = "rounded-md border border-line px-2.5 py-1 text-[12px] text-ink-soft hover:text-ink disabled:opacity-50";

// A run Trame owns: its conversation as Claude Code prints it, the decisions it waits on, and a composer.
export function AgentView(
  { runId, onClosed, onTerminal }: { runId: string; onClosed: () => void; onTerminal: (term: string) => void },
) {
  const run = useAgentRun(runId);
  const { state } = run;
  const [notice, setNotice] = useState<string | null>(null);
  const items = useMemo<Keyed[]>(
    () => (state?.items ?? []).map((item, i) => ({ key: (state?.droppedItems ?? 0) + i, item })),
    [state?.items, state?.droppedItems],
  );
  const turns = useMemo(() => toTurns(items), [items]);
  const results = useMemo(() => resultsOf(items), [items]);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [items, state?.partial, state?.interactions]);

  const tell = (r: Reply) => setNotice(r.accepted ? null : r.reason ?? "refused");
  const send = async (kind: string, payload?: Record<string, unknown>) => {
    const r = await run.send(kind, payload);
    tell(r);
    return r;
  };

  if (run.gone) {
    return (
      <div className="flex flex-col items-start gap-2 px-8 py-7 text-[12.5px] text-ink-muted">
        This agent run has ended and Trame no longer holds it.
        <button type="button" className={btn} onClick={onClosed}>Close</button>
      </div>
    );
  }
  if (!state) return <p className="px-8 py-7 text-[12.5px] text-ink-faint">connecting to the agent…</p>;

  const busy = state.status === "busy" || state.status === "interrupting";
  const ended = state.status === "stopped" || state.status === "failed";
  const folder = state.cwd.split("/").pop() || state.cwd;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-6 py-3">
        <h2 className="text-[16px] font-semibold text-ink" title={state.cwd}>{folder}</h2>
        <span className={`text-[12px] ${STATUS[state.status].tone}`}>● {STATUS[state.status].label}</span>
        {!run.connected && <span className="text-[12px] text-wait">reconnecting…</span>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select
            aria-label="permission mode"
            className="rounded-md border border-line bg-transparent px-2 py-1 text-[12px] text-ink-soft"
            value={state.mode ?? "default"}
            disabled={!run.writer || ended}
            onChange={(e) => void send("setMode", { mode: e.target.value })}
          >
            {MODES.map((m) => <option key={m.mode} value={m.mode}>{m.label}</option>)}
          </select>
          {busy && (
            <button type="button" className={btn} disabled={!run.writer} onClick={() => void send("interrupt")}>
              ■ Interrupt
            </button>
          )}
          {ended
            ? (
              <button
                type="button"
                className={`${btn} border-copper/60 bg-copper/10 text-ink`}
                onClick={() => restartRun(runId).catch((e: Error) => setNotice(e.message))}
              >
                ↻ Resume
              </button>
            )
            : <button type="button" className={btn} disabled={!run.writer} onClick={() => void send("stop")}>Stop</button>}
          <button
            type="button"
            className={btn}
            disabled={!run.writer || busy || state.interactions.length > 0}
            title="stop this run and continue the same conversation in a Trame terminal"
            onClick={() => runToTerminal(runId).then((r) => onTerminal(r.term), (e: Error) => setNotice(e.message))}
          >
            ›_ Continue in terminal
          </button>
          <button
            type="button"
            className={btn}
            title="stop the run and close this view; the conversation stays resumable"
            onClick={() => void deleteRun(runId).catch(() => {}).then(onClosed)}
          >
            Close
          </button>
        </div>
      </div>
      {state.status === "failed" && (
        <div className="whitespace-pre-wrap border-b border-blocked/40 bg-blocked/10 px-6 py-2 font-mono text-[11.5px] text-blocked">
          {state.error ?? "the agent stopped unexpectedly"}
        </div>
      )}
      {!run.writer && run.connected && (
        <div className="flex items-center gap-3 border-b border-line bg-wait/10 px-6 py-1.5 text-[12px] text-ink-soft">
          Another window is driving this run; this one is watching.
          <button type="button" className="text-copper hover:text-ink" onClick={run.takeOver}>Take over</button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            ref={scroller}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-4 font-mono text-[12px] leading-[1.55] text-ink-soft"
            onScroll={(e) => {
              const el = e.currentTarget;
              pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
          >
            {state.droppedItems > 0 && <p className="text-ink-faint">… {state.droppedItems} earlier items are in the transcript</p>}
            {!items.length && <p className="text-ink-faint">Nothing said yet. Write below to start.</p>}
            {turns.map((t, i) => (
              <TurnView
                key={t.key}
                turn={t}
                results={results}
                working={busy && i === turns.length - 1 && !finalReply(t)}
              />
            ))}
            {state.partial && (
              <div className="whitespace-pre-wrap text-ink">
                <span className="text-ink">● </span>
                {state.partial}
                <span className="animate-pulse text-copper">▍</span>
              </div>
            )}
            {state.interactions.map((x) => (
              <InteractionCard key={x.requestId} x={x} disabled={!run.writer} send={send} />
            ))}
          </div>
          {notice && <div className="px-6 pb-1 text-[11.5px] text-blocked">{notice}</div>}
          <Composer
            ready={state.status === "ready" && run.writer}
            busy={busy}
            onSend={(text) => send("prompt", { text })}
            onInterrupt={() => void send("interrupt")}
          />
        </div>
        <HistoryRail
          items={items}
          turns={turns}
          more={state.droppedItems > 0}
          onJump={(key) => {
            pinned.current = false;
            scroller.current?.querySelector(`[data-turn="${key}"]`)?.scrollIntoView({ block: "start" });
          }}
          side={
            <section className="flex flex-col gap-1.5 text-ink-faint">
              <div className={SECTION_LABEL}>RUN</div>
              <span>✳ Claude Code{state.model ? ` · ${state.model}` : ""}</span>
              <span className="break-all">{state.cwd.replace(/^\/(home|Users)\/[^/]+/, "~")}</span>
              <span>mode: {MODES.find((m) => m.mode === state.mode)?.label ?? state.mode ?? "default"}</span>
              <span>turns: {state.turn}</span>
              <code className="break-all font-mono text-[10.5px] text-ink-muted" title="the provider's session id">{state.sessionId}</code>
            </section>
          }
        />
      </div>
    </div>
  );
}

// The textarea keeps its own state so streaming renders never touch what is being typed.
const Composer = memo(function Composer(
  { ready, busy, onSend, onInterrupt }: {
    ready: boolean;
    busy: boolean;
    onSend: (text: string) => Promise<Reply>;
    onInterrupt: () => void;
  },
) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (ready) box.current?.focus({ preventScroll: true });
  }, [ready]);
  const submit = async () => {
    if (!ready || sending || !text.trim()) return;
    setSending(true);
    const r = await onSend(text);
    setSending(false);
    if (r.accepted) setText("");
  };
  return (
    <div className="border-t border-line-soft px-6 pb-4 pt-2">
      <div className="flex items-start gap-2 rounded-lg border border-chipline bg-panel px-3 py-2 font-mono text-[12px] focus-within:border-copper/60">
        <span className="pt-0.5 text-copper">&gt;</span>
        <textarea
          ref={box}
          rows={Math.min(8, Math.max(1, text.split("\n").length))}
          className="min-w-0 flex-1 resize-none bg-transparent text-ink outline-none placeholder:text-ink-faint"
          placeholder={ready ? "Message Claude…" : busy ? "Claude is working · Esc to interrupt" : "waiting for the agent"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape" && busy) {
              e.preventDefault();
              onInterrupt();
            }
          }}
        />
      </div>
      <div className="mt-1 text-[10.5px] text-ink-faint">⏎ send · ⇧⏎ newline · Esc interrupt</div>
    </div>
  );
});

type Send = (kind: string, payload?: Record<string, unknown>) => Promise<Reply>;
const card = "my-2 flex flex-col gap-2 rounded-lg border border-copper/50 bg-copper/5 px-4 py-3 font-sans text-[12.5px] text-ink";

// A request the agent is blocked on: a tool to allow, questions to answer or a plan to review.
function InteractionCard({ x, disabled, send }: { x: Interaction; disabled: boolean; send: Send }) {
  const [message, setMessage] = useState("");
  const answer = (decision: string, extra: Record<string, unknown> = {}) =>
    void send("answer", { requestId: x.requestId, decision, message, ...extra });
  if (x.kind === "question") return <QuestionCard x={x} disabled={disabled} send={send} />;
  if (x.kind === "plan") {
    return (
      <div className={card}>
        <div className={SECTION_LABEL}>PLAN TO APPROVE</div>
        <Markdown className="text-[12.5px] text-ink-soft" text={String(x.input.plan ?? "")} />
        <textarea
          className="rounded-md border border-line bg-transparent px-2 py-1 text-[12px] outline-none focus:border-copper/60"
          placeholder="What should change? (for Revise)"
          rows={2}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <div className="flex gap-2">
          <button type="button" className={`${btn} border-copper/60 bg-copper/10 text-ink`} disabled={disabled} onClick={() => answer("accept")}>
            Accept plan
          </button>
          <button type="button" className={btn} disabled={disabled || !message.trim()} onClick={() => answer("revise")}>
            Revise
          </button>
        </div>
      </div>
    );
  }
  const tool: Tool = { kind: "tool", id: x.toolUseId ?? x.requestId, name: x.tool, input: x.input };
  const diffs = toolDiffs(tool);
  return (
    <div className={card}>
      <div>
        Claude wants to use <span className="font-mono font-bold">{x.tool}</span>
        {toolArg(tool) && <span className="font-mono">({toolArg(tool)})</span>}
      </div>
      <div className="font-mono text-[11.5px]">{diffs ? <Diffs diffs={diffs} /> : <ToolInput tool={tool} />}</div>
      <input
        className="rounded-md border border-line bg-transparent px-2 py-1 text-[12px] outline-none focus:border-copper/60"
        placeholder="Tell Claude why (optional, sent with Deny)"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
      />
      <div className="flex gap-2">
        <button type="button" className={`${btn} border-copper/60 bg-copper/10 text-ink`} disabled={disabled} onClick={() => answer("allow")}>
          Allow
        </button>
        <button type="button" className={btn} disabled={disabled} onClick={() => answer("deny")}>Deny</button>
      </div>
    </div>
  );
}

type Question = { question: string; header?: string; multiSelect?: boolean; options?: { label: string; description?: string }[] };

function QuestionCard({ x, disabled, send }: { x: Interaction; disabled: boolean; send: Send }) {
  const questions = (Array.isArray(x.input.questions) ? x.input.questions : []) as Question[];
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const toggle = (q: Question, label: string) =>
    setPicked((p) => {
      const cur = p[q.question] ?? [];
      const next = q.multiSelect ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label];
      return { ...p, [q.question]: next };
    });
  const answers = Object.fromEntries(
    questions.map((q) => [q.question, [...(picked[q.question] ?? []), ...(other[q.question]?.trim() ? [other[q.question].trim()] : [])].join(", ")]),
  );
  const complete = questions.every((q) => answers[q.question]);
  return (
    <div className={card}>
      {questions.map((q) => (
        <div key={q.question} className="flex flex-col gap-1.5">
          {q.header && <div className={SECTION_LABEL}>{q.header.toUpperCase()}</div>}
          <div>{q.question}</div>
          <div className="flex flex-wrap gap-1.5">
            {(q.options ?? []).map((o) => {
              const on = picked[q.question]?.includes(o.label);
              return (
                <button
                  key={o.label}
                  type="button"
                  title={o.description}
                  aria-pressed={on}
                  className={`rounded-md border px-2.5 py-1 text-[12px] ${on ? "border-copper bg-copper/15 text-ink" : "border-line text-ink-soft hover:text-ink"}`}
                  onClick={() => toggle(q, o.label)}
                >
                  {o.label}
                </button>
              );
            })}
            <input
              className="min-w-40 flex-1 rounded-md border border-line bg-transparent px-2 py-1 text-[12px] outline-none focus:border-copper/60"
              placeholder="Other…"
              value={other[q.question] ?? ""}
              onChange={(e) => setOther((o) => ({ ...o, [q.question]: e.target.value }))}
            />
          </div>
        </div>
      ))}
      <div className="flex gap-2">
        <button
          type="button"
          className={`${btn} border-copper/60 bg-copper/10 text-ink`}
          disabled={disabled || !complete}
          onClick={() => void send("answer", { requestId: x.requestId, decision: "answer", answers })}
        >
          Answer
        </button>
        <button type="button" className={btn} disabled={disabled} onClick={() => void send("answer", { requestId: x.requestId, decision: "deny" })}>
          Skip
        </button>
      </div>
    </div>
  );
}
