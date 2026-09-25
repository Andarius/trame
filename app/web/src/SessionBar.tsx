import { type ReactNode, useEffect, useRef, useState } from "react";
import type { BoardData } from "./api";
import { parseQuery, QUERY_SYNTAX } from "./query";
import { SessionSort, type Sort, SORT_FIELDS } from "./SessionSort";
import { EntityIcon, pageGlyph, Popover, TagChips } from "./ui";

type Pages = BoardData["pages"];

const PRESETS = [
  ["Blocked", "status:blocked"],
  ["Touched this week", "touched:>7d"],
  ["Has a PR", "has:pr"],
  ["No next step", "no:next"],
] as const;

// add the term, or drop it when already present
const toggleTerm = (q: string, term: string) => {
  const parts = q.split(/\s+/).filter(Boolean);
  return (parts.includes(term) ? parts.filter((p) => p !== term) : [...parts, term]).join(" ");
};

function Check({ on }: { on: boolean }) {
  return (
    <span
      className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[9px] ${
        on ? "border-copper bg-copper text-copper-ink" : "border-chipline"
      }`}
    >
      {on ? "✓" : ""}
    </span>
  );
}

const menuRow = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-ink-soft hover:bg-panel";
const menuHead = "px-2 pb-1 pt-1.5 text-[9.5px] font-medium tracking-[0.8px] text-ink-muted/70";

// autocomplete over stories/projects (empty query: projects then stories)
function StoryPicker({ pages, filter, onToggle }: { pages: Pages; filter: string[]; onToggle: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const ql = q.trim().toLowerCase();
  const hits = (ql
    ? pages.filter((p) => p.title && !filter.includes(p.id) && p.title.toLowerCase().includes(ql))
    : pages
      .filter((p) => p.title && !filter.includes(p.id) && p.kind !== "page")
      .sort((a, b) => a.kind === b.kind ? a.title.localeCompare(b.title) : a.kind === "project" ? -1 : 1))
    .slice(0, 8);
  const pick = (id: string) => {
    onToggle(id);
    setQ("");
    setSel(0);
  };
  return (
    <>
      <input
        value={q}
        placeholder="＋ filter…"
        className="mx-1 mb-1 w-[calc(100%-8px)] rounded-md border border-chipline bg-panel px-2 py-1 text-[11.5px] text-ink outline-none placeholder:text-ink-muted/60"
        onChange={(e) => {
          setQ(e.target.value);
          setSel(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSel((s) => Math.min(s + 1, hits.length - 1));
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setSel((s) => Math.max(s - 1, 0));
          }
          if (e.key === "Enter" && hits[sel]) {
            e.preventDefault();
            pick(hits[sel].id);
          }
        }}
      />
      {hits.map((p, i) => (
        <button
          key={p.id}
          type="button"
          onClick={() => pick(p.id)}
          className={`${menuRow} ${i === sel ? "bg-panel text-ink" : ""}`}
        >
          <EntityIcon icon={p.icon} fallback={pageGlyph(p.kind)} className="shrink-0 text-[10px]" />
          <span className="truncate">{p.title}</span>
        </button>
      ))}
    </>
  );
}

function FilterMenu(
  { pages, filter, onToggle, noSpecs, onNoSpecs, query, onQuery }: {
    pages: Pages;
    filter: string[];
    onToggle: (id: string) => void;
    noSpecs: boolean;
    onNoSpecs: () => void;
    query: string;
    onQuery: (q: string) => void;
  },
) {
  const [open, setOpen] = useState(false);
  const terms = query.split(/\s+/);
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-[5px] text-[11.5px] text-ink-muted hover:text-ink-soft"
      >
        Filters <span className="text-[8px]">▾</span>
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)} className="w-[260px]">
          <div className={menuHead}>PRESETS</div>
          <button type="button" onClick={onNoSpecs} className={menuRow}>
            <Check on={noSpecs} /> No specs
          </button>
          {PRESETS.map(([label, term]) => (
            <button key={term} type="button" onClick={() => onQuery(toggleTerm(query, term))} className={menuRow}>
              <Check on={terms.includes(term)} />
              <span className="flex-1">{label}</span>
              <span className="font-mono text-[10.5px] text-ink-muted/60">{term}</span>
            </button>
          ))}
          <div className={menuHead}>STORY / PROJECT</div>
          <StoryPicker pages={pages} filter={filter} onToggle={onToggle} />
        </Popover>
      )}
    </div>
  );
}

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

// active story/tag chips and the gh-style query share one field; "/" focuses it
function QueryBox(
  { pages, filter, onToggle, noSpecs, onNoSpecs, query, onQuery, onClear }: {
    pages: Pages;
    filter: string[];
    onToggle: (id: string) => void;
    noSpecs: boolean;
    onNoSpecs: () => void;
    query: string;
    onQuery: (q: string) => void;
    onClear: () => void;
  },
) {
  const input = useRef<HTMLInputElement>(null);
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
  const active = query.trim() || filter.length || noSpecs;
  const chip = "flex max-w-[220px] shrink-0 items-center gap-1.5 rounded-[5px] border border-copper/40 bg-copper/5 px-1.5 py-px text-[11px] text-copper hover:bg-copper/10";
  return (
    <div
      onClick={() => input.current?.focus()}
      className={`flex min-w-[240px] flex-1 cursor-text items-center gap-1.5 rounded-md border px-2 py-[3px] focus-within:bg-panel ${
        errors.length ? "border-blocked/60" : active ? "border-copper/40 bg-panel/40" : "border-line bg-panel/40 focus-within:border-chipline"
      }`}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" className="shrink-0 text-ink-muted" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      {filter.map((id) => {
        const fp = pages.find((p) => p.id === id);
        return (
          <button key={id} type="button" title="Remove filter" onClick={() => onToggle(id)} className={chip}>
            {id.startsWith("tag:") ? <TagChips keys={[id.slice(4)]} /> : (
              <>
                <EntityIcon icon={fp?.icon} fallback={pageGlyph(fp?.kind ?? "story")} className="shrink-0 text-[9px]" />
                <span className="truncate">{fp?.title ?? "story"}</span>
              </>
            )}
            <span className="shrink-0 text-[10px]">✕</span>
          </button>
        );
      })}
      {noSpecs && (
        <button type="button" title="Only sessions without a specs page" onClick={onNoSpecs} className={chip}>
          no specs <span className="text-[10px]">✕</span>
        </button>
      )}
      <input
        ref={input}
        value={query}
        aria-label="Session query"
        placeholder={filter.length || noSpecs ? "" : "status:blocked tag:p1 -has:specs touched:>7d …"}
        title={errors.length ? errors.join("\n") : QUERY_SYNTAX}
        spellCheck={false}
        className="min-w-[120px] flex-1 bg-transparent py-0.5 font-mono text-[11.5px] text-ink outline-none placeholder:text-ink-muted/40"
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") e.currentTarget.blur();
          if (e.key === "Backspace" && !query && filter.length) onToggle(filter[filter.length - 1]);
        }}
      />
      {active
        ? (
          <button
            type="button"
            title="Clear all filters"
            onClick={onClear}
            className="shrink-0 px-0.5 text-[11px] text-ink-muted hover:text-ink"
          >
            ✕
          </button>
        )
        : <span className="shrink-0 rounded border border-b-2 border-chipline px-1 font-mono text-[10px] text-ink-muted">/</span>}
    </div>
  );
}

export function SessionBar(
  props: {
    pages: Pages;
    filter: string[];
    onToggle: (id: string) => void;
    noSpecs: boolean;
    onNoSpecs: () => void;
    query: string;
    onQuery: (q: string) => void;
    onClear: () => void;
    sort: Sort[];
    onSort: (sort: Sort[]) => void;
    children?: ReactNode;
  },
) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterMenu {...props} />
      <QueryBox {...props} />
      {props.children}
      <SortMenu sort={props.sort} onChange={props.onSort} />
    </div>
  );
}
