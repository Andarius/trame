import { useState } from "react";
import { type BoardData, updateObjective } from "./api";
import { ClientChip, statusStyle, StatusDot } from "./ui";

function Story({ id, story, onSaved }: { id: string; story: string; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(story);
  if (!editing) {
    return (
      <p
        className="m-0 min-h-[16px] cursor-text whitespace-pre-wrap text-xs leading-relaxed text-ink-soft hover:text-ink"
        title="click to edit the story"
        onClick={() => {
          setDraft(story);
          setEditing(true);
        }}
      >
        {story || <span className="text-ink-muted/60 italic">add the story — what are we trying to achieve?</span>}
      </p>
    );
  }
  return (
    <textarea
      autoFocus
      className="min-h-[90px] resize-y rounded-md border border-chipline bg-well p-2 text-xs leading-relaxed text-ink outline-none"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (draft !== story) updateObjective(id, { story: draft }).then(onSaved);
      }}
    />
  );
}

export function Objectives(
  { board, onOpen, onSaved }: { board: BoardData; onOpen: (id: string) => void; onSaved: () => void },
) {
  const unassigned = board.sessions.filter((s) => !s.objective_id).length;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-5 pt-4">
      {board.objectives.map((o) => {
        const client = board.clients.find((c) => c.id === o.client_id);
        const threads = board.sessions
          .filter((s) => s.objective_id === o.id)
          .sort((a, b) => (statusStyle(a.status).terminal ? 1 : 0) - (statusStyle(b.status).terminal ? 1 : 0));
        const done = threads.filter((s) => statusStyle(s.status).terminal).length;
        const pct = threads.length ? (done / threads.length) * 100 : 0;
        return (
          <div key={o.id} className="flex flex-col gap-2.5 rounded-xl border border-line bg-panel px-4.5 py-4">
            <div className="flex items-center gap-2.5">
              <span className="text-[14.5px] font-semibold">{o.title}</span>
              {client && <ClientChip name={client.name} color={client.color} />}
              <span className="flex-1" />
              <span className="text-[11.5px] font-medium text-ink-muted">
                {done} / {threads.length} done
              </span>
            </div>
            <Story id={o.id} story={o.story} onSaved={onSaved} />
            <div className="h-[5px] overflow-hidden rounded-full bg-line">
              <div className="h-full rounded-full bg-copper" style={{ width: `${pct}%` }} />
            </div>
            <div className="flex flex-col">
              {threads.map((s) => (
                <div
                  key={s.id}
                  onClick={() => onOpen(s.id)}
                  className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-hover"
                >
                  <StatusDot status={s.status} size={7} />
                  <span className={`text-xs font-medium ${statusStyle(s.status).terminal ? "text-ink-muted" : ""}`}>
                    {s.title}
                  </span>
                  {s.branch && <span className="text-[10.5px] text-ink-muted">{s.branch}</span>}
                </div>
              ))}
              {threads.length === 0 && (
                <span className="py-1 text-[11.5px] text-ink-muted">no sessions yet</span>
              )}
            </div>
          </div>
        );
      })}
      {unassigned > 0 && (
        <p className="px-1.5 text-[11.5px] text-ink-muted">
          {unassigned} session{unassigned > 1 ? "s" : ""} without an objective — assign them to see their story here →
        </p>
      )}
    </div>
  );
}
