import { memo, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type HistoryPage, transcriptHistory } from "../api";
import { BOOL_CODEC, SECTION_LABEL, useLocalStorage } from "../ui/ui";
import {
  type FileDiff,
  fileChanges,
  finalReply,
  type Keyed,
  type Result,
  runSentence,
  type Tool,
  toolArg,
  toolDiffs,
  toolKind,
  toTurns,
  type Turn,
  turnSpan,
} from "./agent-history";

const FOLLOW_MS = 2500;
// markdown emphasis reads as noise in the terminal look; `code` keeps its own tone
const plain = (t: string) =>
  t.replace(/\*\*(.+?)\*\*/g, "$1").split(/`([^`\n]+)`/).map((part, i) =>
    i % 2 ? <span key={i} className="text-copper">{part}</span> : part
  );
const hhmm = (ts?: string) => (ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");

// A session's full conversation from its transcript, as Claude Code prints it, following new lines while it runs.
// Each turn's work folds into one line; edits and the final reply stay in view. `side` heads the right rail.
export function AgentHistory(
  { source, id, live, side, className }: { source: string; id: string; live: boolean; side?: ReactNode; className?: string },
) {
  // each item keeps one key as pages land above and below it
  const [items, setItems] = useState<Keyed[]>([]);
  const keys = useRef({ low: 0, high: 0 });
  const [range, setRange] = useState<{ start: number; end: number; more: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const keepFrom = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    setItems([]);
    setRange(null);
    setError(null);
    pinned.current = true;
    transcriptHistory(source, id).then(
      (p) => {
        if (!alive) return;
        keys.current = { low: 0, high: p.items.length };
        setItems(p.items.map((item, key) => ({ key, item })));
        setRange({ start: p.start, end: p.end, more: p.more });
      },
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [source, id]);

  // follow appended lines; a failed poll just waits for the next one
  const end = useRef<number | null>(null);
  end.current = range?.end ?? null;
  const following = range !== null;
  useEffect(() => {
    if (!following) return;
    let busy = false;
    const timer = setInterval(() => {
      if (busy || end.current === null) return;
      busy = true;
      transcriptHistory(source, id, { after: end.current }).then((p: HistoryPage) => {
        if (p.items.length) {
          const from = keys.current.high;
          keys.current.high += p.items.length;
          setItems((prev) => [...prev, ...p.items.map((item, i) => ({ key: from + i, item }))]);
        }
        setRange((r) => r && { ...r, end: p.end });
      }).catch(() => {}).finally(() => {
        busy = false;
      });
    }, FOLLOW_MS);
    return () => clearInterval(timer);
  }, [source, id, following]);

  const earlier = async () => {
    if (!range?.more || loading) return;
    setLoading(true);
    try {
      const p = await transcriptHistory(source, id, { before: range.start });
      keepFrom.current = scroller.current ? scroller.current.scrollHeight - scroller.current.scrollTop : null;
      const from = keys.current.low - p.items.length;
      keys.current.low = from;
      setItems((prev) => [...p.items.map((item, i) => ({ key: from + i, item })), ...prev]);
      setRange((r) => r && { ...r, start: p.start, more: p.more });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // stay at the bottom while following; keep the reading position when earlier items land above
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (keepFrom.current !== null) {
      el.scrollTop = el.scrollHeight - keepFrom.current;
      keepFrom.current = null;
    } else if (pinned.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const results = useMemo(() => resultsOf(items), [items]);
  const turns = useMemo(() => toTurns(items), [items]);
  const jump = (key: number) => {
    pinned.current = false;
    scroller.current?.querySelector(`[data-turn="${key}"]`)?.scrollIntoView({ block: "start" });
  };

  const rail = <HistoryRail side={side} items={items} turns={turns} more={!!range?.more} onJump={jump} />;

  let body: ReactNode;
  if (error) body = <p className="text-[12.5px] text-ink-muted">{error}</p>;
  else if (!range) body = <p className="text-[12.5px] text-ink-faint">reading the transcript…</p>;
  else {
    body = (
      <>
        {range.more && (
          <button
            type="button"
            className="mb-2 self-center text-ink-faint hover:text-ink"
            disabled={loading}
            onClick={() => void earlier()}
          >
            {loading ? "loading…" : "↑ earlier messages"}
          </button>
        )}
        {!items.length && <p className="text-ink-faint">Nothing said yet.</p>}
        {turns.map((t, i) => (
          <TurnView key={t.key} turn={t} results={results} working={live && i === turns.length - 1 && !finalReply(t)} />
        ))}
      </>
    );
  }
  return (
    <div className={`flex min-h-0 ${className ?? ""}`}>
      <div
        ref={scroller}
        className="flex min-w-0 flex-1 flex-col overflow-y-auto px-6 py-4 font-mono text-[12px] leading-[1.55] text-ink-soft"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {body}
      </div>
      {rail}
    </div>
  );
}

type TurnProps = { turn: Turn; results: Map<string, Result>; working: boolean };

// A turn re-renders only when its own items or the results of its calls change: streaming
// elsewhere in the conversation, or a new turn below it, leaves it alone
const sameTurn = (a: TurnProps, b: TurnProps) =>
  a.working === b.working && a.turn.key === b.turn.key && a.turn.prompt?.item === b.turn.prompt?.item &&
  a.turn.body.length === b.turn.body.length && a.turn.body.every((k, i) => k.item === b.turn.body[i].item) &&
  a.turn.body.every(({ item }) => item.kind !== "tool" || a.results.get(item.id) === b.results.get(item.id));

export const TurnView = memo(function TurnView({ turn, results, working }: TurnProps) {
  const reply = finalReply(turn);
  const work = turn.body.filter((k) => k !== reply);
  const tools = work.flatMap((k) => (k.item.kind === "tool" ? [k.item] : []));
  // a turn that only talked has nothing to fold
  const quiet = !tools.length && !work.some((k) => k.item.kind === "thinking");
  const [open, setOpen] = useState(working);
  const failed = tools.filter((t) => results.get(t.id)?.error).length;
  const span = turnSpan(turn, working ? Date.now() : undefined);
  const prompt = turn.prompt?.item;
  return (
    // off-screen turns skip layout and paint: long conversations scroll without laying everything out
    <div data-turn={turn.key} className="flex flex-col gap-1 pb-3 [contain-intrinsic-size:auto_80px] [content-visibility:auto]">
      {prompt?.kind === "user" && (
        <div className="-mx-2 whitespace-pre-wrap rounded bg-card px-2 py-1 text-ink">
          <span className="mr-2 text-copper">&gt;</span>
          {prompt.text}
          {prompt.truncated && <span className="text-ink-faint"> …</span>}
        </div>
      )}
      {quiet ? <Body items={work} results={results} /> : (
        <>
          <button
            type="button"
            className="self-start text-left text-ink-faint hover:text-ink-muted"
            onClick={() => setOpen(!open)}
          >
            <span className={working ? "inline-block animate-spin text-wait" : ""}>✻</span>
            {` ${working ? "Working" : "Worked"}${span ? ` for ${span}` : ""}`}
            {tools.length > 0 && ` · ${runSentence(tools)}`}
            {failed > 0 && <span className="text-blocked">{` · ${failed} failed`}</span>}
            {open ? " ⌄" : " ›"}
          </button>
          {open
            ? (
              <div className="ml-1 flex flex-col gap-1 border-l border-line pl-3">
                <Body items={work} results={results} />
              </div>
            )
            : tools.filter((t) => toolKind(t.name) === "edit").map((t) => (
              <ToolLine key={t.id} tool={t} result={results.get(t.id)} diffOpen />
            ))}
        </>
      )}
      {reply?.item.kind === "assistant" && <Reply text={reply.item.text} truncated={reply.item.truncated} strong />}
    </div>
  );
}, sameTurn);

// a turn's work in order; reads and searches in a row fold into one line
function Body({ items, results }: { items: Keyed[]; results: Map<string, Result> }) {
  const out: ReactNode[] = [];
  let look: Tool[] = [];
  const flush = () => {
    if (look.length === 1) out.push(<ToolLine key={look[0].id} tool={look[0]} result={results.get(look[0].id)} />);
    else if (look.length) {
      const run = look;
      const failed = run.some((t) => results.get(t.id)?.error);
      out.push(
        <details key={run[0].id}>
          <summary className="cursor-pointer list-none">
            <span className={failed ? "text-blocked" : "text-active"}>●</span>
            <span className="text-ink-muted">{` ${runSentence(run).replace(/^./, (c) => c.toUpperCase())}`}</span>
          </summary>
          <div className="ml-[2ch] flex flex-col gap-0.5">
            {run.map((t) => <ToolLine key={t.id} tool={t} result={results.get(t.id)} />)}
          </div>
        </details>,
      );
    }
    look = [];
  };
  for (const { key, item } of items) {
    if (item.kind === "tool" && ["read", "search"].includes(toolKind(item.name))) {
      look.push(item);
      continue;
    }
    if (item.kind === "result") continue; // shown under its call
    flush();
    if (item.kind === "tool") out.push(<ToolLine key={key} tool={item} result={results.get(item.id)} diffOpen />);
    else if (item.kind === "assistant") out.push(<Reply key={key} text={item.text} truncated={item.truncated} />);
    else if (item.kind === "thinking") {
      out.push(
        <details key={key} className="text-ink-faint">
          <summary className="cursor-pointer list-none italic">✻ Thinking…</summary>
          <p className="whitespace-pre-wrap pl-[2ch]">{item.text}</p>
        </details>,
      );
    } else if (item.kind === "note") out.push(<div key={key} className="text-ink-faint">· {item.text}</div>);
  }
  flush();
  return <>{out}</>;
}

export function Reply({ text, truncated, strong }: { text: string; truncated: boolean; strong?: boolean }) {
  return (
    <div className={`whitespace-pre-wrap ${strong ? "text-ink" : ""}`}>
      <span className="text-ink">● </span>
      {plain(text)}
      {truncated && <span className="text-ink-faint"> …</span>}
    </div>
  );
}

// `● Edit(total.ts)` with a one-line gist under it; the whole call opens on click
export function ToolLine({ tool, result, diffOpen }: { tool: Tool; result?: Result; diffOpen?: boolean }) {
  const diffs = toolDiffs(tool);
  const arg = toolArg(tool);
  const tone = !result ? "text-wait" : result.error ? "text-blocked" : "text-active";
  const head = (
    <>
      <span className={tone} title={!result ? "no result yet" : result.error ? "failed" : "done"}>●</span>{" "}
      <span className="font-bold text-ink">{tool.name}</span>
      {arg && `(${arg})`}
    </>
  );
  if (diffOpen && diffs) {
    return (
      <div>
        {head}
        <div className="pl-[2ch]"><Diffs diffs={diffs} /></div>
      </div>
    );
  }
  const add = diffs?.reduce((n, d) => n + d.lines.filter((l) => l.sign === "+").length, 0) ?? 0;
  const del = diffs?.reduce((n, d) => n + d.lines.filter((l) => l.sign === "-").length, 0) ?? 0;
  const last = result?.text.trimEnd().split("\n").pop();
  const gist = diffs ? `+${add} −${del}` : !result ? "…" : last || "(no output)";
  return (
    <details>
      <summary className="cursor-pointer list-none">
        {head}
        <div className={`truncate pl-[2ch] ${result?.error ? "text-blocked" : "text-ink-faint"}`}>⎿ {gist}</div>
      </summary>
      <div className="flex flex-col gap-1 pl-[2ch]">
        {diffs ? <Diffs diffs={diffs} /> : <ToolInput tool={tool} />}
        {result && !diffs && (
          <pre className={`max-h-64 overflow-auto whitespace-pre-wrap text-[11px] ${result.error ? "text-blocked" : "text-ink-muted"}`}>
            {result.text || "(no output)"}
            {result.truncated && "\n… output cut"}
          </pre>
        )}
      </div>
    </details>
  );
}

export function Diffs({ diffs }: { diffs: FileDiff[] }) {
  return (
    <div className="max-h-72 overflow-auto text-[11px]">
      {diffs.map((d, i) => (
        <div key={i}>
          {diffs.length > 1 && <div className="text-ink-faint">{d.file}</div>}
          {d.lines.map((l, j) => (
            <div key={j} className={`whitespace-pre px-1.5 ${l.sign === "+" ? "bg-active/10 text-active" : "bg-blocked/10 text-blocked"}`}>
              {l.sign} {l.text}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function ToolInput({ tool }: { tool: Tool }) {
  const { input } = tool;
  const s = (v: unknown) => (typeof v === "string" ? v : undefined);
  const body = s(input.command) ?? s(input.content) ?? s(input.input) ?? JSON.stringify(input, null, 2);
  return <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-[11px] text-ink-muted">{body}</pre>;
}

export function resultsOf(items: Keyed[]) {
  const out = new Map<string, Result>();
  for (const { item } of items) if (item.kind === "result") out.set(item.toolId, item);
  return out;
}

// the right rail: the caller's own section, files changed and a prompt index to jump between turns
export function HistoryRail(
  { side, items, turns, more, onJump }: { side?: ReactNode; items: Keyed[]; turns: Turn[]; more: boolean; onJump: (key: number) => void },
) {
  const changes = useMemo(() => fileChanges(items), [items]);
  const prompts = turns.filter((t) => t.prompt);
  // hidden to a thin strip, for more room; remembered across views
  const [shown, setShown] = useLocalStorage("trame:historyRail", true, BOOL_CODEC);
  const toggle = (
    <button
      type="button"
      title={shown ? "hide the side panel" : "show the side panel"}
      className="grid h-6 w-6 place-items-center rounded-md text-ink-faint hover:bg-hover hover:text-ink"
      onClick={() => setShown(!shown)}
    >
      {shown ? "»" : "«"}
    </button>
  );
  if (!shown) return <aside className="flex w-9 shrink-0 flex-col items-center border-l border-line py-3">{toggle}</aside>;
  return (
    <aside className="relative flex w-60 shrink-0 flex-col gap-5 overflow-y-auto border-l border-line px-4 py-4 text-[12px]">
      <div className="absolute right-2 top-2.5">{toggle}</div>
      {side}
      {changes.length > 0 && (
      <section className="flex flex-col gap-1.5">
        <div className={SECTION_LABEL}>CHANGES{more ? " · LOADED" : ""}</div>
        {changes.map((c) => (
          <div key={c.file} className="flex gap-2 font-mono text-[11px]" title={c.file}>
            <span className="min-w-0 flex-1 truncate text-ink-soft">{c.file.split("/").pop()}</span>
            <span className="text-active">+{c.add}</span>
            {c.del > 0 && <span className="text-blocked">−{c.del}</span>}
          </div>
        ))}
      </section>
      )}
      <section className="flex flex-col gap-0.5">
        <div className={`${SECTION_LABEL} mb-1`}>PROMPTS</div>
        {more && <p className="px-1.5 text-ink-faint">earlier ones above ↑</p>}
        {prompts.map((t) => (
          <button
            key={t.key}
            type="button"
            className="rounded-md px-1.5 py-1 text-left text-ink-soft hover:bg-hover hover:text-ink"
            onClick={() => onJump(t.key)}
          >
            <span className="mr-1.5 font-mono text-[10.5px] text-ink-faint">{hhmm(t.prompt!.item.ts)}</span>
            <span className="line-clamp-2">{t.prompt!.item.kind === "user" ? t.prompt!.item.text : ""}</span>
          </button>
        ))}
      </section>
    </aside>
  );
}
