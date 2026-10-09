import { useState } from "react";
import { type BoardData, updatePage } from "../api";
import { clientColor, EntityIcon, FIELD_LABEL, inSubtree, pagesById, projectOf, statusStyle, storyOf, EmptyState } from "../ui/ui";
import { IconPicker } from "../udb/cells";
import { SessionRow } from "../page/project-page";

// Overview for one client: its projects (each openable) with progress, plus any
// client-tagged sessions that don't ladder up to one of those projects. All derived
// from the board payload — no new endpoint.
export function ClientView(
  { board, clientId, onOpenPage, onOpenSession, onChanged }: {
    board: BoardData;
    clientId: string;
    onOpenPage: (id: string) => void;
    onOpenSession: (id: string, full?: boolean) => void;
    onChanged?: () => void;
  },
) {
  const [iconOpen, setIconOpen] = useState(false);
  const byId = pagesById(board.pages);
  const client = board.projects.find((c) => c.id === clientId);
  if (!client) return <EmptyState page>Client not found.</EmptyState>;
  const col = clientColor(client.name, client.color);
  const stories = board.stories.filter((o) => o.client_id === clientId);
  const storyIds = new Set(stories.map((p) => p.id));
  const mine = board.sessions.filter((s) => projectOf(s, byId) === clientId);
  const sessionsOf = (pid: string) => mine.filter((s) => inSubtree(s, pid, byId));
  const loose = mine.filter((s) => !storyIds.has(storyOf(s, byId)?.id ?? ""));
  const totalSessions = mine.length;

  const sectionLbl = `px-0.5 pb-1 pt-1 ${FIELD_LABEL}`;
  const sessionRow = (s: (typeof board.sessions)[number]) => <SessionRow key={s.id} s={s} onOpen={onOpenSession} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-6">
      <div className="flex items-center gap-2.5">
        <div className="relative">
          <button
            type="button"
            title="Set logo"
            className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-hover"
            onClick={() => setIconOpen(true)}
          >
            {client.icon
              ? /^(https?:|data:)/.test(client.icon)
                ? <img src={client.icon} alt="" className="h-[34px] w-[34px] rounded-md object-contain" />
                : <span className="text-[28px] leading-none">{client.icon}</span>
              : <span className="h-3 w-3 rounded-sm" style={{ background: col }} />}
          </button>
          {iconOpen && (
            <IconPicker
              current={client.icon}
              onPick={(icon) => updatePage(clientId, { icon }).then(() => onChanged?.())}
              onClose={() => setIconOpen(false)}
            />
          )}
        </div>
        <span className="text-xl font-semibold" style={{ color: col }}>{client.name}</span>
        <span className="text-[11.5px] text-ink-muted">
          {stories.length} {stories.length === 1 ? "story" : "stories"} · {totalSessions}{" "}
          {totalSessions === 1 ? "session" : "sessions"}
        </span>
      </div>

      <div className="flex flex-col gap-3">
        <span className={sectionLbl}>STORIES</span>
        {stories.length === 0 && <span className="px-0.5 text-[12px] text-ink-muted">No stories yet.</span>}
        {stories.map((p) => {
          const ss = sessionsOf(p.id);
          const done = ss.filter((s) => statusStyle(s.status).terminal).length;
          return (
            <div key={p.id} className="flex flex-col gap-1 rounded-lg border border-line bg-well p-3">
              <button type="button"
                onClick={() => onOpenPage(p.id)}
                className="flex items-center gap-2 text-left"
              >
                <EntityIcon icon={null} fallback="◎" className="text-[13px] text-copper" />
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
