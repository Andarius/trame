import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyUpdate,
  type AppStatus,
  type BoardData,
  createPage,
  createUdb,
  createUdbRow,
  deleteUdb,
  getBoard,
  getStatus,
  getUpdate,
  listPages,
  openInBrowser,
  listUdbs,
  type PageMeta,
  setStatus as apiSetStatus,
  type Status,
  syncNow,
  type UdbMeta,
  type UpdateInfo,
  updateUdb,
} from "./api";
import { Board } from "./Board";
import { Drawer } from "./Drawer";
import { Explore } from "./Explore";
import { List } from "./List";
import { ImportClaudeModal, NewSessionModal, NewUdbModal, SettingsModal } from "./modals";
import { confirmDeletePage, Page } from "./Page";
import { ClientView } from "./ClientView";
import { appConfirm, ConfirmHost, EntityIcon, Popover } from "./ui";
import { IconPicker } from "./udb/cells";
import { DatabaseView } from "./udb/DatabaseTable";

type View = "board" | "list" | "explore" | "database" | "page" | "client";

const post = (path: string, body: unknown) =>
  fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// inline SVG with hardcoded colors — the span version relied on the --color-copper
// var and color-mix opacity, one of which the Linux WebKitGTK webview drops (logo
// rendered invisible). SVG with literal hex is bulletproof across both webviews.
function LogoMark() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true" className="shrink-0">
      <rect width="26" height="26" rx="7" fill="#c98a63" />
      <rect x="6" y="11" width="14" height="3.5" rx="1.75" fill="#120e0b" fillOpacity="0.85" />
      <rect x="11.5" y="6" width="3.5" height="14" rx="1.75" fill="#120e0b" fillOpacity="0.55" />
    </svg>
  );
}

function GroupIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="4" rx="1" />
      <rect x="2" y="9.5" width="12" height="4" rx="1" />
    </svg>
  );
}

// inline SVG (not a glyph): the Unicode gear renders as a colored emoji on WKWebView
// and as tofu with the FE0E text selector on WebKitGTK — neither is acceptable
function GearIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

const NAV: { key: "sessions" | "explore"; glyph: string; label: string; view: View }[] = [
  { key: "sessions", glyph: "▦", label: "Sessions", view: "board" },
  { key: "explore", glyph: "✦", label: "Explore", view: "explore" },
];

const pageGlyph = (kind: string) => (kind === "project" ? "◎" : kind === "story" ? "◇" : "□");

// "New …" affordance under a sidebar section — a subtle dashed chip. `indent` is
// the x of the section's icon column (tree rows: 26 = 8px pad + 14px chevron + 4px
// gap; flat rows: 8); the chip shifts by its own padding+border so the ＋ lines up.
function NewChip({ label, indent, onClick }: { label: string; indent: number; onClick: () => void }) {
  return (
    <button type="button"
      className="mt-0.5 flex w-fit items-center gap-1.5 rounded-md border border-dashed border-chipline px-2 py-1 text-[12px] text-ink-muted/70 hover:border-copper/60 hover:text-copper"
      style={{ marginLeft: indent - 9 }}
      onClick={onClick}
    >
      <span className="text-[11px]">＋</span> {label}
    </button>
  );
}

