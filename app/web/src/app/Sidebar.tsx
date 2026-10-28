import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { BUILD_TIME } from "../build-info";
import { DndContext, DragOverlay, type DragEndEvent, type DragStartEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { type AppStatus, type BoardData, getIdentity, type PageMeta, type PluginManifest, type UdbMeta, type UpdateInfo } from "../api";
import { useAgents } from "../agents/agents";
import { WorkingNow } from "./WorkingNow";
import { useDue } from "../ui/due";
import { DueList } from "./DueList";
import { recentRows } from "./recents";
import type { View } from "./view";
import { Rail } from "./Rail";
import { ArchivedFold, isSharedIn, type LiveCount, LiveCounts, LiveMarker, PageNode, RECENTS_KEY, RECENTS_LONG, RECENTS_SHORT, splitArchived, UnfiledZone } from "./sidebar-tree";
import { SET_CODEC, useLocalStorage, EntityIcon, FoldLabel, pageGlyph, SECTION_LABEL, timeAgo, PresenceDot, useFold } from "../ui/ui";


// "New …" affordance under a sidebar section — a subtle dashed chip. `indent` is
// the x of the section's icon column (tree rows: 26 = 8px pad + 14px chevron + 4px
// gap; flat rows: 8); the chip shifts by its own padding+border so the ＋ lines up.
function NewChip(
  { label, indent, onClick }: {
    label: string;
    indent: number;
    onClick: () => void;
  },
) {
  return (
    <button
      type="button"
      className="mt-0.5 flex w-fit items-center gap-1.5 rounded-md border border-dashed border-chipline px-2 py-1 text-[12px] text-ink-muted/70 hover:border-copper/60 hover:text-copper"
      style={{ marginLeft: indent - 9 }}
      onClick={onClick}
    >
      <span className="text-[11px]">＋</span> {label}
    </button>
  );
}


export function Sidebar(
  {
    view,
    onNav,
    status,
    onSettings,
    pages,
    pageId,
    plugins,
    pluginId,
    onOpenPlugin,
    onOpenPage,
    onNewPage,
    onNewProject,
    onImportPage,
    onMovePage,
    starred,
    toggleStar,
    udbs,
    dbId,
    onOpenDb,
    onNewDb,
    update,
    updateState,
    onUpdate,
    board,
    onOpenSession,
    onOpenTerminals,
    column,
    wide,
    bare,
    hidden,
    onToggleHidden,
  }: {
    view: View;
    onNav: (v: View) => void;
    status: AppStatus | null;
    onSettings: () => void;
    pages: PageMeta[];
    pageId: string | null;
    plugins: PluginManifest[];
    pluginId: string | null;
    onOpenPlugin: (id: string) => void;
    onOpenPage: (id: string) => void;
    onNewPage: (parentId: string | null) => void;
    onNewProject: () => void;
    onImportPage: () => void;
    onMovePage: (id: string, parentId: string | null) => void;
    starred: Set<string>;
    toggleStar: (id: string) => void;
    udbs: UdbMeta[];
    dbId: string | null;
    onOpenDb: (id: string) => void;
    onNewDb: () => void;
    update: UpdateInfo | null;
    updateState: "idle" | "busy" | "done";
    onUpdate: () => void;
    board: BoardData | null;
    onOpenSession: (id: string) => void;
    onOpenTerminals: (card: string) => void;
    // the view's own column content, in place of the workspace (Working now, due, pages)
    column?: ReactNode;
    // a view whose list needs more room (Explore's search and filters)
    wide?: boolean;
    // a view with nothing to list beside it (plugins): the rail alone, the view takes the width
    bare?: boolean;
    // the user hid the column (⌘\\)
    hidden: boolean;
    onToggleHidden: () => void;
  },
) {
  // my user id (null in dev / before hub login) — used to split off shared-in roots
  const [meId, setMeId] = useState<string | null>(null);
  useEffect(() => {
    getIdentity().then((i) => setMeId(i.userId)).catch(() => {});
  }, []);
  const [expanded, setExpanded] = useLocalStorage("trame:expanded", new Set<string>(), SET_CODEC);
  const [recentsFolded, setRecentsFolded] = useFold("recents");
  const [starredFolded, setStarredFolded] = useFold("starred");
  const [projectsFolded, setProjectsFolded] = useFold("projects");
  const [sharedFolded, setSharedFolded] = useFold("shared");
  const [unfiledFolded, setUnfiledFolded] = useFold("unfiled");
  const [dbsFolded, setDbsFolded] = useFold("databases");

  const byId = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages]);
  const childrenOf = useMemo(() => {
    const m = new Map<string | null, PageMeta[]>();
    for (const p of pages) {
      // orphan-tolerant: a child whose parent hasn't synced yet shows at the root
      const key = p.parent_id && byId.has(p.parent_id) ? p.parent_id : null;
      m.set(key, [...(m.get(key) ?? []), p]);
    }
    return m;
  }, [pages, byId]);
  const dbsOf = useMemo(() => {
    const m = new Map<string, UdbMeta[]>();
    for (const d of udbs) {
      if (d.page_id && byId.has(d.page_id)) {
        m.set(d.page_id, [...(m.get(d.page_id) ?? []), d]);
      }
    }
    return m;
  }, [udbs, byId]);
  const looseDbs = udbs.filter((d) => !d.page_id || !byId.has(d.page_id));

  const { live } = useAgents();
  const due = useDue();
  const liveCounts = useMemo(() => {
    const m = new Map<string, LiveCount>();
    for (const { a, state } of live) {
      // one count per agent per page, even when it links several todos below it
      const seen = new Map<string, boolean>(); // page id -> own (directly linked)
      for (const l of a.page_id ? [{ page_id: a.page_id }] : a.links) {
        let own = true;
        for (let p = byId.get(l.page_id); p; p = p.parent_id ? byId.get(p.parent_id) : undefined) {
          seen.set(p.id, (seen.get(p.id) ?? false) || own);
          own = false;
        }
      }
      for (const [id, own] of seen) {
        const c = m.get(id) ?? { working: 0, waiting: 0, own: false };
        c[state]++;
        c.own ||= own;
        m.set(id, c);
      }
    }
    return m;
  }, [live, byId]);
  const runningRef = useRef<HTMLDivElement>(null);

  // the whole tree by mtime — sliced short/long at render
  const recentsOpen = expanded.has(RECENTS_KEY);
  const recents = useMemo(() => recentRows(pages), [pages]);

  // opening a deep page (deep link, subpage nav) expands its ancestors
  useEffect(() => {
    if (!pageId) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (
        let p = byId.get(pageId);
        p;
        p = p.parent_id ? byId.get(p.parent_id) : undefined
      ) {
        if (p.parent_id) next.add(p.parent_id);
        // an archived hop hides behind its parent's fold — open that too
        if (p.status === "archived") {
          next.add(`archived:${p.parent_id ?? "root"}`);
        }
      }
      return next;
    });
  }, [pageId, byId, setExpanded]);

  const onToggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // drag a page row onto a project/story (or the UNFILED zone) to re-file it
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const [dragId, setDragId] = useState<string | null>(null);
  const lastDragEnd = useRef(0);
  // suppress the click that fires right after a drop
  const openGuarded = (id: string) => {
    if (Date.now() - lastDragEnd.current > 250) onOpenPage(id);
  };
  const onDragStart = (e: DragStartEvent) => setDragId(String(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setDragId(null);
    lastDragEnd.current = Date.now();
    if (!e.over) return;
    const id = String(e.active.id);
    const page = byId.get(id);
    if (!page) return;
    const target = e.over.id === "unfiled"
      ? null
      : String(e.over.id).slice("drop:".length);
    if (target === (page.parent_id ?? null)) return; // already there
    if (target) {
      // droppables stay live for the hover state — enforce what accepts what here:
      // pages land on any node, stories only on projects
      const tk = byId.get(target)?.kind;
      if (tk !== "project" && page.kind !== "page") return;
      // cycle guard — server rejects too, this just skips the round-trip
      for (
        let a = byId.get(target);
        a;
        a = a.parent_id ? byId.get(a.parent_id) : undefined
      ) {
        if (a.id === id) return;
      }
      setExpanded((prev) => new Set(prev).add(target)); // reveal landing spot
    }
    onMovePage(id, target);
  };
  const dragged = dragId ? byId.get(dragId) : undefined;
  const rootsOwn = splitArchived(
    (childrenOf.get(null) ?? []).filter((p) =>
      p.kind === "project" && !isSharedIn(p, meId)
    ),
    starred,
  );
  const renderRoot = (p: PageMeta) => (
    <PageNode
      key={p.id}
      p={p}
      depth={0}
      childrenOf={childrenOf}
      dbsOf={dbsOf}
      expanded={expanded}
      onToggle={onToggle}
      current={view === "page" ? pageId : null}
      currentDb={view === "database" ? dbId : null}
      onOpenPage={openGuarded}
      onOpenDb={onOpenDb}
      onNewChild={(id) => onNewPage(id)}
      onStar={toggleStar}
      starred={starred}
      meId={meId}
    />
  );

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
    <LiveCounts.Provider value={liveCounts}>
    <aside className="flex shrink-0 bg-sidebar">
      <Rail
        view={view}
        pluginId={pluginId}
        plugins={plugins}
        onNav={onNav}
        onOpenPlugin={onOpenPlugin}
        status={status}
        onSettings={onSettings}
        update={update}
        updateState={updateState}
        onUpdate={onUpdate}
        sidebar={bare ? null : !hidden}
        onToggleSidebar={onToggleHidden}
      />
      <div className={`flex-col border-r border-line ${bare || hidden ? "hidden" : "flex"} ${wide ? "w-[320px]" : "w-[240px]"}`}>
      {/* the rail marks the view; the column keeps the app's name, like Codex */}
      <div className="flex h-12 shrink-0 items-center gap-2.5 px-5">
        <span className="text-[15px] font-semibold">Trame</span>
        {status?.debug && (
          <span className="text-[10px] font-medium uppercase text-[#5b8fd6]" title={`built ${BUILD_TIME.toLocaleString()}`}>
            debug
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 pb-3">
      {column ?? (
      <>
      <div ref={runningRef}>
        <WorkingNow board={board} onOpenSession={onOpenSession} onOpenTerminals={onOpenTerminals} onOpenPage={onOpenPage} />
      </div>
      {due.length > 0 && <DueList due={due} board={board} onOpenPage={onOpenPage} onOpenTerminals={onOpenTerminals} />}
      {recents.length > 0 && (
        <>
          {/* a landmark, so the rows are addressable apart from STARRED's identical ones */}
          <nav aria-label="Recently modified" className="flex flex-col gap-1">
<div className={`flex px-2 pb-1.5 pt-4 ${SECTION_LABEL}`}>
            <FoldLabel folded={recentsFolded} onToggle={() => setRecentsFolded((f) => !f)}>RECENTLY MODIFIED</FoldLabel>
          </div>
          {!recentsFolded && recents.slice(0, recentsOpen ? RECENTS_LONG : RECENTS_SHORT).map((row) => {
            // a bulk edit collapses to its parent, labelled with the page count
            const p = row.kind === "page" ? row.page : byId.get(row.parentId);
            if (!p) return null;
            const count = row.kind === "group" ? row.pages.length : 0;
            const at = row.kind === "group" ? row.pages[0].updated_at : p.updated_at;
            const active = view === "page" && p.id === pageId;
            const path: string[] = [];
            for (let a = byId.get(p.parent_id ?? ""); a; a = byId.get(a.parent_id ?? "")) path.unshift(a.title);
            return (
              <button
                type="button"
                key={row.kind === "group" ? `group:${row.pages[0].id}` : p.id}
                onClick={() => onOpenPage(p.id)}
                title={[...path, p.title].join(" / ") + (count ? ` · ${count} pages changed` : "")}
                className={`flex items-center gap-1.5 rounded-md py-[5px] pl-[22px] pr-1 text-left text-[13px] ${
                  active ? "bg-active-row font-medium text-ink" : "text-ink-muted hover:text-ink-soft"
                }`}
              >
                <span className={`text-[12px] ${active ? "text-copper" : ""}`}>
                  <EntityIcon icon={p.icon} fallback={pageGlyph(p.kind, p.mark_role)} />
                </span>
                <span className="flex-1 truncate">{p.title || "Untitled"}</span>
                <LiveMarker id={p.id} />
                {count > 0 && (
                  <span className="shrink-0 rounded-full bg-copper/15 px-1.5 text-[10px] font-medium text-copper">
                    {count}
                  </span>
                )}
                <span className="shrink-0 text-[10.5px] text-ink-muted/60">{timeAgo(at)}</span>
              </button>
            );
          })}
          </nav>
          {!recentsFolded && recents.length > RECENTS_SHORT && (
            <button
              type="button"
              onClick={() => onToggle(RECENTS_KEY)}
              className="flex items-center gap-1 rounded-md py-[5px] pl-2 pr-1 text-left text-[12px] text-ink-muted/70 hover:text-ink-soft"
            >
              <span className="w-[14px] shrink-0 text-[9px]">{recentsOpen ? "▾" : "▸"}</span>
              {recentsOpen ? "Show less" : "Show more"}
            </button>
          )}
        </>
      )}
      {/* one tree, three root sections: projects (what sessions ladder up to),
          pages shared in by other users, and unfiled pages (the inbox to triage) */}
      {[...starred].some((id) => byId.has(id)) && (
        <>
<div className={`flex px-2 pb-1.5 pt-4 ${SECTION_LABEL}`}>
            <FoldLabel folded={starredFolded} onToggle={() => setStarredFolded((f) => !f)}>STARRED</FoldLabel>
          </div>
          {!starredFolded && [...starred].flatMap((id) => byId.get(id) ?? []).map((p) => {
            const active = view === "page" && p.id === pageId;
            const path: string[] = [];
            for (let a = byId.get(p.parent_id ?? ""); a; a = byId.get(a.parent_id ?? "")) path.unshift(a.title);
            return (
              <button
                type="button"
                key={p.id}
                onClick={() => onOpenPage(p.id)}
                title={[...path, p.title].join(" / ")}
                className={`group flex items-center gap-1.5 rounded-md py-[5px] pl-[22px] pr-1 text-left text-[13px] ${
                  active ? "bg-active-row font-medium text-ink" : "text-ink-muted hover:text-ink-soft"
                }`}
              >
                <span className={`text-[12px] ${active ? "text-copper" : ""}`}>
                  <EntityIcon icon={p.icon} fallback={pageGlyph(p.kind, p.mark_role)} />
                </span>
                <span className="flex-1 truncate">{p.title || "Untitled"}</span>
                <span
                  className="hidden px-1 text-[11px] text-copper group-hover:block"
                  title="unstar"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleStar(p.id);
                  }}
                >
                  ★
                </span>
              </button>
            );
          })}
        </>
      )}
      <div className={`flex px-2 pb-1.5 pt-4 ${SECTION_LABEL}`}>
        <FoldLabel folded={projectsFolded} onToggle={() => setProjectsFolded((f) => !f)}>PROJECTS</FoldLabel>
      </div>
      {!projectsFolded && rootsOwn.normal.map(renderRoot)}
      {!projectsFolded && rootsOwn.archived.length > 0 && (
        <ArchivedFold
          parentKey="root"
          kids={rootsOwn.archived}
          depth={0}
          expanded={expanded}
          onToggle={onToggle}
          node={renderRoot}
        />
      )}
      {!projectsFolded && <NewChip label="New project" indent={26} onClick={onNewProject} />}
      {(childrenOf.get(null) ?? []).some((p) => isSharedIn(p, meId)) && (
        <>
<div className={`flex px-2 pb-1.5 pt-4 ${SECTION_LABEL}`}>
            <FoldLabel folded={sharedFolded} onToggle={() => setSharedFolded((f) => !f)}>SHARED WITH ME</FoldLabel>
          </div>
          {!sharedFolded && (childrenOf.get(null) ?? []).filter((p) => isSharedIn(p, meId)).map(
            (p) => (
              <PageNode
                key={p.id}
                p={p}
                depth={0}
                childrenOf={childrenOf}
                dbsOf={dbsOf}
                expanded={expanded}
                onToggle={onToggle}
                current={view === "page" ? pageId : null}
                currentDb={view === "database" ? dbId : null}
                onOpenPage={openGuarded}
                onOpenDb={onOpenDb}
                onNewChild={(id) => onNewPage(id)}
                onStar={toggleStar}
                starred={starred}
                meId={meId}
              />
            ),
          )}
        </>
      )}
      <UnfiledZone>
        <div className={`flex px-2 pb-1.5 pt-4 ${SECTION_LABEL}`}>
          <FoldLabel folded={unfiledFolded} onToggle={() => setUnfiledFolded((f) => !f)}>UNFILED</FoldLabel>
        </div>
        {!unfiledFolded && (childrenOf.get(null) ?? []).filter((p) =>
          // a story with no project is triage too: drag it onto a project to file it
          (p.kind === "page" || p.kind === "story") && !isSharedIn(p, meId)
        ).map((
          p,
        ) => (
          <PageNode
            key={p.id}
            p={p}
            depth={0}
            childrenOf={childrenOf}
            dbsOf={dbsOf}
            expanded={expanded}
            onToggle={onToggle}
            current={view === "page" ? pageId : null}
            currentDb={view === "database" ? dbId : null}
            onOpenPage={openGuarded}
            onOpenDb={onOpenDb}
            onNewChild={(id) => onNewPage(id)}
            onStar={toggleStar}
            starred={starred}
            meId={meId}
          />
        ))}
        {!unfiledFolded && (
        <div className="flex flex-wrap items-center gap-1.5">
          <NewChip label="New page" indent={26} onClick={() => onNewPage(null)} />
          <NewChip label="Import" indent={9} onClick={onImportPage} />
        </div>
        )}
      </UnfiledZone>
      <div className={`flex px-2 pb-1.5 pt-4 ${SECTION_LABEL}`}>
        <FoldLabel folded={dbsFolded} onToggle={() => setDbsFolded((f) => !f)}>DATABASES</FoldLabel>
      </div>
      {!dbsFolded && looseDbs.map((d) => {
        const active = view === "database" && d.id === dbId;
        return (
          <button
            type="button"
            key={d.id}
            onClick={() => onOpenDb(d.id)}
            // pl-[26px]: align the ⌗ with the ◎/□ glyph column of the tree sections above
            className={`flex items-center gap-1.5 rounded-md py-[7px] pl-[26px] pr-2 text-left text-[13.5px] ${
              active
                ? "bg-active-row font-medium text-ink"
                : "text-ink-muted hover:text-ink-soft"
            }`}
          >
            <span className={`text-[13px] ${active ? "text-copper" : ""}`}>
              <EntityIcon icon={d.icon} fallback="⌗" />
            </span>
            <span className="flex-1 truncate">{d.name}</span>
            <span className="text-[10.5px] text-ink-muted/60">
              {d.row_count || ""}
            </span>
          </button>
        );
      })}
      {!dbsFolded && <NewChip label="New database" indent={26} onClick={onNewDb} />}
      </>
      )}
      </div>
      {!column && live.length > 0 && (
        <button
          type="button"
          title="show the running agents"
          // one status block with the sync line below: same inset, dot and type
          className="flex shrink-0 items-center gap-3 border-t border-line px-5 py-2 text-[11.5px] text-ink-muted hover:text-ink"
          onClick={() => runningRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
        >
          {(["working", "waiting"] as const).map((st) => {
            const n = live.filter((l) => l.state === st).length;
            return n > 0 && (
              <span key={st} className="inline-flex items-center gap-2">
                <PresenceDot state={st} size="md" />
                {n} {st === "working" ? "working" : "needs you"}
              </span>
            );
          })}
        </button>
      )}
      </div>
    </aside>
    </LiveCounts.Provider>
    <DragOverlay>
      {dragged && (
        <div className="flex w-fit items-center gap-1.5 rounded-md border border-line bg-sidebar px-2 py-1 text-[13px] shadow-lg">
          <EntityIcon icon={dragged.icon} fallback={pageGlyph(dragged.kind, dragged.mark_role)} />
          <span className="max-w-[200px] truncate">
            {dragged.title || "Untitled"}
          </span>
        </div>
      )}
    </DragOverlay>
    </DndContext>
  );
}
