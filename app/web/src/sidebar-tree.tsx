import { createContext, type ReactNode, useContext } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { PageMeta, Session, UdbMeta } from "./api";
import { useAgents } from "./agents";
import { EntityIcon, pageGlyph, StatusDot, statusStyle, PresenceDot } from "./ui";

// open cards per user story, for the sidebar tree
export type TreeCards = { byStory: Map<string, Session[]>; open: (id: string) => void; current: string | null };
export const TreeCardsCtx = createContext<TreeCards>({ byStory: new Map(), open: () => {}, current: null });

export type LiveCount = { working: number; waiting: number; own: boolean };
// live agents per page, rolled up the tree so a collapsed parent still shows them
export const LiveCounts = createContext<Map<string, LiveCount>>(new Map());

export function LiveMarker({ id }: { id: string }) {
  const c = useContext(LiveCounts).get(id);
  const { cfg } = useAgents();
  if (!c) return null;
  const spin = cfg?.motion ? "motion-safe:animate-spin" : "";
  const tip = [c.working && `${c.working} working`, c.waiting && `${c.waiting} needs you`].filter(Boolean).join(", ");
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-1 font-mono text-[10.5px] font-semibold text-ink-soft" title={tip}>
      {c.working > 0 && (
        <span className="inline-flex items-center gap-1">
          {c.own
            ? <span className={`h-2.5 w-2.5 rounded-full border-[1.5px] border-live/40 border-t-live ${spin}`} />
            : <PresenceDot state="working" />}
          {(c.working > 1 || !c.own) && c.working}
        </span>
      )}
      {c.waiting > 0 && (
        <span className="inline-flex items-center gap-1">
          <PresenceDot state="waiting" />
          {(c.waiting > 1 || !c.own) && c.waiting}
        </span>
      )}
    </span>
  );
}

