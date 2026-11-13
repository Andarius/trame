import { type ReactNode, useEffect, useRef, useState } from "react";
import { applySuggestion, parseQuery, QUERY_SYNTAX, type QueryValue, type Suggestion, suggestQuery } from "../query";
import { SessionSort, type Sort, SORT_FIELDS } from "./SessionSort";
import { clientColor, EntityIcon, IconButton, pageGlyph, Popover, StatusDot, TagChips } from "../ui/ui";

function SortMenu({ sort, onChange }: { sort: Sort[]; onChange: (sort: Sort[]) => void }) {
  const [open, setOpen] = useState(false);
  const [first] = sort;
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-[5px] text-[11.5px] text-ink-muted hover:text-ink-soft"
      >
        Sort: {first ? `${SORT_FIELDS[first.key]} ${first.dir === 1 ? "↑" : "↓"}` : "none"}
        {sort.length > 1 && <span className="text-ink-muted/60">+{sort.length - 1}</span>}
        <span className="text-[8px]">▾</span>
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)} className="w-max max-w-[440px] p-2.5" style={{ left: "auto", right: 0 }}>
          <SessionSort sort={sort} onChange={onChange} />
        </Popover>
      )}
    </div>
  );
}

// the gh-style query box; "/" focuses it
export function QueryBox(
  {
    query, onQuery, onClear, values = {},
  }: {
    query: string;
    onQuery: (q: string) => void;
    onClear: () => void;
    /** values proposed after `key:` (queryValues) */
    values?: Record<string, QueryValue[]>;
  },
) {
  const input = useRef<HTMLInputElement>(null);
  // completion: caret position, highlighted row, and whether Escape closed the list for this edit
  const [caret, setCaret] = useState<number | null>(null);
  const [at, setAt] = useState(0);
  const [closed, setClosed] = useState(false);
  const suggestions = caret === null || closed ? [] : suggestQuery(query, caret, values);
  const syncCaret = () => {
    const el = input.current;
    setCaret(el && el === document.activeElement ? el.selectionStart : null);
  };
  const accept = (i: number) => {
    const next = applySuggestion(query, suggestions[i]);
    onQuery(next.query);
    setCaret(next.cursor);
    setAt(0);
    requestAnimationFrame(() => input.current?.setSelectionRange(next.cursor, next.cursor));
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key !== "/" || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      e.preventDefault();
      input.current?.focus();
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, []);
  const { errors } = parseQuery(query);
  const active = query.trim();
  return (
    <div
      onClick={() => input.current?.focus()}
      className={`relative flex min-w-[240px] flex-1 cursor-text items-center gap-1.5 rounded-md border px-2 py-[3px] focus-within:bg-panel ${
        errors.length ? "border-blocked/60" : active ? "border-copper/40 bg-panel/40" : "border-line bg-panel/40 focus-within:border-chipline"
      }`}
    >
      <svg width="15" height="15" viewBox="0 0 16 16" className="shrink-0 text-ink-muted" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <input
        ref={input}
        value={query}
        aria-label="Session query"
        placeholder="status:blocked tag:p1 assigner:carlo -has:specs touched:>7d …"
        title={errors.length ? errors.join("\n") : QUERY_SYNTAX}
        spellCheck={false}
        className="min-w-[120px] flex-1 bg-transparent py-0.5 font-mono text-[11.5px] text-ink outline-none placeholder:text-ink-muted/40"
        onChange={(e) => {
          onQuery(e.target.value);
          setCaret(e.target.selectionStart);
          setClosed(false);
          setAt(0);
        }}
        onSelect={syncCaret}
        onFocus={syncCaret}
        onBlur={() => setCaret(null)}
        onKeyDown={(e) => {
          if (suggestions.length) {
            const move = { ArrowDown: 1, ArrowUp: -1 }[e.key];
            if (move) {
              e.preventDefault();
              setAt((at + move + suggestions.length) % suggestions.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              accept(Math.min(at, suggestions.length - 1));
              return;
            }
            if (e.key === "Escape") {
              setClosed(true);
              return;
            }
          }
          if (e.key === "Escape") e.currentTarget.blur();
        }}
      />
      {active
        ? (
          <IconButton tone="close" title="Clear all filters"
            onClick={onClear}
            className="shrink-0 px-0.5 text-[13px]"
          >
            ✕
          </IconButton>
        )
        : <span className="shrink-0 rounded border border-b-2 border-chipline px-1 font-mono text-[10px] text-ink-muted">/</span>}
      {suggestions.length > 0 && (
        <div role="listbox" aria-label="Query suggestions"
          className="absolute left-0 top-full z-40 mt-1 min-w-[220px] max-w-[360px] rounded-lg border border-chipline bg-panel-modal p-1.5 shadow-2xl shadow-black/60">
          {suggestions.map((sg, i) => (
            <div key={sg.label} role="option" aria-selected={i === at}
              onMouseDown={(e) => {
                e.preventDefault(); // keep focus in the input
                accept(i);
              }}
              onMouseEnter={() => setAt(i)}
              className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs ${i === at ? "bg-panel" : ""}`}
            >
              <Lead sg={sg} />
              {sg.key === "tag" ? <TagChips keys={[sg.label]} /> : <span className="truncate font-mono text-ink">{sg.label}</span>}
              {sg.hint && sg.hint.toLowerCase() !== sg.label.toLowerCase() && (
                <span className="ml-auto shrink-0 truncate text-[10.5px] text-ink-muted">{sg.hint}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// a person's picture, else their initials
function Face({ name, avatar }: { name: string; avatar: string | null }) {
  return avatar
    ? <img src={avatar} alt="" className="size-4 shrink-0 rounded-full object-cover" />
    : (
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-chipline text-[8px] font-medium text-ink">
        {name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()}
      </span>
    );
}

// what a value suggestion looks like elsewhere in the app: face, status dot, page icon
function Lead({ sg: { key, value: v } }: { sg: Suggestion }) {
  if (!v) return null;
  if (v.avatar !== undefined) return <Face name={v.value} avatar={v.avatar} />;
  if (key === "status") return <StatusDot status={v.value} />;
  if (key === "project") {
    return (
      <span className="w-4 shrink-0 text-center text-[11px]" style={{ color: clientColor(v.value, v.color) }}>
        <EntityIcon icon={v.icon} fallback={pageGlyph("project")} size={14} />
      </span>
    );
  }
  if (key === "story") {
    return (
      <span className="w-4 shrink-0 text-center text-[11px] text-ink-muted">
        <EntityIcon icon={v.icon} fallback={pageGlyph("story")} size={14} />
      </span>
    );
  }
  return null;
}

export function SessionBar(
  props: {
    query: string;
    onQuery: (q: string) => void;
    onClear: () => void;
    sort: Sort[];
    onSort: (sort: Sort[]) => void;
    values?: Record<string, QueryValue[]>;
    children?: ReactNode;
  },
) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <QueryBox {...props} />
      {props.children}
      <SortMenu sort={props.sort} onChange={props.onSort} />
    </div>
  );
}