function PageNode(
  { p, depth, childrenOf, dbsOf, expanded, onToggle, current, currentDb, onOpenPage, onOpenDb, onNewChild }: {
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
  },
) {
  const kids = childrenOf.get(p.id) ?? [];
  const dbs = dbsOf.get(p.id) ?? [];
  const hasKids = kids.length + dbs.length > 0;
  const open = expanded.has(p.id);
  const active = p.id === current;
  return (
    <>
      <div
        className={`group flex items-center gap-1 rounded-md py-[5px] pr-1 text-left text-[13px] ${
          active ? "bg-[#1a1d26] font-medium text-ink" : "text-ink-muted hover:text-ink-soft"
        }`}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        <button type="button"
          className={`w-[14px] shrink-0 text-[9px] ${hasKids ? "text-ink-muted/70 hover:text-ink" : "text-transparent"}`}
          onClick={() => hasKids && onToggle(p.id)}
          tabIndex={hasKids ? 0 : -1}
        >
          {open ? "▾" : "▸"}
        </button>
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5" onClick={() => onOpenPage(p.id)}>
          <span
            className={`text-[12px] ${active && !(p.kind === "project" && p.color) ? "text-copper" : ""}`}
            style={p.kind === "project" && p.color ? { color: p.color } : undefined}
          >
            <EntityIcon icon={p.icon} fallback={pageGlyph(p.kind)} />
          </span>
          <span className={`truncate ${p.title ? "" : "italic text-ink-muted/60"}`}>{p.title || "Untitled"}</span>
        </button>
        <button type="button"
          className="hidden shrink-0 rounded px-1 text-[12px] text-ink-muted hover:text-ink group-hover:block"
          title="new sub-page"
          onClick={() => onNewChild(p.id)}
        >
          ＋
        </button>
      </div>
      {open && dbs.map((d) => {
        const dbActive = d.id === currentDb;
        return (
          <button type="button"
            key={d.id}
            onClick={() => onOpenDb(d.id)}
            className={`flex items-center gap-1.5 rounded-md py-[5px] pr-2 text-left text-[13px] ${
              dbActive ? "bg-[#1a1d26] font-medium text-ink" : "text-ink-muted hover:text-ink-soft"
            }`}
            style={{ paddingLeft: 8 + (depth + 1) * 14 + 14 }}
          >
            <span className={`text-[12px] ${dbActive ? "text-copper" : ""}`}>
              <EntityIcon icon={d.icon} fallback="⌗" />
            </span>
            <span className="flex-1 truncate">{d.name}</span>
            <span className="text-[10.5px] text-ink-muted/60">{d.row_count || ""}</span>
          </button>
        );
      })}
      {open && kids.map((k) => (
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
        />
      ))}
    </>
  );
}

