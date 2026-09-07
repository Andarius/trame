import type { BoardData, Session } from "./api";
import { pagesById, projectOf, sessionTagKeys, storyOf } from "./ui";

export const SORT_FIELDS = {
  priority: "Priority", title: "Session", status: "Status",
  location: "Location", branch: "Branch", touched: "Touched",
};
export type SortKey = keyof typeof SORT_FIELDS;
export type Sort = { key: SortKey; dir: 1 | -1 };

export function sortSessionBoard(board: BoardData, sort: Sort[]): BoardData {
  const byId = pagesById(board.pages);
  const value = (s: Session, key: SortKey): string | number | null => {
    switch (key) {
      case "priority": {
        const priorities = sessionTagKeys(s, byId).flatMap((tag) => {
          const match = /^(?:(?:priority|priorite)-)?p(\d+)$/i.exec(tag);
          return match ? [Number(match[1])] : [];
        });
        return priorities.length ? Math.min(...priorities) : null;
      }
      case "title": return s.title.toLowerCase();
      case "status": return board.statuses.findIndex((status) => status.key === s.status);
      case "location": {
        const project = board.projects.find((p) => p.id === projectOf(s, byId))?.name ?? "";
        return `${project} ${storyOf(s, byId)?.title ?? ""}`.toLowerCase();
      }
      case "branch": return (s.branch ?? "").toLowerCase();
      case "touched": return s.last_touched;
    }
  };
  const sessions = [...board.sessions].sort((a, b) => {
    for (const { key, dir } of sort) {
      const av = value(a, key), bv = value(b, key);
      if (av === bv) continue;
      if (av === null) return 1;
      if (bv === null) return -1;
      return (av < bv ? -1 : 1) * dir;
    }
    return 0;
  });
  return { ...board, sessions };
}

export function SessionSort({ sort, onChange }: { sort: Sort[]; onChange: (sort: Sort[]) => void }) {
  return (
    <div aria-label="Session sorting" className="flex flex-wrap items-center gap-2 px-5 pb-2 text-[11.5px] text-ink-muted">
      <span>Sort</span>
      {sort.map((field, index) => (
        <div key={field.key} className="flex items-center gap-1 rounded-md border border-chipline px-2 py-1">
          <span>{index + 1}. {SORT_FIELDS[field.key]}</span>
          {index > 0 && <button type="button" aria-label={`Move ${SORT_FIELDS[field.key]} sort earlier`}
            onClick={() => {
              const next = [...sort];
              [next[index - 1], next[index]] = [next[index], next[index - 1]];
              onChange(next);
            }}>←</button>}
          <button type="button" aria-label={`Reverse ${SORT_FIELDS[field.key]} sort`}
            onClick={() => onChange(sort.map((s, i) => i === index ? { ...s, dir: s.dir === 1 ? -1 : 1 } : s))}>
            {field.dir === 1 ? "↑" : "↓"}
          </button>
          <button type="button" aria-label={`Remove ${SORT_FIELDS[field.key]} sort`}
            onClick={() => onChange(sort.filter((_, i) => i !== index))}>×</button>
        </div>
      ))}
      {sort.length < Object.keys(SORT_FIELDS).length && (
        <select aria-label="Add sort field" value="" className="rounded-md bg-panel px-2 py-1 text-ink"
          onChange={(e) => {
            const key = e.target.value as SortKey;
            onChange([...sort, { key, dir: key === "touched" ? -1 : 1 }]);
          }}>
          <option value="" disabled>＋ sort…</option>
          {Object.entries(SORT_FIELDS).filter(([key]) => !sort.some((s) => s.key === key))
            .map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      )}
    </div>
  );
}
