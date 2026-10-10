import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { DndContext, DragOverlay, type DragEndEvent, type DragStartEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { type AppStatus, getIdentity, type PageMeta, type PluginManifest, type UdbMeta, type UpdateInfo } from "../api";
import { AgentIcon, Elapsed, useAgents } from "../agents/agents";
import { stripMarks } from "../../../../core/todo-marks.ts";
import { DUE_TONE_CLS, dueLabel, dueTone, focusBlock, useDue } from "../ui/due";
import { recentRows } from "./recents";
import { GearIcon, LogoMark } from "../ui/icons";
import type { View } from "./view";
import { ArchivedFold, isSharedIn, type LiveCount, LiveCounts, LiveMarker, PageNode, RECENTS_KEY, RECENTS_LONG, RECENTS_SHORT, splitArchived, TreeCardsCtx, UnfiledZone } from "./sidebar-tree";
import { SET_CODEC, useLocalStorage, EntityIcon, pageGlyph, SECTION_LABEL, timeAgo, PresenceDot } from "../ui/ui";

const NAV: {
  key: "sessions" | "agents" | "explore";
  glyph: string;
  label: string;
  view: View;
}[] = [
  { key: "sessions", glyph: "▦", label: "Sessions", view: "board" },
  { key: "agents", glyph: "↻", label: "AI Sessions", view: "agents" },
  { key: "explore", glyph: "✦", label: "Explore", view: "explore" },
];

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
  },
) {
  const activeKey = view === "board" || view === "list" ? "sessions" : view;
  const synced = status?.remote && status.lastSync;
  // my user id (null in dev / before hub login) — used to split off shared-in roots
  const [meId, setMeId] = useState<string | null>(null);
  useEffect(() => {
    getIdentity().then((i) => setMeId(i.userId)).catch(() => {});
  }, []);
  const [expanded, setExpanded] = useLocalStorage("trame:expanded", new Set<string>(), SET_CODEC);

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
  const treeCards = useContext(TreeCardsCtx);
  const due = useDue();
  const lateCount = due.filter((d) => dueTone(d.due) === "late").length;
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
  const runningRef = useRef<HTMLElement>(null);

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
  }, [pageId, byId]);

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
    <aside className="flex w-[240px] shrink-0 flex-col border-r border-line bg-sidebar">
      {/* Seule la liste défile : le statut de synchro et l'accès aux réglages
          restent visibles, sinon il faut dérouler tout l'arbre pour les
          atteindre. */}
      <div className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 pb-3 pt-4">
      <div className="mb-3 flex items-center gap-2.5 px-2">
        <LogoMark />
        <span className="text-[15px] font-semibold">Trame</span>
      </div>
      <div className={`px-2 pb-1.5 pt-0.5 ${SECTION_LABEL}`}>
        VIEWS
      </div>
      {NAV.map((item) => {
        const active = item.key === activeKey;
        return (
          <button
            type="button"
            key={item.key}
            onClick={() => onNav(item.view)}
            className={`flex items-center gap-2.5 rounded-md px-2 py-[7px] text-left text-[13.5px] ${
              active
                ? "bg-active-row font-medium text-ink"
                : "text-ink-muted hover:text-ink-soft"
            }`}
          >
            <span className={`text-[13px] ${active ? "text-copper" : ""}`}>
              {item.glyph}
            </span>
            {item.label}
            {item.key === "agents" && live.length > 0 && (
              <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-chipline px-1.5 text-[10.5px] font-medium text-ink-soft">
                <PresenceDot state="working" />
                {live.length} live
              </span>
            )}
          </button>
        );
      })}
      {plugins.filter((p) => p.enabled).map((p) => {
        const active = view === "plugin" && p.id === pluginId;
        return (
          <button
            type="button"
            key={p.id}
            onClick={() => onOpenPlugin(p.id)}
            className={`flex items-center gap-2.5 rounded-md px-2 py-[7px] text-left text-[13.5px] ${
              active
                ? "bg-active-row font-medium text-ink"
                : "text-ink-muted hover:text-ink-soft"
            }`}
          >
            <span className={`text-[13px] ${active ? "text-copper" : ""}`}>
              {p.glyph}
            </span>
            {p.label}
            {p.badge != null && p.badge > 0 && (
              <span className="ml-auto rounded-full bg-copper/15 px-1.5 py-0.5 text-[10px] font-medium text-copper">
                {p.badge}
              </span>
            )}
          </button>
        );
      })}
      {live.length > 0 && (
        <nav ref={runningRef} aria-label="Running agents" className="flex flex-col gap-0.5">
          <div className={`px-2 pb-1.5 pt-4 ${SECTION_LABEL}`}>
            RUNNING
          </div>
          {live.map(({ a, state }) => {
            const link = a.links.find((l) => a.block_id ? l.block_id === a.block_id : l.block_id) ?? a.links[0];
            const what = (link?.anchor && stripMarks(link.anchor).trim()) || a.session_title;
            return (
              <button
                type="button"
                key={a.session_id}
                disabled={!link}
                onClick={() => link && onOpenPage(link.page_id)}
                title={`${a.harness} · ${a.session_title}${link ? ` — ${link.page_title}` : ""}`}
                className={`grid grid-cols-[auto_1fr_auto] items-center gap-x-2 rounded-md px-2 py-[5px] text-left hover:bg-active-row ${
                  state === "waiting" ? "bg-wait/[0.1]" : ""
                }`}
              >
                <AgentIcon a={a} />
                <span className="truncate text-[13px] text-ink">{what}</span>
                <span className="font-mono text-[10.5px] font-semibold tabular-nums text-ink-soft">
                  <Elapsed since={a.since} state={state} />
                </span>
                <span
                  className={`col-span-2 col-start-2 truncate text-[11.5px] ${
                    state === "waiting" ? "italic text-ink-soft" : "text-ink-muted"
                  }`}
                >
                  {state === "waiting" ? `needs you: ${a.question ?? "waiting for input"}` : link?.page_title ?? "no linked todo"}
                </span>
              </button>
            );
          })}
        </nav>
      )}
      {due.length > 0 && (
        <nav aria-label="Due todos" className="flex flex-col gap-0.5">
          <div className={`flex items-center px-2 pb-1.5 pt-4 ${SECTION_LABEL}`}>
            DUE
            <span
              className={`ml-auto rounded-full px-1.5 text-[10.5px] tracking-normal tabular-nums ${
                lateCount ? DUE_TONE_CLS.late : DUE_TONE_CLS.later
              }`}
            >
              {lateCount ? `${lateCount} late · ${due.length}` : due.length}
            </span>
          </div>
          {due.map((d) => {
            const tone = dueTone(d.due);
            return (
              <button
                type="button"
                key={`${d.page_id}:${d.block_id ?? d.text}`}
                onClick={() => {
                  if (d.block_id) focusBlock(d.block_id);
                  if (d.card_id) treeCards.open(d.card_id);
                  else onOpenPage(d.page_id);
                }}
                title={`${d.text} — ${d.page_title}`}
                className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 rounded-md px-2 py-[5px] text-left hover:bg-active-row"
              >
                <span className={tone === "late" ? "text-blocked" : tone === "soon" ? "text-wait" : "text-ink-faint"}>⚑</span>
                <span className="truncate text-[13px] text-ink">{d.text}</span>
                <span
                  className={`whitespace-nowrap text-[11px] tabular-nums ${
                    tone === "late" ? "text-blocked" : tone === "soon" ? "text-wait" : "text-ink-faint"
                  }`}
                >
                  {dueLabel(d.due)}
                </span>
              </button>
            );
          })}
        </nav>
      )}
      {recents.length > 0 && (
        <>
          {/* a landmark, so the rows are addressable apart from STARRED's identical ones */}
          <nav aria-label="Recently modified" className="flex flex-col gap-1">
          <div className={`px-2 pb-1.5 pt-4 ${SECTION_LABEL}`}>
            RECENTLY MODIFIED
          </div>
          {recents.slice(0, recentsOpen ? RECENTS_LONG : RECENTS_SHORT).map((row) => {
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
          {recents.length > RECENTS_SHORT && (
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
          <div className={`px-2 pb-1.5 pt-4 ${SECTION_LABEL}`}>
            STARRED
          </div>
          {[...starred].flatMap((id) => byId.get(id) ?? []).map((p) => {
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
      <div className={`px-2 pb-1.5 pt-4 ${SECTION_LABEL}`}>
        PROJECTS
      </div>
      {rootsOwn.normal.map(renderRoot)}
      {rootsOwn.archived.length > 0 && (
        <ArchivedFold
          parentKey="root"
          kids={rootsOwn.archived}
          depth={0}
          expanded={expanded}
          onToggle={onToggle}
          node={renderRoot}
        />
      )}
      <NewChip label="New project" indent={26} onClick={onNewProject} />
      {(childrenOf.get(null) ?? []).some((p) => isSharedIn(p, meId)) && (
        <>
          <div className={`px-2 pb-1.5 pt-4 ${SECTION_LABEL}`}>
            SHARED WITH ME
          </div>
          {(childrenOf.get(null) ?? []).filter((p) => isSharedIn(p, meId)).map(
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
        <div className={`px-2 pb-1.5 pt-4 ${SECTION_LABEL}`}>
          UNFILED
        </div>
        {(childrenOf.get(null) ?? []).filter((p) =>
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
        <div className="flex flex-wrap items-center gap-1.5">
          <NewChip label="New page" indent={26} onClick={() => onNewPage(null)} />
          <NewChip label="Import" indent={9} onClick={onImportPage} />
        </div>
      </UnfiledZone>
      <div className={`px-2 pb-1.5 pt-4 ${SECTION_LABEL}`}>
        DATABASES
      </div>
      {looseDbs.map((d) => {
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
      <NewChip label="New database" indent={26} onClick={onNewDb} />
      </div>
      {live.length > 0 && (
        <button
          type="button"
          title="show the running agents"
          // one status block with the sync line below: same inset, dot and type
          className="flex shrink-0 items-center gap-3 border-t border-line px-5 pt-2 text-[11.5px] text-ink-muted hover:text-ink"
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
      <div
        className={`flex shrink-0 items-center gap-2 px-5 text-[11.5px] text-ink-muted ${
          live.length > 0 ? "pb-2 pt-1.5" : "border-t border-line py-2"
        }`}
      >
        <span
          className="h-[7px] w-[7px] rounded-full"
          style={{
            background: synced ? "var(--color-active)" : "var(--color-done)",
          }}
        />
        <span className="flex-1">
          {status
            ? status.remote
              ? status.lastSync ? `Synced · ${status.nodeId}` : "Sync pending…"
              : `Local only · ${status.nodeId}`
            : "…"}
        </span>
        {(update?.available || update?.applied) && (
          <button
            type="button"
            className="rounded bg-copper/15 px-1.5 py-0.5 text-[10.5px] font-medium text-copper hover:bg-copper/25 disabled:opacity-60"
            title={updateState === "done"
              ? "updated — restart Trame to finish"
              : update.canSelfUpdate
              ? `update to v${update.latest} in place`
              : `v${update.latest} available — open the release page`}
            disabled={updateState === "busy"}
            onClick={onUpdate}
          >
            {updateState === "done"
              ? "↻ restart"
              : updateState === "busy"
              ? "…"
              : `↑ v${update.latest}`}
          </button>
        )}
        <button
          type="button"
          className="text-ink-muted hover:text-ink-soft"
          title="Settings"
          onClick={onSettings}
        >
          <GearIcon />
        </button>
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
