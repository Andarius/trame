import { memo, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "../md/md";
import { Popover, SECTION_LABEL } from "../ui/ui";
import { finalReply, type Keyed, type Tool, toolArg, toolDiffs, toTurns } from "./agent-history";
import {
  type Interaction,
  modelOf,
  MODES,
  modeOf,
  type Reply,
  restartRun,
  runToTerminal,
  type RunState,
  type RunStatus,
  useAgentRun,
} from "./agent-run";
import { Diffs, HistoryRail, resultsOf, ToolInput, TurnView } from "./AgentHistory";
import { AgentIcon } from "./agents";

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
  const { state, writer, send: sendCommand } = run;
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

  useEffect(() => {
    if (run.gone) onClosed();
  }, [run.gone, onClosed]);
  // the composer keeps stable callbacks, so streaming renders never reach it
  const latest = useRef({
    interrupt: () => {},
    cycleMode: () => {},
    prompt: (_text: string): Promise<Reply> => Promise.resolve({ accepted: false }),
  });
  const interrupt = useCallback(() => latest.current.interrupt(), []);
  const cycleMode = useCallback(() => latest.current.cycleMode(), []);
  const prompt = useCallback((text: string) => latest.current.prompt(text), []);
  // a message written to a stopped run resumes it, then goes out once it is ready
  const queued = useRef<string | null>(null);
  const status = state?.status;
  useEffect(() => {
    if (status !== "ready" || !writer || !queued.current) return;
    const text = queued.current;
    queued.current = null;
    void sendCommand("prompt", { text }).then((r) => setNotice(r.accepted ? null : r.reason ?? "refused"));
  }, [status, writer, sendCommand]);
  const tell = (r: Reply) => setNotice(r.accepted ? null : r.reason ?? "refused");
  const send = async (kind: string, payload?: Record<string, unknown>) => {
    const r = await sendCommand(kind, payload);
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
  const who = state.provider === "codex" ? "Codex" : "Claude";
  const modes = state.capabilities?.modes ?? true;
  const toTerminal = () => runToTerminal(runId).then((r) => onTerminal(r.term), (e: Error) => setNotice(e.message));
  const resume = () => restartRun(runId).catch((e: Error) => setNotice(e.message));
  const bar = (
    <RunBar
      state={state}
      folder={folder}
      writer={writer}
      connected={run.connected}
      send={send}
      actions={[
        ...(ended ? [{ key: "resume", label: "Resume", hint: "start the agent again on this conversation", run: resume }] : []),
        ...(!busy && state.interactions.length === 0
          ? [{ key: "terminal", label: "Continue in terminal", hint: "stop this run and resume it in a Trame shell", run: toTerminal }]
          : []),
      ]}
    />
  );
  // Shift+Tab steps through the modes, as in the CLI
  latest.current = {
    prompt: async (text) => {
      if (!ended) return send("prompt", { text });
      queued.current = text;
      try {
        await restartRun(runId);
        return { accepted: true };
      } catch (e) {
        queued.current = null;
        setNotice(e instanceof Error ? e.message : String(e));
        return { accepted: false };
      }
    },
    interrupt: () => void send("interrupt"),
    cycleMode: () => {
      if (!modes || !writer) return;
      const i = MODES.findIndex((m) => m.mode === modeOf(state.mode)?.mode);
      void send("setMode", { mode: MODES[(i + 1) % MODES.length].mode });
    },
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      {state.status === "failed" && (
        <div className="whitespace-pre-wrap border-b border-blocked/40 bg-blocked/10 px-6 py-2 font-mono text-[11.5px] text-blocked">
          {state.error ?? "the agent stopped unexpectedly"}
        </div>
      )}
      {!writer && run.connected && (
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
              <InteractionCard key={x.requestId} x={x} who={who} provider={state.provider ?? "claude"} disabled={!writer} send={send} />
            ))}
          </div>
          {notice && <div className="px-6 pb-1 text-[11.5px] text-blocked">{notice}</div>}
          <Composer
            bar={bar}
            who={who}
            ready={writer && (state.status === "ready" || ended)}
            stopped={ended}
            busy={busy}
            onSend={prompt}
            onInterrupt={interrupt}
            onCycleMode={cycleMode}
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
        />
      </div>
    </div>
  );
}

