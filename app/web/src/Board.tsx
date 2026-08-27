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
import type { BoardData, Session, Status } from "./api.ts";
import {
  ClientChip,
  inSubtree,
  ObjectiveChip,
  pageGlyph,
  pagesById,
  projectOf,
  sessionAnchor,
  shiftRange,
  statusStyle,
  StatusDot,
  storyOf,
} from "./ui";

function TicketBody(
  { s, board, overlay = false, showObjective = true, storyFilter, onFilterStory }: {
    s: Session;
    board: BoardData;
    overlay?: boolean;
    showObjective?: boolean;
    storyFilter?: string[] | null;
    onFilterStory?: (id: string) => void;
  },
) {
  const byId = pagesById(board.pages);
  const client = board.projects.find((c) => c.id === s.client_id);
  // the chip shows the derived story; a story-less session shows its anchor page instead
  const chipPage = storyOf(s, byId) ?? sessionAnchor(s, byId);
  const done = statusStyle(s.status).terminal;
  return (
    <div
      className={`flex flex-col gap-1.5 rounded-lg border bg-card px-2.5 py-2 ${
        overlay ? "border-copper/60 shadow-xl shadow-black/40" : "border-line"
      } ${done && !overlay ? "opacity-60" : ""}`}
    >
      <div className="text-[12.5px] font-medium leading-snug">{s.title}</div>
      {showObjective && chipPage && (
        <ObjectiveChip
          title={chipPage.title}
          glyph={pageGlyph(chipPage.kind)}
          icon={chipPage.icon}
          active={storyFilter?.includes(chipPage.id) ?? false}
          onClick={onFilterStory ? () => onFilterStory(chipPage.id) : undefined}
        />
      )}
      <div className="flex items-center gap-1.5">
        {client && (
          <ClientChip
            name={client.name}
            color={client.color}
            title={`Show only “${client.name}”`}
            active={storyFilter?.includes(client.id) ?? false}
            onClick={onFilterStory ? () => onFilterStory(client.id) : undefined}
          />
        )}
        {s.branch && <span className="text-[10.5px] text-ink-muted">{s.branch}</span>}
      </div>
      {s.next_step && !done && (
        <div className="text-[11px] leading-snug text-ink-soft">→ {s.next_step}</div>
      )}
    </div>
  );
}

function DraggableTicket(
  { s, board, showObjective, onOpen, onOpenFull, storyFilter, onFilterStory, selected = false, onToggleSelect }: {
    s: Session;
    board: BoardData;
    showObjective: boolean;
    onOpen: (id: string) => void;
    onOpenFull?: (id: string) => void;
    storyFilter?: string[] | null;
    onFilterStory?: (id: string) => void;
    selected?: boolean;
    onToggleSelect?: (id: string, shift: boolean) => void;
  },
) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: s.id });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={() => onOpen(s.id)}
      onDoubleClick={() => {
        document.getSelection()?.removeAllRanges();
        onOpenFull?.(s.id);
      }}
      className={`group relative cursor-pointer touch-none active:cursor-grabbing ${isDragging ? "opacity-30" : ""} ${
        selected ? "rounded-lg ring-1 ring-copper/60" : ""
      }`}
    >
      <TicketBody
        s={s}
        board={board}
        showObjective={showObjective}
        storyFilter={storyFilter}
        onFilterStory={onFilterStory}
      />
      {onToggleSelect && (
        <input
          type="checkbox"
          checked={selected}
          readOnly
          // stop pointerdown so the dnd sensor never claims the click
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.shiftKey && e.preventDefault()} // no text selection on shift-click
          // toggle in onClick (not onChange): change events have no shiftKey
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect(s.id, e.shiftKey);
          }}
          className={`absolute right-2 top-2 h-3.5 w-3.5 accent-[#c98a63] ${
            selected ? "" : "opacity-0 transition-opacity group-hover:opacity-100"
          }`}
        />
      )}
    </div>
  );
}

function Column(
  { status, sessions, board, dropId, showObjective, onOpen, onOpenFull, compact = false, storyFilter, onFilterStory, selected, onToggleSelect, onSelectMany, anchorId, onAnchor }: {
    status: Status;
    sessions: Session[];
    board: BoardData;
    dropId: string;
    showObjective: boolean;
    onOpen: (id: string) => void;
    onOpenFull?: (id: string) => void;
    compact?: boolean;
    storyFilter?: string[] | null;
    onFilterStory?: (id: string) => void;
    selected?: Set<string>;
    onToggleSelect?: (id: string) => void;
    onSelectMany?: (ids: string[], on: boolean) => void;
    anchorId?: string | null;
    onAnchor?: (id: string) => void;
  },
) {
  const { setNodeRef, isOver } = useDroppable({ id: dropId });
  // shift-click ranges span this column only (anchor outside it falls back to a toggle)
  const toggle = (id: string, shift: boolean) => {
    const range = shift && onSelectMany ? shiftRange(sessions.map((x) => x.id), anchorId ?? null, id) : null;
    if (range) onSelectMany!(range, !(selected?.has(id) ?? false));
    else onToggleSelect?.(id);
    onAnchor?.(id);
  };
  return (
    <div
      ref={setNodeRef}
      className={`flex flex-1 flex-col gap-2 rounded-[10px] border bg-panel p-2 transition-colors ${
        isOver ? "border-copper/50" : "border-line"
      } ${compact ? "min-h-[72px]" : "min-h-0 overflow-y-auto"}`}
    >
      <div className="flex items-center gap-1.5 px-1 pt-0.5 pb-1">
        <StatusDot status={status} />
        <span className="text-[12.5px] font-semibold text-ink">{statusStyle(status).label}</span>
        <span className="text-[11.5px] font-medium text-ink-muted">{sessions.length}</span>
      </div>
      {sessions.map((s) => (
        <DraggableTicket
          key={s.id}
          s={s}
          board={board}
          showObjective={showObjective}
          onOpen={onOpen}
          onOpenFull={onOpenFull}
          storyFilter={storyFilter}
          onFilterStory={onFilterStory}
          selected={selected?.has(s.id) ?? false}
          onToggleSelect={onToggleSelect && toggle}
        />
      ))}
    </div>
  );
}