function Sidebar(
  { view, onNav, status, onSettings, pages, pageId, onOpenPage, onNewPage, onNewProject, udbs, dbId, onOpenDb, onNewDb, update, updateState, onUpdate }: {
    view: View;
    onNav: (v: View) => void;
    status: AppStatus | null;
    onSettings: () => void;
    pages: PageMeta[];
    pageId: string | null;
    onOpenPage: (id: string) => void;
    onNewPage: (parentId: string | null) => void;
    onNewProject: () => void;
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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
      if (d.page_id && byId.has(d.page_id)) m.set(d.page_id, [...(m.get(d.page_id) ?? []), d]);
    }
    return m;
  }, [udbs, byId]);
  const looseDbs = udbs.filter((d) => !d.page_id || !byId.has(d.page_id));

  // opening a deep page (deep link, subpage nav) expands its ancestors
  useEffect(() => {
    if (!pageId) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (let p = byId.get(pageId); p?.parent_id; p = byId.get(p.parent_id)) next.add(p.parent_id);
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

  return (
    <aside className="flex w-[240px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-line bg-sidebar px-3 pb-3 pt-4">
      <div className="mb-3 flex items-center gap-2.5 px-2">
        <LogoMark />
        <span className="text-[15px] font-semibold">Trame</span>
      </div>
      <div className="px-2 pb-1.5 pt-0.5 text-[10.5px] font-medium tracking-[0.8px] text-ink-muted/70">
        VIEWS
      </div>
      {NAV.map((item) => {
        const active = item.key === activeKey;
        return (
          <button type="button"
            key={item.key}
            onClick={() => onNav(item.view)}
            className={`flex items-center gap-2.5 rounded-md px-2 py-[7px] text-left text-[13.5px] ${
              active ? "bg-[#1a1d26] font-medium text-ink" : "text-ink-muted hover:text-ink-soft"
            }`}
          >
            <span className={`text-[13px] ${active ? "text-copper" : ""}`}>{item.glyph}</span>
            {item.label}
          </button>
        );
      })}
      {/* one tree, two root sections: projects (what sessions ladder up to) vs plain pages */}
      <div className="px-2 pb-1.5 pt-4 text-[10.5px] font-medium tracking-[0.8px] text-ink-muted/70">
        PROJECTS
      </div>
      {(childrenOf.get(null) ?? []).filter((p) => p.kind === "project" || p.kind === "story").map((p) => (
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
          onOpenPage={onOpenPage}
          onOpenDb={onOpenDb}
          onNewChild={(id) => onNewPage(id)}
        />
      ))}
      <NewChip label="New project" indent={26} onClick={onNewProject} />
      <div className="px-2 pb-1.5 pt-4 text-[10.5px] font-medium tracking-[0.8px] text-ink-muted/70">
        PAGES
      </div>
      {(childrenOf.get(null) ?? []).filter((p) => p.kind === "page").map((p) => (
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
          onOpenPage={onOpenPage}
          onOpenDb={onOpenDb}
          onNewChild={(id) => onNewPage(id)}
        />
      ))}
      <NewChip label="New page" indent={26} onClick={() => onNewPage(null)} />
      <div className="px-2 pb-1.5 pt-4 text-[10.5px] font-medium tracking-[0.8px] text-ink-muted/70">
        DATABASES
      </div>
      {looseDbs.map((d) => {
        const active = view === "database" && d.id === dbId;
        return (
          <button type="button"
            key={d.id}
            onClick={() => onOpenDb(d.id)}
            // pl-[26px]: align the ⌗ with the ◎/□ glyph column of the tree sections above
            className={`flex items-center gap-1.5 rounded-md py-[7px] pl-[26px] pr-2 text-left text-[13.5px] ${
              active ? "bg-[#1a1d26] font-medium text-ink" : "text-ink-muted hover:text-ink-soft"
            }`}
          >
            <span className={`text-[13px] ${active ? "text-copper" : ""}`}>
              <EntityIcon icon={d.icon} fallback="⌗" />
            </span>
            <span className="flex-1 truncate">{d.name}</span>
            <span className="text-[10.5px] text-ink-muted/60">{d.row_count || ""}</span>
          </button>
        );
      })}
      <NewChip label="New database" indent={26} onClick={onNewDb} />
      <div className="flex-1" />
      <div className="flex items-center gap-2 px-2 py-2 text-[11.5px] text-ink-muted">
        <span
          className="h-[7px] w-[7px] rounded-full"
          style={{ background: synced ? "var(--color-active)" : "var(--color-done)" }}
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
            {updateState === "done" ? "↻ restart" : updateState === "busy" ? "…" : `↑ v${update.latest}`}
          </button>
        )}
        <button type="button" className="text-ink-muted hover:text-ink-soft" title="Settings" onClick={onSettings}>
          <GearIcon />
        </button>
      </div>
    </aside>
  );
}