// The textarea keeps its own state so streaming renders never touch what is being typed.
const Composer = memo(function Composer(
  { bar, who, ready, stopped, busy, onSend, onInterrupt, onCycleMode }: {
    bar: ReactNode;
    stopped: boolean;
    onCycleMode: () => void;
    who: string;
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
    <div className="px-4 pb-3 pt-2">
      <div className="flex items-center gap-2 rounded-xl border border-chipline bg-panel py-1.5 pl-3 pr-1.5 font-mono text-[12px] focus-within:border-copper/60">
        <textarea
          ref={box}
          rows={Math.min(8, Math.max(1, text.split("\n").length))}
          className="min-w-0 flex-1 resize-none bg-transparent py-1 text-ink outline-none placeholder:text-ink-faint"
          placeholder={stopped
            ? `Stopped · write to resume ${who}`
            : ready
            ? `Message ${who}…`
            : busy
            ? `${who} is working · Esc to stop`
            : "waiting for the agent"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape" && busy) {
              e.preventDefault();
              onInterrupt();
            } else if (e.key === "Tab" && e.shiftKey) {
              e.preventDefault();
              onCycleMode();
            }
          }}
        />
        {/* send while ready, stop while it works, as other agent apps do */}
        {busy
          ? (
            <button
              type="button"
              title="stop this turn (Esc)"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-ink-soft hover:bg-hover hover:text-blocked"
              onClick={onInterrupt}
            >
              <span className="h-2.5 w-2.5 rounded-[2px] bg-current" />
            </button>
          )
          : (
            <button
              type="button"
              title="send (Enter · Shift+Enter for a new line)"
              disabled={!ready || !text.trim()}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[14px] text-ink-soft hover:bg-hover hover:text-ink disabled:opacity-30"
              onClick={() => void submit()}
            >
              ↵
            </button>
          )}
      </div>
      <div className="flex items-center gap-0.5 pl-1 pt-1">{bar}</div>
    </div>
  );
});

type Send = (kind: string, payload?: Record<string, unknown>) => Promise<Reply>;
const card = "my-2 flex flex-col gap-2 rounded-lg border border-copper/50 bg-copper/5 px-4 py-3 font-sans text-[12.5px] text-ink";