export function Board(
  { board, group, onMove, onOpen, onOpenFull, storyFilter, onFilterStory, hideEmpty, selected, onToggleSelect, onSelectMany }: {
    board: BoardData;
    group: "none" | "story" | "project";
    onMove: (id: string, status: Status) => void;
    onOpen: (id: string) => void;
    onOpenFull?: (id: string) => void;
    storyFilter?: string[] | null;
    onFilterStory?: (id: string) => void;
    hideEmpty?: boolean;
    selected?: Set<string>;
    onToggleSelect?: (id: string) => void;
    onSelectMany?: (ids: string[], on: boolean) => void;
  },
) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [anchorId, setAnchorId] = useState<string | null>(null); // last-clicked checkbox, for shift-ranges
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const active = activeId ? board.sessions.find((s) => s.id === activeId) : null;
  // suppress the click that fires right after a drop
  const lastDragEnd = useRef(0);
  const openGuarded = (id: string) => {
    if (Date.now() - lastDragEnd.current > 250) onOpen(id);
  };
  const openFullGuarded = onOpenFull &&
    ((id: string) => {
      if (Date.now() - lastDragEnd.current > 250) onOpenFull(id);
    });

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

  const byId = pagesById(board.pages);
  // clicking a card's story chip narrows the board to that story's SUBTREE
  // (drag still uses the full set)
  const visible = storyFilter?.length
    ? board.sessions.filter((s) => storyFilter.some((f) => inSubtree(s, f, byId)))
    : board.sessions;
  // status columns come from the synced statuses table (already sort_key-ordered),
  // optionally hiding the empty ones
  const ordered = board.statuses.map((s) => s.key);
  const present = new Set(visible.map((s) => s.status));
  const cols = hideEmpty ? ordered.filter((s) => present.has(s)) : ordered;
  type Lane = { key: string; title: string | null; glyph?: string; color?: string | null; sessions: Session[] };
  const lanes: Lane[] = group === "none"
    ? [{ key: "all", title: null, sessions: visible }]
    : group === "project"
    ? [
      ...board.projects.map((c) => ({
        key: c.id,
        title: c.name,
        glyph: "◎",
        color: c.color,
        sessions: visible.filter((s) => projectOf(s, byId) === c.id),
      })),
      {
        key: "none",
        title: "— No project",
        glyph: "◎",
        sessions: visible.filter((s) => !projectOf(s, byId)),
      },
    ]
    : [
      ...board.stories.map((o) => ({
        key: o.id,
        title: o.title,
        glyph: "◇",
        // subtree: sessions anchored to the story or any page nested under it
        sessions: visible.filter((s) => storyOf(s, byId)?.id === o.id),
      })),
      {
        key: "none",
        title: "— No story",
        glyph: "◇",
        sessions: visible.filter((s) => !storyOf(s, byId)),
      },
    ];
  // grouped lanes with no sessions are pure noise (drag only moves within a lane)
  const shownLanes = group === "none" ? lanes : lanes.filter((l) => l.sessions.length > 0);

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5 pt-4">
        {shownLanes.map((lane) => (
          <div key={lane.key} className={`flex flex-col gap-2 ${group === "none" ? "min-h-0 flex-1" : ""}`}>
            {lane.title && (
              <div className="flex items-center gap-2 px-0.5">
                <span className="text-[9.5px] text-ink-muted" style={lane.color ? { color: lane.color } : undefined}>
                  {lane.glyph ?? "◇"}
                </span>
                <span className="text-[12.5px] font-semibold">{lane.title}</span>
                <span className="text-[11px] text-ink-muted">{lane.sessions.length}</span>
              </div>
            )}
            <div className={`flex gap-3.5 ${group === "none" ? "min-h-0 flex-1" : ""}`}>
              {cols.map((status) => (
                <Column
                  key={status}
                  status={status}
                  dropId={`${status}@${lane.key}`}
                  sessions={lane.sessions.filter((s) => s.status === status)}
                  board={board}
                  showObjective={group === "none"}
                  onOpen={openGuarded}
                  onOpenFull={openFullGuarded}
                  compact={group !== "none"}
                  storyFilter={storyFilter}
                  onFilterStory={onFilterStory}
                  selected={selected}
                  onToggleSelect={onToggleSelect}
                  onSelectMany={onSelectMany}
                  anchorId={anchorId}
                  onAnchor={setAnchorId}
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
