import type { BoardData } from "./api";
import { clientColor, StatusDot, timeAgo } from "./ui";

// Overview for one client: its projects (each openable) with progress, plus any
// client-tagged sessions that don't ladder up to one of those projects. All derived
// from the board payload — no new endpoint.
export function ClientView(
  { board, clientId, onOpenPage, onOpenSession }: {
    board: BoardData;
    clientId: string;
    onOpenPage: (id: string) => void;
    onOpenSession: (id: string) => void;
  },
) {
  const client = board.clients.find((c) => c.id === clientId);
  if (!client) return <p className="p-6 text-ink-muted">Client not found.</p>;
  const col = clientColor(client.name, client.color);
  const projects = board.objectives.filter((o) => o.client_id === clientId);
  const projIds = new Set(projects.map((p) => p.id));
  const sessionsOf = (pid: string) => board.sessions.filter((s) => s.objective_id === pid);
  const loose = board.sessions.filter((s) =>
    s.client_id === clientId && (!s.objective_id || !projIds.has(s.objective_id))
  );
  const totalSessions = board.sessions.filter((s) => s.client_id === clientId).length;

  const sectionLbl = "px-0.5 pb-1 pt-1 text-[10px] font-medium tracking-[0.8px] text-ink-muted/70";
  const sessionRow = (s: (typeof board.sessions)[number]) => (
    <button type="button"
      key={s.id}
      onClick={() => onOpenSession(s.id)}
      className="flex items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-[#14161c]"
    >
      <StatusDot status={s.status} size={7} />
      <span className={`text-[12.5px] ${s.status === "done" ? "text-ink-muted line-through" : "text-ink-soft"}`}>
        {s.title}
      </span>
      {s.branch && <span className="text-[10.5px] text-ink-muted">⎇ {s.branch}</span>}
      <span className="flex-1" />
      <span className="text-[10px] text-ink-muted/70">{timeAgo(s.last_touched)}</span>
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-6">
      <div className="flex items-center gap-2.5">
        <span className="h-3 w-3 rounded-sm" style={{ background: col }} />
        <span className="text-xl font-semibold" style={{ color: col }}>{client.name}</span>
        <span className="text-[11.5px] text-ink-muted">
          {projects.length} {projects.length === 1 ? "story" : "stories"} · {totalSessions}{" "}
          {totalSessions === 1 ? "session" : "sessions"}
        </span>
      </div>

      <div className="flex flex-col gap-3">
        <span className={sectionLbl}>STORIES</span>
        {projects.length === 0 && <span className="px-0.5 text-[12px] text-ink-muted">No stories yet.</span>}
        {projects.map((p) => {
          const ss = sessionsOf(p.id);
          const done = ss.filter((s) => s.status === "done").length;
          return (
            <div key={p.id} className="flex flex-col gap-1 rounded-lg border border-line bg-[#101219] p-3">
              <button type="button"
                onClick={() => onOpenPage(p.id)}
                className="flex items-center gap-2 text-left"
              >
                <span className="text-[13px] text-copper">◎</span>
                <span className="text-[13px] font-semibold text-ink hover:underline">{p.title}</span>
                <span className="flex-1" />
                {ss.length > 0 && (
                  <span className="text-[11px] font-medium text-ink-muted">{done} / {ss.length} done</span>
                )}
              </button>
              {ss.length > 0 && <div className="flex flex-col">{ss.map(sessionRow)}</div>}
            </div>
          );
        })}
      </div>

      {loose.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className={sectionLbl}>OTHER SESSIONS</span>
          {loose.map(sessionRow)}
        </div>
      )}
    </div>
  );
}