// A request the agent is blocked on: a tool to allow, questions to answer or a plan to review.
function InteractionCard(
  { x, who, provider, disabled, send }: { x: Interaction; who: string; provider: string; disabled: boolean; send: Send },
) {
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
      <div className="flex items-center gap-1.5">
        <AgentIcon a={{ harness: provider, icon: null }} />
        {who} wants to use <span className="font-mono font-bold">{x.tool}</span>
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

type Choice = { key: string; label: string; hint?: string | null; badge?: string; on: boolean };

// Mode, model and effort under the composer, each a menu like Claude Code's own: number keys pick
type Action = { key: string; label: string; hint: string; run: () => void };

function RunBar(
  { state, folder, writer, connected, send, actions }: {
    state: RunState;
    folder: string;
    writer: boolean;
    connected: boolean;
    send: Send;
    actions: Action[];
  },
) {
  const [open, setOpen] = useState<"mode" | "model" | "effort" | "more" | null>(null);
  const ended = state.status === "stopped" || state.status === "failed" || state.status === "starting";
  const model = modelOf(state);
  const models = state.models ?? [];
  const efforts = model?.efforts ?? [...new Set(models.flatMap((m) => m.efforts ?? []))];
  const restarts = !!state.capabilities?.effortRestarts;
  const mode = modeOf(state.mode);
  const menus: Record<"mode" | "model" | "effort" | "more", { kind: string; field: string; title: string; items: Choice[]; footer?: string }> = {
    mode: {
      kind: "setMode",
      field: "mode",
      title: "Mode",
      items: MODES.map((m) => ({ key: m.mode, label: m.label, hint: m.hint, on: m.mode === mode?.mode })),
      footer: "Bypassing permissions stays in the terminal",
    },
    model: {
      kind: "setModel",
      field: "model",
      title: "Model",
      items: models.map((m) => ({ key: m.value, label: m.label, hint: m.description, on: m === model })),
    },
    effort: {
      kind: "setEffort",
      field: "effort",
      title: "Effort",
      items: efforts.map((e) => ({ key: e, label: e[0].toUpperCase() + e.slice(1), on: e === state.effort })),
      footer: restarts ? "Claude takes a new effort by resuming the conversation" : "Applies from the next turn",
    },
    more: {
      kind: "",
      field: "",
      title: "Run",
      items: actions.map((a) => ({ key: a.key, label: a.label, hint: a.hint, on: false })),
    },
  };
  const pick = (which: keyof typeof menus, key: string) => {
    setOpen(null);
    if (which === "more") return actions.find((a) => a.key === key)?.run();
    void send(menus[which].kind, { [menus[which].field]: key });
  };
  useEffect(() => {
    if (!open) return;
    const keys = (e: KeyboardEvent) => {
      const n = Number(e.key);
      const item = Number.isInteger(n) ? menus[open].items[n - 1] : undefined;
      if (!item) return;
      e.preventDefault();
      pick(open, item.key);
    };
    addEventListener("keydown", keys);
    return () => removeEventListener("keydown", keys);
  });
  const chip = (which: keyof typeof menus, label: ReactNode, disabled: boolean) => (
    <span className="relative">
      <button
        type="button"
        disabled={disabled}
        className={`rounded-md px-1.5 py-0.5 text-[12px] hover:bg-hover hover:text-ink disabled:opacity-50 ${
          which === "effort" ? "text-ink-faint" : "text-ink-soft"
        }`}
        onClick={() => setOpen(open === which ? null : which)}
      >
        {label}
      </button>
      {open === which && <Menu {...menus[which]} onPick={(k) => pick(which, k)} onClose={() => setOpen(null)} />}
    </span>
  );
  const status = STATUS[state.status];
  return (
    <>
      <span className="flex min-w-0 items-center gap-1.5 text-[12px]" title={state.cwd}>
        <AgentIcon a={{ harness: state.provider ?? "claude", icon: null }} />
        <span className="truncate text-ink-soft">{folder}</span>
        {state.status !== "ready" && <span className={status.tone}>· {status.label}</span>}
        {!connected && <span className="text-wait">· reconnecting…</span>}
      </span>
      <span className="ml-auto" />
      {models.length > 0 && chip("model", model?.label ?? state.model ?? "Model", !writer || ended)}
      {efforts.length > 0 &&
        chip("effort", state.effort ? state.effort[0].toUpperCase() + state.effort.slice(1) : "Default effort", !writer || state.status !== "ready")}
      {(state.capabilities?.modes ?? true) && chip("mode", mode?.label ?? state.mode ?? "Mode", !writer || ended)}
      {actions.length > 0 && chip("more", "⋯", !writer)}
    </>
  );
}

function Menu(
  { title, items, footer, onPick, onClose }: {
    title: string;
    items: Choice[];
    footer?: string;
    onPick: (key: string) => void;
    onClose: () => void;
  },
) {
  return (
    <Popover portal onClose={onClose} className="w-72">
      <div className="px-2 pb-1 pt-0.5 text-[11px] text-ink-faint">{title}</div>
      {items.map((it, i) => (
        <button
          key={it.key}
          type="button"
          className="flex w-full items-start gap-3 rounded-md px-2 py-1.5 text-left hover:bg-active-row"
          onClick={() => onPick(it.key)}
        >
          <span className="min-w-0 flex-1">
            <span className="block text-[12.5px] text-ink">{it.label}</span>
            {it.hint && <span className="block text-[11.5px] leading-snug text-ink-muted">{it.hint}</span>}
          </span>
          <span className="w-4 pt-0.5 text-center text-copper">{it.on ? "✓" : ""}</span>
          {i < 9 && <span className="w-3 pt-0.5 text-right text-[11px] text-ink-faint">{i + 1}</span>}
        </button>
      ))}
      {footer && <div className="mt-1 border-t border-line px-2 pt-1.5 text-[11px] text-ink-faint">{footer}</div>}
    </Popover>
  );
}
