import { useState } from "react";
import type { BoardData } from "./api";
import { ClientChip, STATUS, StatusDot, timeAgo } from "./ui";

const GRID = "grid grid-cols-[1fr_110px_120px_180px_150px_90px] items-center gap-4";

type SortKey = "title" | "status" | "client" | "objective" | "branch" | "touched";
const STATUS_ORDER = Object.keys(STATUS); // active → paused → blocked → done (as declared)
const COLS: [SortKey, string][] = [
  ["title", "SESSION"],
  ["status", "STATUS"],
  ["client", "CLIENT"],
  ["objective", "OBJECTIVE"],
  ["branch", "BRANCH"],
  ["touched", "TOUCHED"],
];

export function List(
  { board, onOpen, storyFilter, onFilterStory }: {
    board: BoardData;
    onOpen: (id: string) => void;
    storyFilter?: string | null;
    onFilterStory?: (id: string) => void;
  },
) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "touched", dir: -1 });

  const key = (s: BoardData["sessions"][number]): string | number => {
    switch (sort.key) {
      case "title":
        return s.title.toLowerCase();
      case "status":
        return STATUS_ORDER.indexOf(s.status);
      case "client":
        return (board.clients.find((c) => c.id === s.client_id)?.name ?? "").toLowerCase();
      case "objective":
        return (board.objectives.find((o) => o.id === s.objective_id)?.title ?? "").toLowerCase();
      case "branch":
        return (s.branch ?? "").toLowerCase();
      case "touched":
        return s.last_touched;
    }
  };
  const filtered = storyFilter ? board.sessions.filter((s) => s.objective_id === storyFilter) : board.sessions;
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
        const client = board.clients.find((c) => c.id === s.client_id);
        const objective = board.objectives.find((o) => o.id === s.objective_id);
        const done = s.status === "done";
        return (
          <div
            key={s.id}
            onClick={() => onOpen(s.id)}
            className={`${GRID} cursor-pointer border-b border-line-soft px-3 py-2.5 hover:bg-panel/60`}
          >
            <span className={`truncate text-[12.5px] font-medium ${done ? "text-ink-muted" : ""}`}>
              {s.title}
            </span>
            <span className="flex items-center gap-1.5 text-[11.5px]" style={{ color: STATUS[s.status].color }}>
              <StatusDot status={s.status} size={7} /> {STATUS[s.status].label}
            </span>
            <span>{client && <ClientChip name={client.name} color={client.color} />}</span>
            {objective && onFilterStory
              ? (
                <button type="button"
                  onClick={(e) => {
                    e.stopPropagation(); // filter instead of opening the row
                    onFilterStory(objective.id);
                  }}
                  title={`Show only “${objective.title}”`}
                  className={`truncate text-left text-[11.5px] hover:text-copper ${
                    objective.id === storyFilter ? "text-copper" : "text-ink-muted"
                  }`}
                >
                  {objective.title}
                </button>
              )
              : <span className="truncate text-[11.5px] text-ink-muted">{objective?.title ?? "—"}</span>}
            <span className="truncate text-[11px] text-ink-muted">{s.branch ?? ""}</span>
            <span className="text-[11.5px] text-ink-muted">{timeAgo(s.last_touched)}</span>
          </div>
        );
      })}
    </div>
  );
}
