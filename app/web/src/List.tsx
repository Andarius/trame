import type { BoardData } from "./api";
import { ClientChip, STATUS, StatusDot, timeAgo } from "./ui";

const GRID = "grid grid-cols-[1fr_110px_120px_180px_150px_90px] items-center gap-4";

export function List({ board, onOpen }: { board: BoardData; onOpen: (id: string) => void }) {
  const sessions = [...board.sessions].sort((a, b) => b.last_touched.localeCompare(a.last_touched));
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-3">
      <div className={`${GRID} px-3 pb-2.5 pt-1 text-[10px] font-medium tracking-[0.7px] text-ink-muted/75`}>
        <span>SESSION</span>
        <span>STATUS</span>
        <span>CLIENT</span>
        <span>OBJECTIVE</span>
        <span>BRANCH</span>
        <span>TOUCHED</span>
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
            <span className="truncate text-[11.5px] text-ink-muted">{objective?.title ?? "—"}</span>
            <span className="truncate text-[11px] text-ink-muted">{s.branch ?? ""}</span>
            <span className="text-[11.5px] text-ink-muted">{timeAgo(s.last_touched)}</span>
          </div>
        );
      })}
    </div>
  );
}
