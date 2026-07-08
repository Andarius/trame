import {
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useRef, useState } from "react";
import type { BoardData, Session, Status } from "./api";
import { ClientChip, ObjectiveChip, STATUS, StatusDot } from "./ui";

const COLUMNS: Status[] = ["active", "paused", "blocked", "done"];

function TicketBody(
  { s, board, overlay = false, showObjective = true }: {
    s: Session;
    board: BoardData;
    overlay?: boolean;
    showObjective?: boolean;
  },
) {
  const client = board.clients.find((c) => c.id === s.client_id);
  const objective = board.objectives.find((o) => o.id === s.objective_id);
  const done = s.status === "done";
  return (
    <div
      className={`flex flex-col gap-1.5 rounded-lg border bg-card px-2.5 py-2 ${
        overlay ? "border-copper/60 shadow-xl shadow-black/40" : "border-line"
      } ${done && !overlay ? "opacity-60" : ""}`}
    >
      <div className="text-[12.5px] font-medium leading-snug">{s.title}</div>
      {showObjective && objective && <ObjectiveChip title={objective.title} />}
      <div className="flex items-center gap-1.5">
        {client && <ClientChip name={client.name} color={client.color} />}
        {s.branch && <span className="text-[10.5px] text-ink-muted">{s.branch}</span>}
      </div>
      {s.next_step && !done && (
        <div className="text-[11px] leading-snug text-ink-soft">→ {s.next_step}</div>
      )}
    </div>
  );
}

function DraggableTicket(
  { s, board, showObjective, onOpen }: {
    s: Session;
    board: BoardData;
    showObjective: boolean;
    onOpen: (id: string) => void;
  },
) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: s.id });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={() => onOpen(s.id)}
      className={`cursor-pointer touch-none active:cursor-grabbing ${isDragging ? "opacity-30" : ""}`}
    >
      <TicketBody s={s} board={board} showObjective={showObjective} />
    </div>
  );
}

function Column(
  { status, sessions, board, dropId, showObjective, onOpen, compact = false }: {
    status: Status;
    sessions: Session[];
    board: BoardData;
    dropId: string;
    showObjective: boolean;
    onOpen: (id: string) => void;
    compact?: boolean;
  },
) {
  const { setNodeRef, isOver } = useDroppable({ id: dropId });
  return (
    <div
      ref={setNodeRef}
      className={`flex flex-1 flex-col gap-2 rounded-[10px] border bg-panel p-2 transition-colors ${
        isOver ? "border-copper/50" : "border-line"
      } ${compact ? "min-h-[72px]" : "min-h-0 overflow-y-auto"}`}
    >
      <div className="flex items-center gap-1.5 px-1 pt-0.5 pb-1">
        <StatusDot status={status} />
        <span className="text-[12.5px] font-semibold text-[#d9dde5]">{STATUS[status].label}</span>
        <span className="text-[11.5px] font-medium text-ink-muted">{sessions.length}</span>
      </div>
      {sessions.map((s) => (
        <DraggableTicket key={s.id} s={s} board={board} showObjective={showObjective} onOpen={onOpen} />
      ))}
    </div>
  );
}

export function Board(
  { board, group, onMove, onOpen }: {
    board: BoardData;
    group: "none" | "objective";
    onMove: (id: string, status: Status) => void;
    onOpen: (id: string) => void;
  },
) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const active = activeId ? board.sessions.find((s) => s.id === activeId) : null;
  // suppress the click that fires right after a drop
  const lastDragEnd = useRef(0);
  const openGuarded = (id: string) => {
    if (Date.now() - lastDragEnd.current > 250) onOpen(id);
  };

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    lastDragEnd.current = Date.now();
    if (!e.over) return;
    const status = String(e.over.id).split("@")[0] as Status;
    const id = String(e.active.id);
    const current = board.sessions.find((s) => s.id === id);
    if (current && current.status !== status) onMove(id, status);
  };

  const lanes: { key: string; title: string | null; sessions: Session[] }[] = group === "none"
    ? [{ key: "all", title: null, sessions: board.sessions }]
    : [
      ...board.objectives.map((o) => ({
        key: o.id,
        title: o.title,
        sessions: board.sessions.filter((s) => s.objective_id === o.id),
      })),
      {
        key: "none",
        title: "— No story",
        // also catches sessions whose page hasn't been promoted yet (sync window)
        sessions: board.sessions.filter((s) =>
          !s.objective_id || !board.objectives.some((o) => o.id === s.objective_id)
        ),
      },
    ];

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5 pt-4">
        {lanes.map((lane) => (
          <div key={lane.key} className={`flex flex-col gap-2 ${group === "none" ? "min-h-0 flex-1" : ""}`}>
            {lane.title && (
              <div className="flex items-center gap-2 px-0.5">
                <span className="text-[9.5px] text-ink-muted">◎</span>
                <span className="text-[12.5px] font-semibold">{lane.title}</span>
                <span className="text-[11px] text-ink-muted">{lane.sessions.length}</span>
              </div>
            )}
            <div className={`flex gap-3.5 ${group === "none" ? "min-h-0 flex-1" : ""}`}>
              {COLUMNS.map((status) => (
                <Column
                  key={status}
                  status={status}
                  dropId={`${status}@${lane.key}`}
                  sessions={lane.sessions.filter((s) => s.status === status)}
                  board={board}
                  showObjective={group === "none"}
                  onOpen={openGuarded}
                  compact={group === "objective"}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <DragOverlay>
        {active && (
          <div className="w-[260px]">
            <TicketBody s={active} board={board} overlay />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