export function App() {
  const params = new URLSearchParams(location.search);
  const [board, setBoard] = useState<BoardData | null>(null);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [view, setView] = useState<View>((params.get("view") as View) ?? "board");
  const [group, setGroup] = useState<"none" | "story" | "project">(() => {
    const g = params.get("group");
    return g === "story" || g === "objective" ? "story" : g === "project" ? "project" : "none";
  });
  const [groupMenu, setGroupMenu] = useState(false);
  const [storyFilter, setStoryFilter] = useState<string | null>(null); // narrow sessions to one story
  const [modal, setModal] = useState<"session" | "settings" | "udb" | "import" | null>(
    (params.get("new") as "session" | "settings" | "udb" | "import" | null) ?? null,
  );
  const [openId, setOpenId] = useState<string | null>(params.get("session"));
  const [exploreEpoch, setExploreEpoch] = useState(0); // bump to rescan files after settings change
  const [udbs, setUdbs] = useState<UdbMeta[]>([]);
  const [pages, setPages] = useState<PageMeta[]>([]);
  const [dbId, setDbId] = useState<string | null>(params.get("db"));
  const [pageId, setPageId] = useState<string | null>(params.get("page"));
  const [clientId, setClientId] = useState<string | null>(params.get("client"));
  const [udbEpoch, setUdbEpoch] = useState(0); // bump to refetch the open database view
  const [dbIconOpen, setDbIconOpen] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateState, setUpdateState] = useState<"idle" | "busy" | "done">("idle");
  const [updateDismissed, setUpdateDismissed] = useState(false);

  const refresh = () => {
    getBoard().then(setBoard).catch(() => {});
    getStatus().then(setStatus).catch(() => {});
    listUdbs().then((d) => Array.isArray(d) && setUdbs(d)).catch(() => {});
    listPages().then((d) => Array.isArray(d) && setPages(d)).catch(() => {});
  };

  // "Sync now" is otherwise silent when nothing moves (0↓0↑) — flash the result so it reads as alive
  const [syncing, setSyncing] = useState(false);
  const [syncFlash, setSyncFlash] = useState<string | null>(null);
  const syncFlashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const doSync = async () => {
    if (syncing) return;
    setSyncing(true);
    let msg: string;
    try {
      const r = await syncNow();
      refresh();
      msg = r ? (r.pulled || r.pushed ? `${r.pulled}↓ ${r.pushed}↑` : "up to date") : "offline";
    } catch {
      msg = "failed";
    } finally {
      setSyncing(false);
    }
    setSyncFlash(msg);
    clearTimeout(syncFlashTimer.current);
    syncFlashTimer.current = setTimeout(() => setSyncFlash(null), 2500);
  };
  useEffect(() => () => clearTimeout(syncFlashTimer.current), []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    const checkUpd = () =>
      getUpdate().then((u) => {
        setUpdate(u);
        if (u.applied) setUpdateState("done");
      }).catch(() => {});
    checkUpd();
    const u = setInterval(checkUpd, 30 * 60 * 1000);
    return () => {
      clearInterval(t);
      clearInterval(u);
    };
  }, []);

  const onUpdate = () => {
    if (!update) return;
    if (!update.canSelfUpdate) {
      openInBrowser(update.releaseUrl);
      return;
    }
    if (updateState !== "idle") return;
    setUpdateState("busy");
    applyUpdate().then((r) => setUpdateState(r.ok ? "done" : "idle")).catch(() => setUpdateState("idle"));
  };

  const onMove = (id: string, s: Status) => {
    setBoard((b) => b ? { ...b, sessions: b.sessions.map((x) => x.id === id ? { ...x, status: s } : x) } : b);
    apiSetStatus(id, s).then(refresh).catch(refresh);
  };
  const createSession = (s: Record<string, unknown>) =>
    post("/api/sessions", s).then(() => {
      setModal(null);
      refresh();
    });

  const openDb = (id: string) => {
    setDbId(id);
    setView("database");
  };
  const openPage = (id: string) => {
    setPageId(id);
    setView("page");
  };
  const openClient = (id: string) => {
    setClientId(id);
    setView("client");
  };
  const newProject = () =>
    createPage({ kind: "project" }).then((r) => {
      refresh();
      openPage(r.id);
    });
  const newPage = (parentId: string | null) =>
    createPage({ parent_id: parentId }).then((r) => {
      refresh();
      openPage(r.id);
    });
  const newDb = () => setModal("udb");
  const currentDb = view === "database" ? udbs.find((d) => d.id === dbId) ?? null : null;
  const currentPage = view === "page" ? pages.find((p) => p.id === pageId) ?? null : null;

  // breadcrumb: ancestors of the open page (nearest last)
  const crumbs = useMemo(() => {
    if (!currentPage) return [];
    const byId = new Map(pages.map((p) => [p.id, p]));
    const out: PageMeta[] = [];
    for (let p = byId.get(currentPage.parent_id ?? ""); p; p = byId.get(p.parent_id ?? "")) out.unshift(p);
    return out;
  }, [currentPage, pages]);

  const isSessions = view === "board" || view === "list";
  const currentClient = view === "client" ? board?.clients.find((c) => c.id === clientId) ?? null : null;
  const title = isSessions ? "Sessions" : view === "database" ? currentDb?.name ?? "Database" : view === "client" ? currentClient?.name ?? "Client" : "Explore";

  return (
    <div className="flex h-full">
      <Sidebar
        view={view}
        onNav={setView}
        status={status}
        onSettings={() => setModal("settings")}
        pages={pages}
        pageId={pageId}
        onOpenPage={openPage}
        onNewPage={newPage}
        onNewProject={newProject}
        udbs={udbs}
        dbId={dbId}
        onOpenDb={openDb}
        onNewDb={newDb}
        update={update}
        updateState={updateState}
        onUpdate={onUpdate}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-line px-6 py-3">
          {view === "page" && currentPage
            ? (
              <div className="flex min-w-0 items-center gap-1 text-[13px] text-ink-muted">
                {crumbs.map((c) => (
                  <span key={c.id} className="flex items-center gap-1">
                    <button type="button" className="max-w-[160px] truncate hover:text-ink-soft" onClick={() => openPage(c.id)}>
                      {c.title || "Untitled"}
                    </button>
                    <span className="text-ink-muted/50">/</span>
                  </span>
                ))}
                <span className="truncate font-medium text-ink">{currentPage.title || "Untitled"}</span>
              </div>
            )
            : view === "database" && currentDb
            ? (
              <div className="flex items-center gap-1">
                <div className="relative">
                  <button type="button"
                    className="rounded-md p-1 text-[15px] leading-none transition-colors hover:bg-panel"
                    title="database icon"
                    onClick={() => setDbIconOpen(true)}
                  >
                    <EntityIcon icon={currentDb.icon} fallback="⌗" className={currentDb.icon ? "" : "text-ink-muted"} />
                  </button>
                  {dbIconOpen && (
                    <IconPicker
                      current={currentDb.icon}
                      onPick={(icon) => updateUdb(currentDb.id, { icon }).then(refresh)}
                      onClose={() => setDbIconOpen(false)}
                    />
                  )}
                </div>
                <input
                  key={currentDb.id}
                  className="rounded-md border border-transparent bg-transparent px-1 py-0.5 text-[15px] font-semibold text-ink outline-none transition-colors hover:bg-panel/60 focus:border-chipline focus:bg-panel"
                  defaultValue={currentDb.name}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== currentDb.name) updateUdb(currentDb.id, { name: v }).then(refresh);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                />
              </div>
            )
            : <h1 className="text-[15px] font-semibold">{title}</h1>}
          {isSessions && (
            <div className="flex rounded-[7px] bg-panel p-[3px]">
              {(["board", "list"] as const).map((v) => (
                <button type="button"
                  key={v}
                  onClick={() => setView(v)}
                  className={`rounded-[5px] px-2.5 py-[3px] text-xs capitalize ${
                    view === v ? "bg-[#272b37] font-medium text-ink" : "text-ink-muted hover:text-ink-soft"
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
          )}
          {view === "board" && (
            <div className="relative">
              <button type="button"
                onClick={() => setGroupMenu((o) => !o)}
                title="Group the board"
                className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] ${
                  group !== "none"
                    ? "border-copper/50 text-copper"
                    : "border-line text-ink-muted hover:text-ink-soft"
                }`}
              >
                <GroupIcon />
                {group === "none" ? "Group" : group === "story" ? "Story" : "Project"}
                <span className="text-[8px]">▾</span>
              </button>
              {groupMenu && (
                <Popover onClose={() => setGroupMenu(false)} className="w-40">
                  <div className="px-2 pb-1 pt-1 text-[9.5px] font-medium tracking-[0.8px] text-ink-muted/70">
                    GROUP BY
                  </div>
                  {([["none", "None"], ["story", "◇ Story"], ["project", "◎ Project"]] as const).map(([v, label]) => (
                    <button
                      type="button"
                      key={v}
                      onClick={() => {
                        setGroup(v);
                        setGroupMenu(false);
                      }}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-panel ${
                        group === v ? "text-ink" : "text-ink-soft"
                      }`}
                    >
                      <span className="flex-1">{label}</span>
                      {group === v && <span className="text-[11px] text-copper">✓</span>}
                    </button>
                  ))}
                </Popover>
              )}
            </div>
          )}
          {isSessions && storyFilter && (
            <button type="button"
              onClick={() => setStoryFilter(null)}
              title="Clear story"
              className="flex items-center gap-1.5 rounded-md border border-copper/50 px-2 py-1 text-[11.5px] text-copper hover:bg-copper/10"
            >
              <span className="text-[9px]">◇</span>
              {board?.objectives.find((o) => o.id === storyFilter)?.title ?? "story"}
              <span className="text-[11px]">✕</span>
            </button>
          )}
          <div className="flex-1" />
          {isSessions && (
            <button type="button"
              onClick={() => setModal("import")}
              className="rounded-md border border-line px-2.5 py-1 text-[11.5px] text-ink-muted hover:text-ink-soft"
            >
              ⇣ Import from Claude Code
            </button>
          )}
          <button type="button"
            onClick={doSync}
            disabled={syncing}
            title="Pull teammates' changes and push yours to the hub"
            className="rounded-md border border-line px-2.5 py-1 text-[11.5px] text-ink-muted hover:text-ink-soft disabled:opacity-60"
          >
            {syncing ? "Syncing…" : syncFlash ? `Synced · ${syncFlash}` : "Sync now"}
          </button>
          {view === "page" && currentPage && (
            <button type="button"
              onClick={() =>
                confirmDeletePage(currentPage).then((ok) => {
                  if (ok) {
                    setView("board");
                    setPageId(null);
                    refresh();
                  }
                })}
              className="rounded-md border border-line px-2.5 py-1 text-[11.5px] text-ink-muted hover:text-blocked"
            >
              Delete
            </button>
          )}
          {view === "database" && currentDb && (
            <button type="button"
              onClick={async () => {
                if (await appConfirm(`Delete database "${currentDb.name}" and all its rows?`)) {
                  deleteUdb(currentDb.id).then(() => {
                    setView("board");
                    setDbId(null);
                    refresh();
                  });
                }
              }}
              className="rounded-md border border-line px-2.5 py-1 text-[11.5px] text-ink-muted hover:text-blocked"
            >
              Delete
            </button>
          )}
          {view === "database"
            ? (
              <button type="button"
                onClick={() => dbId && createUdbRow(dbId).then(() => setUdbEpoch((e) => e + 1))}
                className="flex items-center gap-1.5 rounded-md bg-copper px-3 py-1.5 text-[12.5px] font-medium text-copper-ink hover:brightness-110"
              >
                <span>＋</span> New row
              </button>
            )
            : isSessions && (
              <button type="button"
                onClick={() => setModal("session")}
                className="flex items-center gap-1.5 rounded-md bg-copper px-3 py-1.5 text-[12.5px] font-medium text-copper-ink hover:brightness-110"
              >
                <span>＋</span> New session
              </button>
            )}
        </header>
        {!board
          ? <p className="p-6 text-ink-muted">Loading…</p>
          : view === "board"
          ? (
            <Board
              board={board}
              group={group}
              onMove={onMove}
              onOpen={setOpenId}
              storyFilter={storyFilter}
              onFilterStory={(id) => setStoryFilter((cur) => cur === id ? null : id)}
            />
          )
          : view === "list"
          ? (
            <List
              board={board}
              onOpen={setOpenId}
              storyFilter={storyFilter}
              onFilterStory={(id) => setStoryFilter((cur) => cur === id ? null : id)}
            />
          )
          : view === "page"
          ? (pageId
            ? (
              <Page
                key={pageId}
                pageId={pageId}
                board={board}
                udbs={udbs}
                onOpenPage={openPage}
                onOpenSession={setOpenId}
                onOpenClient={openClient}
                onChanged={refresh}
              />
            )
            : <p className="p-6 text-ink-muted">No page selected.</p>)
          : view === "database"
          ? (dbId
            ? <DatabaseView key={dbId} dbId={dbId} epoch={udbEpoch} udbs={udbs} />
            : <p className="p-6 text-ink-muted">No database selected.</p>)
          : view === "client"
          ? (clientId
            ? <ClientView board={board} clientId={clientId} onOpenPage={openPage} onOpenSession={setOpenId} />
            : <p className="p-6 text-ink-muted">No client selected.</p>)
          : <Explore key={exploreEpoch} board={board} onOpenSettings={() => setModal("settings")} />}
      </main>
      {openId && board && (() => {
        const session = board.sessions.find((s) => s.id === openId);
        return session
          ? (
            <Drawer
              key={session.id}
              session={session}
              board={board}
              onClose={() => setOpenId(null)}
              onSaved={refresh}
            />
          )
          : null;
      })()}
      {modal === "import" && board && (
        <ImportClaudeModal
          board={board}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            refresh();
          }}
        />
      )}
      {modal === "session" && board && (
        <NewSessionModal board={board} onClose={() => setModal(null)} onCreate={createSession} />
      )}
      {modal === "udb" && (
        <NewUdbModal
          onClose={() => setModal(null)}
          onCreate={(name) =>
            createUdb(name).then((r) => {
              setModal(null);
              refresh();
              openDb(r.id);
            })}
        />
      )}
      {modal === "settings" && (
        <SettingsModal onClose={() => setModal(null)} onSaved={() => setExploreEpoch((e) => e + 1)} />
      )}
      {update && (update.available || update.applied) && !updateDismissed && (
        <div className="fixed bottom-4 right-4 z-[60] flex w-[320px] flex-col gap-2.5 rounded-xl border border-[#323649] bg-[#171923] p-3.5 shadow-2xl shadow-black/50">
          {updateState === "done"
            ? (
              <>
                <p className="m-0 text-[12.5px] font-medium text-ink">
                  ✓ Updated to v{update.latest}
                </p>
                <p className="m-0 text-[11.5px] leading-relaxed text-ink-muted">
                  Restart Trame to run the new version.
                </p>
                <div className="flex items-center justify-end">
                  <button
                    type="button"
                    className="rounded-md px-2 py-1 text-[11.5px] text-ink-muted hover:text-ink-soft"
                    onClick={() => setUpdateDismissed(true)}
                  >
                    Close
                  </button>
                </div>
              </>
            )
            : (
              <>
                <p className="m-0 text-[12.5px] font-medium text-ink">
                  <span className="text-copper">↑</span> Trame v{update.latest} is available
                </p>
                <p className="m-0 text-[11.5px] text-ink-muted">
                  You're on v{update.current}.{" "}
                  <button
                    type="button"
                    className="text-ink-muted underline decoration-chipline underline-offset-2 hover:text-ink-soft"
                    onClick={() => openInBrowser(update.releaseUrl)}
                  >
                    Release notes
                  </button>
                </p>
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    className="rounded-md px-2 py-1 text-[11.5px] text-ink-muted hover:text-ink-soft"
                    onClick={() => setUpdateDismissed(true)}
                  >
                    Later
                  </button>
                  <button
                    type="button"
                    className="rounded-md bg-copper px-2.5 py-1 text-[11.5px] font-medium text-copper-ink hover:brightness-110 disabled:opacity-60"
                    disabled={updateState === "busy"}
                    onClick={onUpdate}
                  >
                    {updateState === "busy" ? "Updating…" : update.canSelfUpdate ? "Update now" : "Open release"}
                  </button>
                </div>
              </>
            )}
        </div>
      )}
      <ConfirmHost />
    </div>
  );
}