export function PageNode(
  {
    p,
    depth,
    childrenOf,
    dbsOf,
    expanded,
    onToggle,
    current,
    currentDb,
    onOpenPage,
    onOpenDb,
    onNewChild,
    onStar,
    starred,
    meId,
  }: {
    p: PageMeta;
    depth: number;
    childrenOf: Map<string | null, PageMeta[]>;
    dbsOf: Map<string, UdbMeta[]>;
    expanded: Set<string>;
    onToggle: (id: string) => void;
    current: string | null;
    currentDb: string | null;
    onOpenPage: (id: string) => void;
    onOpenDb: (id: string) => void;
    onNewChild: (parentId: string) => void;
    onStar: (id: string) => void;
    starred: Set<string>;
    meId: string | null;
  },
) {
  const allKids = childrenOf.get(p.id) ?? [];
  const { normal: kids, archived } = splitArchived(allKids, starred);
  const dbs = dbsOf.get(p.id) ?? [];
  const treeCards = useContext(TreeCardsCtx);
  const { live: liveNow } = useAgents();
  const cards = treeCards.byStory.get(p.id) ?? [];
  const hasKids = allKids.length + dbs.length + cards.length > 0;
  const open = expanded.has(p.id);
  const active = p.id === current;
  const sharedIn = isSharedIn(p, meId);
  const canDrag = (p.kind === "page" || p.kind === "story") && !sharedIn;
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } =
    useDraggable({ id: p.id, disabled: !canDrag, data: { kind: p.kind } });
  const { setNodeRef: setDropRef, isOver, active: dragged } = useDroppable({
    id: `drop:${p.id}`,
  });
  // pages file under any node; stories only re-home across projects
  const draggedKind = dragged?.data.current?.kind as string | undefined;
  const canDrop = !sharedIn && (p.kind === "project" || draggedKind === "page");
  return (
    <>
      <div
        ref={(el) => {
          setDragRef(el);
          setDropRef(el);
        }}
        {...(canDrag ? { ...attributes, ...listeners } : {})}
        className={`group flex items-center gap-1 rounded-md py-[5px] pr-1 text-left text-[13px] ${
          active
            ? "bg-active-row font-medium text-ink"
            : "text-ink-muted hover:text-ink-soft"
        }${canDrag ? " touch-none active:cursor-grabbing" : ""}${
          isDragging ? " opacity-40" : ""
        }${isOver && canDrop ? " bg-copper/10 ring-1 ring-copper/40" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        <button
          type="button"
          className={`w-[14px] shrink-0 text-[9px] ${
            hasKids ? "text-ink-muted/70 hover:text-ink" : "text-transparent"
          }`}
          onClick={() => hasKids && onToggle(p.id)}
          onPointerDown={(e) => e.stopPropagation()}
          tabIndex={hasKids ? 0 : -1}
        >
          {open ? "▾" : "▸"}
        </button>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5"
          onClick={() => onOpenPage(p.id)}
        >
          <span
            className={`text-[12px] ${
              active && !(p.kind === "project" && p.color) ? "text-copper" : ""
            }`}
            style={p.kind === "project" && p.color
              ? { color: p.color }
              : undefined}
          >
            <EntityIcon icon={p.icon} fallback={pageGlyph(p.kind, p.mark_role)} />
          </span>
          <span
            className={`truncate ${p.title ? "" : "italic text-ink-muted/60"}`}
          >
            {p.title || "Untitled"}
          </span>
          <LiveMarker id={p.id} />
        </button>
        <button
          type="button"
          className={`shrink-0 rounded px-1 text-[11px] hover:text-copper ${
            starred.has(p.id) ? "text-copper" : "hidden text-ink-muted group-hover:block"
          }`}
          title={starred.has(p.id) ? "unstar" : "star — pin this page on top"}
          onClick={() => onStar(p.id)}
          onPointerDown={(e) => e.stopPropagation()}
        >
          ★
        </button>
        <button
          type="button"
          className="hidden shrink-0 rounded px-1 text-[12px] text-ink-muted hover:text-ink group-hover:block"
          title="new sub-page"
          onClick={() => onNewChild(p.id)}
          onPointerDown={(e) => e.stopPropagation()}
        >
          ＋
        </button>
      </div>
      {open && cards.map((c) => {
        const on = liveNow.find(({ a }) => a.session_id === c.id);
        return (
          <button
            type="button"
            key={c.id}
            onClick={() => treeCards.open(c.id)}
            className={`flex items-center gap-1.5 rounded-md py-[5px] pr-1 text-left text-[13px] ${
              c.id === treeCards.current ? "bg-active-row font-medium text-ink" : "text-ink-muted hover:text-ink-soft"
            }`}
            style={{ paddingLeft: 8 + (depth + 1) * 14 + 14 }}
            title={`${c.title} — ${statusStyle(c.status).label}`}
          >
            <span className="text-[11px]">▦</span>
            <span className="flex-1 truncate">{c.title}</span>
            {on && <PresenceDot state={on.state} className="shrink-0" />}
            <StatusDot status={c.status} size={6} />
          </button>
        );
      })}
      {open && dbs.map((d) => {
        const dbActive = d.id === currentDb;
        return (
          <button
            type="button"
            key={d.id}
            onClick={() => onOpenDb(d.id)}
            className={`flex items-center gap-1.5 rounded-md py-[5px] pr-2 text-left text-[13px] ${
              dbActive
                ? "bg-active-row font-medium text-ink"
                : "text-ink-muted hover:text-ink-soft"
            }`}
            style={{ paddingLeft: 8 + (depth + 1) * 14 + 14 }}
          >
            <span className={`text-[12px] ${dbActive ? "text-copper" : ""}`}>
              <EntityIcon icon={d.icon} fallback="⌗" />
            </span>
            <span className="flex-1 truncate">{d.name}</span>
            <span className="text-[10.5px] text-ink-muted/60">
              {d.row_count || ""}
            </span>
          </button>
        );
      })}
      {open && kids.map(renderKid)}
      {open && archived.length > 0 && (
        <ArchivedFold
          parentKey={p.id}
          kids={archived}
          depth={depth + 1}
          expanded={expanded}
          onToggle={onToggle}
          node={renderKid}
        />
      )}
    </>
  );

  function renderKid(k: PageMeta) {
    return (
      <PageNode
        key={k.id}
        p={k}
        depth={depth + 1}
        childrenOf={childrenOf}
        dbsOf={dbsOf}
        expanded={expanded}
        onToggle={onToggle}
        current={current}
        currentDb={currentDb}
        onOpenPage={onOpenPage}
        onOpenDb={onOpenDb}
        onNewChild={onNewChild}
        onStar={onStar}
        starred={starred}
        meId={meId}
      />
    );
  }
}

// A root page owned by another hub user reached us via a share — group it apart.
// Ownerless pages (dev mode, unclaimed device) count as mine.
export function isSharedIn(p: PageMeta, meId: string | null): boolean {
  return meId != null && p.owner_id != null && p.owner_id !== meId;
}

// archived stories leave the main list, starred ones ride on top
// (stable sort: server order kept within each group)
export const splitArchived = (kids: PageMeta[], starred: Set<string>) => ({
  normal: kids.filter((k) => k.status !== "archived").sort((a, b) =>
    Number(starred.has(b.id)) - Number(starred.has(a.id))
  ),
  archived: kids.filter((k) => k.status === "archived"),
});

// "Show more" on RECENTLY MODIFIED — parked in `expanded` like `archived:<parent>`,
// so it persists through the same localStorage key
export const RECENTS_KEY = "recents:more";
export const RECENTS_SHORT = 5;
export const RECENTS_LONG = 20;

// collapsed per-parent bucket for archived stories — expand state persists through
// the same `expanded` set as real nodes, under the synthetic `archived:<parent>` key
export function ArchivedFold(
  { parentKey, kids, depth, expanded, onToggle, node }: {
    parentKey: string;
    kids: PageMeta[];
    depth: number;
    expanded: Set<string>;
    onToggle: (id: string) => void;
    node: (k: PageMeta) => ReactNode;
  },
) {
  const key = `archived:${parentKey}`;
  const open = expanded.has(key);
  return (
    <>
      <button
        type="button"
        className="flex items-center gap-1 rounded-md py-[5px] pr-1 text-left text-[12px] text-ink-muted/70 hover:text-ink-soft"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onToggle(key)}
      >
        <span className="w-[14px] shrink-0 text-[9px]">
          {open ? "▾" : "▸"}
        </span>
        Archived ({kids.length})
      </button>
      {open && (
        <div className="flex flex-col gap-1 opacity-50">{kids.map(node)}</div>
      )}
    </>
  );
}

// drop zone covering the whole UNFILED section — dropping a page here un-files it
export function UnfiledZone({ children }: { children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: "unfiled" });
  return (
    <div
      ref={setNodeRef}
      className={`flex flex-col gap-1 ${
        isOver ? "rounded-md bg-copper/5 ring-1 ring-copper/30" : ""
      }`}
    >
      {children}
    </div>
  );
}
