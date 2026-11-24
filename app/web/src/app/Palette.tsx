import { useEffect, useMemo, useRef, useState } from "react";
import { AgentIcon } from "../agents/agents";
import { search, type SearchHit } from "../api";
import { revealTerminal, sessionLabel, useTermDock, useTermSessions } from "../term/term-api";
import { clientColor, EntityIcon, pageGlyph, STATUS, timeAgo } from "../ui/ui";

type TermHit = { id: string; title: string; sub: string; agent: string | null };
// open shells whose name, agent session or folder contains every word of `q`
const matchTerms = (all: TermHit[], q: string) => {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return all.filter((t) => words.every((w) => `${t.title} ${t.sub}`.toLowerCase().includes(w)));
};
const home = (cwd: string) => cwd.replace(/^\/(home|Users)\/[^/]+/, "~");

// Quick-find (Ctrl+P), Notion-style: one input, one recency-ranked list across
// sessions, projects, pages/stories, and databases. Empty query = recently touched.
// Open terminals match by name first; `terminals` (Ctrl+Shift+P from a shell) lists only them.
export function Palette(
  { onClose, onPick, terminals = false }: {
    onClose: () => void;
    onPick: (hit: SearchHit) => void;
    terminals?: boolean;
  },
) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<SearchHit[]>([]);
  const { terms } = useTermDock();
  const sessions = useTermSessions();
  const allTerms = useMemo(() =>
    Object.values(terms).filter((t) => !t.exited).map((t): TermHit => {
      const s = sessions.find((x) => x.term === t.id);
      const label = s ? sessionLabel(s) : t.title;
      // a shell's default title is its folder's name, already in the path
      const extra = label !== t.title && t.title !== t.cwd.split("/").at(-1);
      return { id: t.id, title: label, sub: extra ? `${t.title} · ${home(t.cwd)}` : home(t.cwd), agent: s?.agent ?? null };
    }), [terms, sessions]);
  const termHits = terminals || q.trim() ? matchTerms(allTerms, q) : [];
  const hits: (SearchHit | (TermHit & { kind: "term" }))[] = [
    ...termHits.map((t) => ({ ...t, kind: "term" as const })),
    ...(terminals ? [] : found),
  ];
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  useEffect(() => inputRef.current?.focus(), []);

  // debounced fetch; seq guards against out-of-order responses
  useEffect(() => {
    const id = ++seq.current;
    const t = setTimeout(() => {
      search(q).then((r) => {
        if (seq.current === id && Array.isArray(r)) setFound(r);
      }).catch(() => {});
    }, q ? 120 : 0);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => setSel(0), [q]);
  const pick = (h: (typeof hits)[number]) => {
    if (h.kind !== "term") return onPick(h);
    onClose();
    void revealTerminal(h.id);
  };

  const move = (dir: -1 | 1) =>
    setSel((s) => {
      const n = hits.length ? (s + dir + hits.length) % hits.length : 0;
      listRef.current?.children[n]?.scrollIntoView({ block: "nearest" });
      return n;
    });

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter" && hits[sel]) pick(hits[sel]);
  };

  const glyph = (h: (typeof hits)[number]) => {
    if (h.kind === "term") {
      return (
        <span className="flex w-4 shrink-0 justify-center text-[12px] text-ink-muted">
          {h.agent ? <AgentIcon a={{ harness: h.agent, icon: null }} /> : "›_"}
        </span>
      );
    }
    if (h.kind === "session") {
      return (
        <span
          className="h-[7px] w-[7px] shrink-0 rounded-full"
          style={{ background: STATUS[h.meta as keyof typeof STATUS]?.color ?? "#666" }}
        />
      );
    }
    if (h.kind === "client") {
      return (
        <span
          className="h-[7px] w-[7px] shrink-0 rounded-full"
          style={{ background: clientColor(h.title, h.color || null) }}
        />
      );
    }
    return (
      <span className="w-4 shrink-0 text-center text-[12px] leading-none">
        <EntityIcon
          icon={h.icon || null}
          fallback={h.kind === "database" ? "▦" : pageGlyph(h.meta === "story" ? "story" : "page", h.mark_role)}
        />
      </span>
    );
  };

  const kindLabel = (h: (typeof hits)[number]) =>
    h.kind === "term" ? "terminal" : h.kind === "session" ? h.meta : h.kind === "client" ? "project" : h.meta;

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/45 pt-[14vh]" onClick={onClose}>
      <div
        className="flex max-h-[56vh] w-[600px] flex-col overflow-hidden rounded-xl border border-overlay-border bg-panel-modal shadow-2xl shadow-black/60"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          placeholder={terminals ? "Jump to a terminal…" : "Search terminals, sessions, pages, projects…"}
          className="border-b border-line-soft bg-transparent px-4 py-3 text-[13.5px] text-ink outline-none placeholder:text-ink-muted/60"
        />
        <div ref={listRef} className="flex-1 overflow-y-auto p-1.5">
          {hits.map((h, i) => (
            <button
              key={`${h.kind}:${h.id}`}
              type="button"
              className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left ${
                i === sel ? "bg-panel" : "hover:bg-panel/60"
              }`}
              onMouseMove={() => setSel(i)}
              onClick={() => pick(h)}
            >
              {glyph(h)}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-ink">{h.title || "Untitled"}</span>
                {h.sub && <span className="block truncate text-[11px] text-ink-muted">{h.sub}</span>}
              </span>
              <span className="shrink-0 text-[10.5px] text-ink-muted/80">{kindLabel(h)}</span>
              <span className="w-14 shrink-0 text-right text-[10.5px] text-ink-muted/60">{h.kind === "term" ? "" : timeAgo(h.at)}</span>
            </button>
          ))}
          {!hits.length && (
            <p className="px-3 py-6 text-center text-[12px] text-ink-muted">
              {q ? `No matches for “${q}”` : "No open terminals"}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3 border-t border-line-soft px-4 py-2 text-[10.5px] text-ink-muted/70">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
