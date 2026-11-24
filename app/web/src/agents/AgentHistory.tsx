import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type HistoryItem, type HistoryPage, transcriptHistory } from "../api";
import { Markdown } from "../md/md";

type Tool = Extract<HistoryItem, { kind: "tool" }>;
type Result = Extract<HistoryItem, { kind: "result" }>;
type Keyed = { key: number; item: HistoryItem };

const FOLLOW_MS = 2500;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const base = (p: string) => p.split("/").pop() ?? p;

// the call as Claude Code prints it: `Bash(cargo test)`, `Edit(pty.rs)`
export const toolLabel = ({ name, input }: Tool) => {
  const cmd = input.command;
  const arg = str(cmd) ?? (Array.isArray(cmd) ? cmd.join(" ") : undefined) ?? str(input.cmd) ??
    (str(input.file_path) && base(str(input.file_path)!)) ?? str(input.pattern) ?? str(input.description) ??
    str(input.url) ?? str(input.query) ?? str(input.skill);
  const line = arg?.split("\n")[0].trim();
  return line ? `${name}(${line.length > 80 ? `${line.slice(0, 80)}…` : line})` : name;
};

// A session's full conversation from its transcript, following new lines while it runs
export function AgentHistory({ source, id, className }: { source: string; id: string; className?: string }) {
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
    let live = true;
    setItems([]);
    setRange(null);
    setError(null);
    pinned.current = true;
    transcriptHistory(source, id).then(
      (p) => {
        if (!live) return;
        keys.current = { low: 0, high: p.items.length };
        setItems(p.items.map((item, key) => ({ key, item })));
        setRange({ start: p.start, end: p.end, more: p.more });
      },
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
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

  const results = useMemo(() => {
    const out = new Map<string, Result>();
    for (const { item } of items) if (item.kind === "result") out.set(item.toolId, item);
    return out;
  }, [items]);

  if (error) return <p className="text-[12.5px] text-ink-muted">{error}</p>;
  if (!range) return <p className="text-[12.5px] text-ink-faint">reading the transcript…</p>;
  return (
    <div
      ref={scroller}
      className={`flex flex-col gap-2.5 overflow-y-auto rounded-lg border border-line px-4 py-3 ${className ?? ""}`}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {range.more && (
        <button
          type="button"
          className="self-center text-[11.5px] text-ink-muted hover:text-ink"
          disabled={loading}
          onClick={() => void earlier()}
        >
          {loading ? "loading…" : "↑ earlier messages"}
        </button>
      )}
      {!items.length && <p className="text-[12.5px] text-ink-faint">Nothing said yet.</p>}
      {items.map(({ key, item }) => (
        <Row key={key} item={item} result={item.kind === "tool" ? results.get(item.id) : undefined} />
      ))}
    </div>
  );
}

function Row({ item, result }: { item: HistoryItem; result?: Result }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="whitespace-pre-wrap rounded-md border border-line-soft bg-card/60 px-3 py-2 text-[12.5px] text-ink">
          <span className="mr-1.5 text-copper">›</span>
          {item.text}
          {item.truncated && <span className="text-ink-faint"> …</span>}
        </div>
      );
    case "assistant":
      return <Markdown className="text-[12.5px] text-ink-soft" text={item.truncated ? `${item.text} …` : item.text} />;
    case "thinking":
      return (
        <details className="text-[11.5px] text-ink-faint">
          <summary className="cursor-pointer select-none">✻ thinking</summary>
          <p className="mt-1 whitespace-pre-wrap pl-4">{item.text}</p>
        </details>
      );
    case "note":
      return <div className="text-[11px] text-ink-faint">· {item.text}</div>;
    case "tool":
      return <ToolRow tool={item} result={result} />;
    case "result":
      return null; // shown under its call
  }
}

function ToolRow({ tool, result }: { tool: Tool; result?: Result }) {
  // a call without a result yet was proposed or is running, not done
  const state = !result ? "…" : result.error ? "✕" : "●";
  const tone = !result ? "text-ink-faint" : result.error ? "text-blocked" : "text-active";
  return (
    <details className="group text-[12px]">
      <summary className="flex cursor-pointer select-none items-baseline gap-2 font-mono text-[11.5px] text-ink-soft">
        <span className={tone} title={!result ? "no result yet" : result.error ? "failed" : "done"}>{state}</span>
        <span className="truncate">{toolLabel(tool)}</span>
      </summary>
      <div className="mt-1.5 flex flex-col gap-1.5 border-l border-line pl-3">
        <ToolInput tool={tool} />
        {result && (
          <pre className={`max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] ${result.error ? "text-blocked" : "text-ink-muted"}`}>
            {result.text || "(no output)"}
            {result.truncated && "\n… output cut"}
          </pre>
        )}
      </div>
    </details>
  );
}

function ToolInput({ tool }: { tool: Tool }) {
  const { input } = tool;
  const oldS = str(input.old_string);
  const newS = str(input.new_string);
  if (oldS !== undefined && newS !== undefined) {
    return (
      <pre className="max-h-64 overflow-auto font-mono text-[11px]">
        {oldS.split("\n").map((l, i) => <div key={`o${i}`} className="text-blocked">- {l}</div>)}
        {newS.split("\n").map((l, i) => <div key={`n${i}`} className="text-active">+ {l}</div>)}
      </pre>
    );
  }
  const body = str(input.command) ?? str(input.content) ?? str(input.input) ?? JSON.stringify(input, null, 2);
  return <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-ink-muted">{body}</pre>;
}
