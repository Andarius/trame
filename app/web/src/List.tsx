import { useState } from "react";
import type { BoardData } from "./api.ts";
import {
  ClientChip,
  EntityIcon,
  inSubtree,
  pageGlyph,
  pagesById,
  projectOf,
  sessionAnchor,
  shiftRange,
  statusStyle,
  StatusDot,
  storyOf,
  timeAgo,
} from "./ui";

const GRID = "grid grid-cols-[18px_1fr_110px_280px_150px_90px] items-center gap-4";

type SortKey = "title" | "status" | "location" | "branch" | "touched";
const COLS: [SortKey, string][] = [
  ["title", "SESSION"],
  ["status", "STATUS"],
  ["location", "LOCATION"],
  ["branch", "BRANCH"],
  ["touched", "TOUCHED"],
];

export function List(
  { board, onOpen, onOpenFull, storyFilter, onFilterStory, selected, onToggleSelect, onSelectMany }: {
    board: BoardData;
    onOpen: (id: string) => void;
    onOpenFull?: (id: string) => void;
    storyFilter?: string[] | null;
    onFilterStory?: (id: string) => void;
    selected?: Set<string>;
    onToggleSelect?: (id: string) => void;
    onSelectMany?: (ids: string[], on: boolean) => void;
  },
) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "touched", dir: -1 });
  const [anchorId, setAnchorId] = useState<string | null>(null); // last-clicked checkbox, for shift-ranges
  const statusOrder = board.statuses.map((s) => s.key); // synced column order
  const byId = pagesById(board.pages);

  const key = (s: BoardData["sessions"][number]): string | number => {
    switch (sort.key) {
      case "title":
        return s.title.toLowerCase();
      case "status":
        return statusOrder.indexOf(s.status);
      case "location": {
        const project = board.projects.find((c) => c.id === projectOf(s, byId))?.name ?? "";
        const story = storyOf(s, byId)?.title ?? "";
        return `${project} ${story}`.toLowerCase();
      }
      case "branch":
        return (s.branch ?? "").toLowerCase();
      case "touched":
        return s.last_touched;
    }
  };
  const filtered = storyFilter?.length
    ? board.sessions.filter((s) => storyFilter.some((f) => inSubtree(s, f, byId)))
    : board.sessions;
  const sessions = [...filtered].sort((a, b) => {
    const av = key(a), bv = key(b);
    return (av < bv ? -1 : av > bv ? 1 : 0) * sort.dir;
  });
  // clicking the active column flips direction; a fresh column starts asc (touched: newest-first)
  const onSort = (k: SortKey) =>
    setSort((s) => s.key === k ? { key: k, dir: s.dir === 1 ? -1 : 1 } : { key: k, dir: k === "touched" ? -1 : 1 });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-3">
      <div className={`${GRID} px-3 pb-2.5 pt-1 text-[10px] font-medium tracking-[0.7px] text-ink-muted/75`}>
        <input
          type="checkbox"
          title="Select all"
          className="h-3.5 w-3.5 accent-[#c98a63]"
          checked={sessions.length > 0 && sessions.every((s) => selected?.has(s.id))}
          onChange={(e) => onSelectMany?.(sessions.map((s) => s.id), e.target.checked)}
        />
        {COLS.map(([k, label]) => (
          <button type="button"
            key={k}
            onClick={() => onSort(k)}
            className={`flex items-center gap-1 tracking-[0.7px] transition-colors hover:text-ink-soft ${
              sort.key === k ? "text-ink-soft" : ""
            }`}
          >
            {label}
            <span className="text-[7px] leading-none">{sort.key === k ? (sort.dir === 1 ? "▲" : "▼") : ""}</span>
          </button>
        ))}
      </div>
      {sessions.map((s) => {
        const project = board.projects.find((c) => c.id === projectOf(s, byId));
        const story = storyOf(s, byId);
        const anchor = sessionAnchor(s, byId);
        // Location = Project chip › Story (clickable, subtree filter) › dim anchor tail
        const target = story ?? anchor; // what a click filters by
        const tail = anchor && anchor.id !== story?.id ? anchor : null;
        const done = statusStyle(s.status).terminal;
        return (
          <div
            key={s.id}
            onClick={() => onOpen(s.id)}
            onDoubleClick={() => {
              document.getSelection()?.removeAllRanges();
              onOpenFull?.(s.id);
            }}
            className={`${GRID} cursor-pointer border-b border-line-soft px-3 py-2.5 hover:bg-panel/60 ${
              selected?.has(s.id) ? "bg-copper/[0.06]" : ""
            }`}
          >
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-[#c98a63]"
              checked={selected?.has(s.id) ?? false}
              readOnly
              onMouseDown={(e) => e.shiftKey && e.preventDefault()} // no text selection on shift-click
              // toggle in onClick (not onChange): change events have no shiftKey
              onClick={(e) => {
                e.stopPropagation();
                const range = e.shiftKey && onSelectMany
                  ? shiftRange(sessions.map((x) => x.id), anchorId, s.id)
                  : null;
                if (range) onSelectMany!(range, !(selected?.has(s.id) ?? false));
                else onToggleSelect?.(s.id);
                setAnchorId(s.id);
              }}
            />
            <span className={`truncate text-[12.5px] font-medium ${done ? "text-ink-muted" : ""}`}>
              {s.title}
            </span>
            <span className="flex items-center gap-1.5 text-[11.5px]" style={{ color: statusStyle(s.status).color }}>
              <StatusDot status={s.status} size={7} /> {statusStyle(s.status).label}
            </span>
            <span className="flex min-w-0 items-center gap-1.5">
              {project && (
                <ClientChip
                  name={project.name}
                  color={project.color}
                  title={`Show only “${project.name}”`}
                  active={storyFilter?.includes(project.id) ?? false}
                  onClick={onFilterStory
                    ? () => onFilterStory(project.id)
                    : undefined}
                />
              )}
              {target && (
                <>
                  {project && <span className="shrink-0 text-[10px] text-ink-muted/50">›</span>}
                  {onFilterStory
                    ? (
                      <button type="button"
                        onClick={(e) => {
                          e.stopPropagation(); // filter instead of opening the row
                          onFilterStory(target.id);
                        }}
                        title={`Show only “${target.title}”`}
                        className={`flex min-w-0 items-center gap-1 truncate text-left text-[11.5px] hover:text-copper ${
                          storyFilter?.includes(target.id) ? "text-copper" : "text-ink-muted"
                        }`}
                      >
                        <EntityIcon icon={target.icon} fallback={pageGlyph(target.kind)} className="shrink-0 text-[9px]" />
                        <span className="truncate">{target.title}</span>
                      </button>
                    )
                    : (
                      <span className="flex min-w-0 items-center gap-1 truncate text-[11.5px] text-ink-muted">
                        <EntityIcon icon={target.icon} fallback={pageGlyph(target.kind)} className="shrink-0 text-[9px]" />
                        <span className="truncate">{target.title}</span>
                      </span>
                    )}
                  {tail && tail.id !== target.id && (
                    <span className="truncate text-[11px] text-ink-muted/60" title={tail.title}>
                      › {tail.title}
                    </span>
                  )}
                </>
              )}
            </span>
            <span className="truncate text-[11px] text-ink-muted">{s.branch ?? ""}</span>
            <span className="text-[11.5px] text-ink-muted">{timeAgo(s.last_touched)}</span>
          </div>
        );
      })}
    </div>
  );
}
