import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyUpdate,
  type AppStatus,
  type BoardData,
  createPage,
  createUdb,
  createUdbRow,
  deleteUdb,
  exportPage,
  getBoard,
  getPlugins,
  getStatus,
  getUpdate,
  importPage,
  listPages,
  listUdbs,
  movePage,
  openInBrowser,
  type PageMeta,
  type PluginManifest,
  type SearchHit,
  setStatus as apiSetStatus,
  type Session,
  type Status,
  type UdbMeta,
  type UpdateInfo,
  updateUdb,
} from "./api";
import { AgentsContext } from "./agents";
import { AgentSessions } from "./AgentSessions";
import { Board } from "./Board";
import { Drawer, TOPBAR_SLOT } from "./Drawer";
import { Explore } from "./Explore";
import { List } from "./List";
import { filterSessionBoard, sortSessionBoard, type Sort } from "./SessionSort";
import { SessionBar } from "./SessionBar";
import {
  ImportClaudeModal,
  NewSessionModal,
  NewUdbModal,
  SettingsModal,
} from "./modals";
import { GroupIcon } from "./icons";
import { Palette } from "./Palette";
import { useAgentsPoll, useSelection, useStarred, useSync } from "./app-hooks";
import { SelectionBar, UpdateBanner } from "./UpdateBanner";
import { Sidebar } from "./Sidebar";
import type { View } from "./view";
import { type TreeCards, TreeCardsCtx } from "./sidebar-tree";
import { StatusManager } from "./StatusManager";
import { ShareModal } from "./ShareModal";
import { confirmDeletePage, Page } from "./Page";
import { ClientView } from "./ClientView";
import { MenuRow, BOOL_CODEC, useLocalStorage, appConfirm, ConfirmHost, EntityIcon, ExpandIcon, Popover, setStatuses, statusStyle } from "./ui";
import { FRONTEND_PLUGINS } from "./plugins";
import { PluginsModal } from "./plugins/PluginsModal";
import { PluginSettingsModal } from "./plugins/PluginSettingsModal";
import { IconPicker } from "./udb/cells";
import { DatabaseView } from "./udb/DatabaseTable";

const post = (path: string, body: unknown) =>
  fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });


export function App() {
  const params = new URLSearchParams(location.search);
  const [board, setBoard] = useState<BoardData | null>(null);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [view, setView] = useState<View>(() => {
    // a card link (or a legacy full-screen session link) opens the card view
    if (params.get("card") || (params.get("session") && params.get("full") !== "0")) return "card";
    const v = params.get("view") as View | null;
    if (v) return v;
    // bare entity links (?page=, ?db=, ...) imply their view
    if (params.get("page")) return "page";
    if (params.get("db")) return "database";
    if (params.get("client")) return "client";
    if (params.get("plugin")) return "plugin";
    return "board";
  });
  // zen = chrome-less view (no sidebar, no header) for reading/writing a page
  const [zen, setZen] = useState(params.get("zen") === "1");
  const [group, setGroup] = useState<"none" | "story" | "project">(() => {
    const g = params.get("group");
    return g === "story"
      ? "story"
      : g === "project"
      ? "project"
      : "none";
  });
  const [groupMenu, setGroupMenu] = useState(false);
  const [colMenu, setColMenu] = useState(false);
  const [storyFilter, setStoryFilter] = useState<string[]>(
    params.get("story")?.split(",").filter(Boolean) ?? [],
  );
  const [sessionSort, setSessionSort] = useState<Sort[]>([{ key: "touched", dir: -1 }]);
  const [sessionQuery, setSessionQuery] = useState(params.get("q") ?? "");
  const sortedBoard = useMemo(
    () => board ? sortSessionBoard(filterSessionBoard(board, sessionQuery), sessionSort) : null,
    [board, sessionQuery, sessionSort],
  );
  // "only sessions without a specs page" — a triage lens, mirrored to the URL
  const [noSpecs, setNoSpecs] = useState(params.get("nospecs") === "1"); // narrow sessions to the selected stories/projects (subtree union)
  const toggleStoryFilter = (id: string) =>
    setStoryFilter((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
    );
  // column order + the status set itself now live in the synced DB (board.statuses);
  // only "hide empty" stays a per-device preference.
  const [dense, setDense] = useLocalStorage("trame:denseBoard", false, BOOL_CODEC);
  const [hideEmpty, setHideEmpty] = useLocalStorage("trame:hideEmpty", false, BOOL_CODEC);
  const [modal, setModal] = useState<
    | "session"
    | "settings"
    | "plugins"
    | "pluginSettings"
    | "udb"
    | "import"
    | null
  >(
    (params.get("new") as "session" | "settings" | "udb" | "import" | null) ??
      null,
  );
  // the side panel only; a full session is the card view (cardId)
  const [openId, setOpenId] = useState<string | null>(params.get("full") === "0" ? params.get("session") : null);
  const [cardId, setCardId] = useState<string | null>(
    params.get("card") ?? (params.get("full") !== "0" ? params.get("session") : null),
  );
  // double-click in the Sessions list opens the drawer already expanded; mirrored
  // to the URL so a refresh restores it. A session link WITHOUT &full defaults to
  // the full ticket (a direct link means "show me this session") — only an
  // explicit full=0 (written when collapsing in-app) keeps the side panel.
  const [drawerFull, setDrawerFull] = useState(false);
  // ctrl/⌘ held on the click that navigates: open that location in a new tab instead
  const modClick = useRef(false);
  useEffect(() => {
    const mark = (e: MouseEvent) => {
      modClick.current = e.ctrlKey || e.metaKey;
      setTimeout(() => (modClick.current = false)); // only the handlers of this very click
    };
    addEventListener("click", mark, true);
    return () => removeEventListener("click", mark, true);
  }, []);
  const inNewTab = (params: Record<string, string>) => {
    if (!modClick.current) return false;
    modClick.current = false;
    const u = new URL(location.pathname, location.origin);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    // the desktop webview has no window.open: the system browser gets it
    if (!globalThis.open?.(u, "_blank")) openInBrowser(u.href);
    return true;
  };
  const openSession = (id: string, full = false) => {
    if (inNewTab({ view: "card", card: id })) return;
    setDrawerFull(false);
    if (full) {
      // a session opens as its own view, inside the app chrome like a page
      setOpenId(null);
      setCardId(id);
      setView("card");
    } else setOpenId(id);
  };
  const [exploreEpoch, setExploreEpoch] = useState(0); // bump to rescan files after settings change
  const agentsCtx = useAgentsPoll(exploreEpoch);
  const [exploreTarget, setExploreTarget] = useState<string | null>(null); // report path to pre-open in Explore
  const [exploreReturn, setExploreReturn] = useState<string | null>(null); // page id to go back to from Explore
  const [udbs, setUdbs] = useState<UdbMeta[]>([]);
  const [pages, setPages] = useState<PageMeta[]>([]);
  const [dbId, setDbId] = useState<string | null>(params.get("db"));
  const [pageId, setPageId] = useState<string | null>(params.get("page"));
  const [clientId, setClientId] = useState<string | null>(params.get("client"));
  const [plugins, setPlugins] = useState<PluginManifest[]>([]);
  const [pluginId, setPluginId] = useState<string | null>(params.get("plugin"));
  const [udbEpoch, setUdbEpoch] = useState(0); // bump to refetch the open database view
  const [dbReadOnly, setDbReadOnly] = useState(false); // active db tab is a read-only summary view
  const [dbIconOpen, setDbIconOpen] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateState, setUpdateState] = useState<"idle" | "busy" | "done">(
    "idle",
  );
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shareFlash, setShareFlash] = useState<string | null>(null); // transient Export-button label
  const [sharePageId, setSharePageId] = useState<string | null>(null); // ShareModal target
  const shareFlashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Ctrl/Cmd+P — Notion-style quick find (preventDefault beats the print dialog)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey &&
        e.key.toLowerCase() === "p"
      ) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    addEventListener("keydown", h);
    return () => removeEventListener("keydown", h);
  }, []);

  const onPalettePick = (h: SearchHit) => {
    setPaletteOpen(false);
    if (h.kind === "session") openSession(h.id);
    else if (h.kind === "client") openClient(h.id);
    else if (h.kind === "database") openDb(h.id);
    else openPage(h.id);
  };

  // keep state identity when a poll returns unchanged data, so re-renders only happen on real changes
  const keepSame = <T,>(next: T) => (prev: T | null): T =>
    prev !== null && JSON.stringify(prev) === JSON.stringify(next)
      ? prev
      : next;
  const refresh = () => {
    getBoard().then((b) => {
      setBoard(keepSame(b));
      setStatuses(b.statuses); // keep the status registry (labels/colors) in sync with the board
    }).catch(() => {});
    getStatus().then((s) => setStatus(keepSame(s))).catch(() => {});
    listUdbs().then((d) => Array.isArray(d) && setUdbs(keepSame(d))).catch(
      () => {},
    );
    listPages().then((d) => Array.isArray(d) && setPages(keepSame(d))).catch(
      () => {},
    );
    getPlugins().then((p) => Array.isArray(p) && setPlugins(keepSame(p))).catch(
      () => {},
    );
  };

  // multi-select on the sessions views (board + list): checkboxes fill `selected`,
  // a floating bar bulk-deletes. Cleared on view change, Escape, and after delete.
  const { selected, setSelected, toggleSelected, selectMany, deleteSelected } = useSelection(view, refresh);

  // "Sync now" is otherwise silent when nothing moves (0↓0↑) — flash the result so it reads as alive
  const { syncing, syncFlash, doSync } = useSync(refresh);
  // a location (view + the entity it shows) is a browser-history entry; filters and the
  // drawer only rewrite the current one
  const locKey = (
    v: View,
    ids: { page?: string | null; db?: string | null; client?: string | null; plugin?: string | null; card?: string | null },
  ) =>
    [v, v === "page" ? ids.page : "", v === "database" ? ids.db : "", v === "client" ? ids.client : "",
      v === "plugin" ? ids.plugin : "", v === "card" ? ids.card : ""].join("|");
  const lastLoc = useRef(locKey(view, { page: pageId, db: dbId, client: clientId, plugin: pluginId, card: cardId }));
  // mirror the navigational state into the URL so a refresh/reload restores it
  useEffect(() => {
    const u = new URL(location.href);
    const p = u.searchParams;
    const put = (
      k: string,
      v: string | null,
    ) => (v ? p.set(k, v) : p.delete(k));
    put("view", view === "board" ? null : view); // board is the default, keep it out
    put("page", view === "page" ? pageId : null);
    put("db", view === "database" ? dbId : null);
    put("client", view === "client" ? clientId : null);
    put("plugin", view === "plugin" ? pluginId : null);
    put("card", view === "card" ? cardId : null);
    put("session", openId);
    put("full", openId ? (drawerFull ? "1" : "0") : null);
    put("group", group === "none" ? null : group);
    put("story", storyFilter.join(",") || null);
    put("nospecs", noSpecs ? "1" : null);
    put("q", sessionQuery.trim() || null);
    put("zen", zen ? "1" : null);
    const k = locKey(view, { page: pageId, db: dbId, client: clientId, plugin: pluginId, card: cardId });
    if (k !== lastLoc.current) {
      lastLoc.current = k;
      history.pushState(null, "", u);
    } else history.replaceState(null, "", u);
  }, [view, pageId, dbId, clientId, pluginId, cardId, openId, drawerFull, group, storyFilter, noSpecs, sessionQuery, zen]);
  // Browser Back from the full-screen ticket returns to the view behind it (the
  // board for a direct link) instead of leaving the app: the underlying view is
  // written as its own history entry beneath the ticket, and popstate closes it.
  useEffect(() => {
    // Back/Forward: restore the location (and drawer) the entry was written with
    const onPop = () => {
      const q = new URLSearchParams(location.search);
      const v = (q.get("view") as View | null) ??
        (q.get("card") ? "card" : q.get("page") ? "page" : q.get("db") ? "database" : q.get("client") ? "client" : q.get("plugin") ? "plugin" : "board");
      lastLoc.current = locKey(v, {
        page: q.get("page"),
        db: q.get("db"),
        client: q.get("client"),
        plugin: q.get("plugin"),
        card: q.get("card"),
      });
      setView(v);
      if (v === "page") setPageId(q.get("page"));
      if (v === "database") setDbId(q.get("db"));
      if (v === "client") setClientId(q.get("client"));
      if (v === "plugin") setPluginId(q.get("plugin"));
      if (v === "card") setCardId(q.get("card"));
      setOpenId(q.get("session"));
      setDrawerFull(false);
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    if (!(openId && drawerFull)) return;
    const ticket = location.href;
    const under = new URL(ticket);
    under.searchParams.delete("session");
    under.searchParams.delete("full");
    history.replaceState(null, "", under);
    history.pushState(null, "", ticket);
  }, [openId, drawerFull]);
  // browser-tab title follows what's on screen (full session ticket > page/db/client/plugin view)
  useEffect(() => {
    const t = view === "card"
      ? board?.sessions.find((s) => s.id === cardId)?.title
      : view === "page"
      ? pages.find((p) => p.id === pageId)?.title
      : view === "database"
      ? udbs.find((d) => d.id === dbId)?.name
      : view === "client"
      ? board?.projects.find((c) => c.id === clientId)?.name ??
        pages.find((p) => p.id === clientId)?.title
      : view === "plugin"
      ? plugins.find((p) => p.id === pluginId)?.label
      : null;
    document.title = t ? `${t} — Trame` : "Trame";
  }, [view, pageId, dbId, clientId, pluginId, cardId, openId, drawerFull, board, pages, udbs, plugins]);
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
    applyUpdate().then((r) => setUpdateState(r.ok ? "done" : "idle")).catch(
      () => setUpdateState("idle"),
    );
  };

  const onMove = (id: string, s: Status) => {
    setBoard((b) =>
      b
        ? {
          ...b,
          sessions: b.sessions.map((x) =>
            x.id === id ? { ...x, status: s } : x
          ),
        }
        : b
    );
    apiSetStatus(id, s).then(refresh).catch(refresh);
  };
  const createSession = (s: Record<string, unknown>) =>
    post("/api/sessions", s).then(() => {
      setModal(null);
      refresh();
    });

  const openDb = (id: string) => {
    if (inNewTab({ view: "database", db: id })) return;
    setExploreReturn(null);
    setDbId(id);
    setView("database");
  };
  const openPage = (id: string) => {
    if (inNewTab({ view: "page", page: id })) return;
    setExploreReturn(null);
    setPageId(id);
    setView("page");
  };
  const openClient = (id: string) => {
    if (inNewTab({ view: "client", client: id })) return;
    setExploreReturn(null);
    setClientId(id);
    setView("client");
  };
  const openPlugin = (id: string) => {
    setExploreReturn(null);
    setPluginId(id);
    setView("plugin");
  };
  // Jump to Explore and pre-open a report file (e.g. from a folder block's "Explore" button),
  // remembering the page to return to.
  const openReport = (path: string) => {
    setExploreReturn(pageId);
    setExploreTarget(path);
    setView("explore");
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
  // sidebar drag-and-drop: re-file a page under a project (null = unfile)
  const movePageTo = (id: string, parentId: string | null) =>
    movePage(id, { parent_id: parentId }).then(refresh).catch((e) =>
      appConfirm(`Move failed: ${e?.message ?? "unknown error"}`, "OK")
    );

  // Export the page subtree to a bundle file; flash the outcome on the button.
  const flashShare = (msg: string | null, hold = 2600) => {
    clearTimeout(shareFlashTimer.current);
    setShareFlash(msg);
    if (msg) {
      shareFlashTimer.current = setTimeout(() => setShareFlash(null), hold);
    }
  };
  const sharePage = (id: string) => {
    flashShare("Saving…", 0);
    exportPage(id).then((r) => {
      if (r.path) flashShare("Saved ✓");
      else if (r.cancelled) flashShare(null);
      else flashShare(r.error ?? "failed");
    }).catch(() => flashShare("failed"));
  };
  // Import a bundle another Trame user sent; drop it at the top level, then open it.
  const importPageFile = () =>
    importPage(null).then((r) => {
      if (r.id) {
        refresh();
        openPage(r.id);
      } else if (r.error) {
        appConfirm(`Import failed: ${r.error}`, "OK");
      }
    }).catch(() => appConfirm("Import failed.", "OK"));
  useEffect(() => () => clearTimeout(shareFlashTimer.current), []);
  const newDb = () => setModal("udb");
  const currentDb = view === "database"
    ? udbs.find((d) => d.id === dbId) ?? null
    : null;
  // settings cover the main area only — navigating from the sidebar closes them
  const navKey = useRef(`${view}:${pageId}:${dbId}:${pluginId}:${clientId}:${cardId}`);
  useEffect(() => {
    const k = `${view}:${pageId}:${dbId}:${pluginId}:${clientId}:${cardId}`;
    if (k === navKey.current) return; // mount (e.g. ?new=settings deep link)
    navKey.current = k;
    setModal((m) => (m === "settings" ? null : m));
  }, [view, pageId, dbId, pluginId, clientId, cardId]);
  const currentPage = view === "page"
    ? pages.find((p) => p.id === pageId) ?? null
    : null;

  const cardSession = view === "card" ? board?.sessions.find((x) => x.id === cardId) ?? null : null;
  // the card view's breadcrumb: its story and the story's ancestors
  const cardCrumbs = useMemo(() => {
    if (!cardSession?.page_id) return [];
    const byId = new Map(pages.map((p) => [p.id, p]));
    const out: PageMeta[] = [];
    for (let p = byId.get(cardSession.page_id); p; p = byId.get(p.parent_id ?? "")) out.unshift(p);
    return out;
  }, [cardSession, pages]);
  // open cards under their user story in the sidebar tree
  const treeCards = useMemo<TreeCards>(() => {
    const byStory = new Map<string, Session[]>();
    for (const x of board?.sessions ?? []) {
      if (!x.page_id || statusStyle(x.status).terminal) continue;
      byStory.set(x.page_id, [...(byStory.get(x.page_id) ?? []), x]);
    }
    return { byStory, open: (id) => openSession(id, true), current: view === "card" ? cardId : null };
  }, [board, view, cardId]);
  // the spec pages behind cards: storage, never shown as pages
  const specPageIds = useMemo(
    () => new Set((board?.sessions ?? []).map((x) => x.specs_page_id).filter(Boolean) as string[]),
    [board],
  );
  // an old link to a spec page opens its card (replacing the entry, not stacking it)
  useEffect(() => {
    if (view !== "page" || !pageId || !board) return;
    const owner = board.sessions.find((x) => x.specs_page_id === pageId);
    if (!owner) return;
    lastLoc.current = locKey("card", { card: owner.id });
    setCardId(owner.id);
    setView("card");
  }, [view, pageId, board]);
  // breadcrumb: ancestors of the open page (nearest last)
  const crumbs = useMemo(() => {
    if (!currentPage) return [];
    const byId = new Map(pages.map((p) => [p.id, p]));
    const out: PageMeta[] = [];
    for (
      let p = byId.get(currentPage.parent_id ?? "");
      p;
      p = byId.get(p.parent_id ?? "")
    ) out.unshift(p);
    return out;
  }, [currentPage, pages]);

  const isSessions = view === "board" || view === "list";
  const currentClient = view === "client"
    ? board?.projects.find((c) => c.id === clientId) ?? null
    : null;
  const currentPlugin = view === "plugin"
    ? plugins.find((p) => p.id === pluginId) ?? null
    : null;
  const title = isSessions
    ? "Sessions"
    : view === "agents"
    ? "AI Sessions"
    : view === "database"
    ? currentDb?.name ?? "Database"
    : view === "client"
    ? currentClient?.name ?? "Client"
    : view === "plugin"
    ? currentPlugin?.label ?? "Plugin"
    : "Explore";

  // starred pages: per-browser shortcuts to deep pages (Soren → Weekly → …)
  const { starred, toggleStar } = useStarred();

  return (
    <AgentsContext.Provider value={agentsCtx}>
    <TreeCardsCtx.Provider value={treeCards}>
    <div className="flex h-full">
      {!zen && (
      <Sidebar
        view={view}
        starred={starred}
        toggleStar={toggleStar}
        onNav={(v) => {
          setExploreReturn(null);
          setView(v);
        }}
        status={status}
        onSettings={() => setModal("settings")}
        pages={pages.filter((x) => !specPageIds.has(x.id))}
        pageId={pageId}
        plugins={plugins}
        pluginId={pluginId}
        onOpenPlugin={openPlugin}
        onOpenPage={openPage}
        onNewPage={newPage}
        onNewProject={newProject}
        onImportPage={importPageFile}
        onMovePage={movePageTo}
        udbs={udbs}
        dbId={dbId}
        onOpenDb={openDb}
        onNewDb={newDb}
        update={update}
        updateState={updateState}
        onUpdate={onUpdate}
      />
      )}
      <main className="relative flex min-w-0 flex-1 flex-col">
        {zen && (
          <button
            type="button"
            onClick={() => setZen(false)}
            title="leave full screen"
            className="fixed right-3 top-3 z-30 flex items-center rounded-md border border-line bg-panel/80 px-1.5 py-1 text-ink-muted backdrop-blur transition-colors hover:text-ink"
          >
            <ExpandIcon open />
          </button>
        )}
        {!zen && (
        <header className="flex flex-col gap-2 border-b border-line px-6 py-3">
          <div className="flex items-center gap-3">
            {view === "card" && cardSession
              ? (
                <div className="flex min-w-0 items-center gap-1 text-[13px] text-ink-muted">
                  {cardCrumbs.map((c) => (
                    <span key={c.id} className="flex items-center gap-1">
                      <button
                        type="button"
                        className="flex max-w-[160px] items-center gap-1 hover:text-ink-soft"
                        onClick={() => openPage(c.id)}
                      >
                        <EntityIcon icon={c.icon} className="shrink-0 text-[11px]" size={14} />
                        <span className="truncate">{c.title || "Untitled"}</span>
                      </button>
                      <span className="text-ink-muted/50">/</span>
                    </span>
                  ))}
                  <span className="flex min-w-0 items-center gap-1 font-medium text-ink">
                    <EntityIcon
                      icon={pages.find((x) => x.id === cardSession.specs_page_id)?.icon}
                      fallback="▦"
                      className="shrink-0 text-[11px]"
                      size={14}
                    />
                    <span className="truncate">{cardSession.title}</span>
                  </span>
                </div>
              )
              : view === "page" && currentPage
              ? (
                <div className="flex min-w-0 items-center gap-1 text-[13px] text-ink-muted">
                  {crumbs.map((c) => (
                    <span key={c.id} className="flex items-center gap-1">
                      <button
                        type="button"
                        className="flex max-w-[160px] items-center gap-1 hover:text-ink-soft"
                        onClick={() =>
                          openPage(c.id)}
                      >
                        <EntityIcon icon={c.icon} className="shrink-0 text-[11px]" size={14} />
                        <span className="truncate">{c.title || "Untitled"}</span>
                      </button>
                      <span className="text-ink-muted/50">/</span>
                    </span>
                  ))}
                  <span className="flex min-w-0 items-center gap-1 font-medium text-ink">
                    <EntityIcon icon={currentPage.icon} className="shrink-0 text-[11px]" size={14} />
                    <span className="truncate">{currentPage.title || "Untitled"}</span>
                  </span>
                  <button
                    type="button"
                    className={`ml-1 shrink-0 text-[13px] hover:text-copper ${
                      starred.has(currentPage.id) ? "text-copper" : "text-ink-muted/40"
                    }`}
                    title={starred.has(currentPage.id) ? "unstar" : "star — pin this page in the sidebar"}
                    onClick={() => toggleStar(currentPage.id)}
                  >
                    ★
                  </button>
                </div>
              )
              : view === "database" && currentDb
              ? (
                <div className="flex items-center gap-1">
                  <div className="relative">
                    <button
                      type="button"
                      className="rounded-md p-1 text-[15px] leading-none transition-colors hover:bg-panel"
                      title="database icon"
                      onClick={() => setDbIconOpen(true)}
                    >
                      <EntityIcon
                        icon={currentDb.icon}
                        fallback="⌗"
                        className={currentDb.icon ? "" : "text-ink-muted"}
                      />
                    </button>
                    {dbIconOpen && (
                      <IconPicker
                        current={currentDb.icon}
                        onPick={(icon) =>
                          updateUdb(currentDb.id, { icon }).then(refresh)}
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
                      if (v && v !== currentDb.name) {
                        updateUdb(currentDb.id, {
                          name: v,
                        }).then(refresh);
                      }
                    }}
                    onKeyDown={(e) =>
                      e.key === "Enter" &&
                      (e.target as HTMLInputElement).blur()}
                  />
                </div>
              )
              : <h1 className="text-[15px] font-semibold">{title}</h1>}
            {isSessions && (
              <div className="flex rounded-[7px] bg-panel p-[3px]">
                {(["board", "list"] as const).map((v) => (
                  <button
                    type="button"
                    key={v}
                    onClick={() => setView(v)}
                    className={`rounded-[5px] px-2.5 py-[3px] text-xs capitalize ${
                      view === v
                        ? "bg-tab-active font-medium text-ink"
                        : "text-ink-muted hover:text-ink-soft"
                    }`}
                  >
                    {v}
                  </button>
                ))}
              </div>
            )}
            <div className="flex-1" />
            {isSessions && (
              <button
                type="button"
                onClick={() => setModal("import")}
                className="shrink-0 whitespace-nowrap rounded-md border border-line px-2.5 py-1 text-[11.5px] text-ink-muted hover:text-ink-soft"
              >
                ⇣ Import from Claude Code + Codex
              </button>
            )}
            <div id={TOPBAR_SLOT} className="contents" />
            <button
              type="button"
              onClick={doSync}
              disabled={syncing}
              title="Pull teammates' changes and push yours to the hub"
              className="shrink-0 whitespace-nowrap rounded-md border border-line px-2.5 py-1 text-[11.5px] text-ink-muted hover:text-ink-soft disabled:opacity-60"
            >
              {syncing
                ? "Syncing…"
                : syncFlash
                ? `Synced · ${syncFlash}`
                : "Sync now"}
            </button>
            {view === "page" && currentPage && (
              <button
                type="button"
                onClick={() => setZen(true)}
                title="Full screen — hide the sidebar and this bar"
                className="flex shrink-0 items-center rounded-md border border-line px-2 py-[5px] text-ink-muted hover:text-ink-soft"
              >
                <ExpandIcon open={false} />
              </button>
            )}
            {view === "page" && currentPage && (
              <button
                type="button"
                onClick={() => setSharePageId(currentPage.id)}
                title="Share this page's subtree with a guest user (live sync, viewer or editor)"
                className="shrink-0 whitespace-nowrap rounded-md border border-line px-2.5 py-1 text-[11.5px] text-ink-muted hover:text-ink-soft"
              >
                Share
              </button>
            )}
            {view === "page" && currentPage && (
              <button
                type="button"
                onClick={() => sharePage(currentPage.id)}
                title="Export this page — with its sub-pages and databases — to a file another Trame user can import"
                className="shrink-0 whitespace-nowrap rounded-md border border-line px-2.5 py-1 text-[11.5px] text-ink-muted hover:text-ink-soft"
              >
                {shareFlash ?? "Export"}
              </button>
            )}
            {view === "page" && currentPage && (
              <button
                type="button"
                onClick={() =>
                  confirmDeletePage(currentPage).then((ok) => {
                    if (!ok) return;
                    // a sub-page lands on its parent; a root page on the board
                    if (currentPage.parent_id) openPage(currentPage.parent_id);
                    else {
                      setView("board");
                      setPageId(null);
                    }
                    refresh();
                  })}
                className="rounded-md border border-blocked/40 px-2.5 py-1 text-[11.5px] text-blocked/80 hover:bg-blocked/15 hover:text-blocked"
              >
                Delete
              </button>
            )}
            {view === "database" && currentDb && (
              <button
                type="button"
                onClick={async () => {
                  if (
                    await appConfirm(
                      `Delete database "${currentDb.name}" and all its rows?`,
                    )
                  ) {
                    deleteUdb(currentDb.id).then(() => {
                      setView("board");
                      setDbId(null);
                      refresh();
                    });
                  }
                }}
                className="rounded-md border border-blocked/40 px-2.5 py-1 text-[11.5px] text-blocked/80 hover:bg-blocked/15 hover:text-blocked"
              >
                Delete
              </button>
            )}
            {view === "database" && !dbReadOnly
              ? (
                <button
                  type="button"
                  onClick={() =>
                    dbId &&
                    createUdbRow(dbId).then(() => setUdbEpoch((e) => e + 1))}
                  className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-copper px-3 py-1.5 text-[12.5px] font-medium text-copper-ink hover:brightness-110"
                >
                  <span>＋</span> New row
                </button>
              )
              : isSessions && (
                <button
                  type="button"
                  onClick={() => setModal("session")}
                  className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-copper px-3 py-1.5 text-[12.5px] font-medium text-copper-ink hover:brightness-110"
                >
                  <span>＋</span> New session
                </button>
              )}
          </div>
          {isSessions && board && (
            <SessionBar
              pages={board.pages}
              filter={storyFilter}
              onToggle={toggleStoryFilter}
              noSpecs={noSpecs}
              onNoSpecs={() => setNoSpecs((v) => !v)}
              query={sessionQuery}
              onQuery={setSessionQuery}
              onClear={() => {
                setStoryFilter([]);
                setNoSpecs(false);
                setSessionQuery("");
              }}
              sort={sessionSort}
              onSort={setSessionSort}
            >
            {view === "board" && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setGroupMenu((o) => !o)}
                  title="Group the board"
                  className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] ${
                    group !== "none"
                      ? "border-copper/50 text-copper"
                      : "border-line text-ink-muted hover:text-ink-soft"
                  }`}
                >
                  <GroupIcon />
                  {group === "none"
                    ? "Group"
                    : group === "story"
                    ? "User story"
                    : "Project"}
                  <span className="text-[8px]">▾</span>
                </button>
                {groupMenu && (
                  <Popover onClose={() => setGroupMenu(false)} className="w-40">
                    <div className="px-2 pb-1 pt-1 text-[9.5px] font-medium tracking-[0.8px] text-ink-muted/70">
                      GROUP BY
                    </div>
                    {([["none", "None", null], ["story", "User story", "◇"], ["project", "Project", "◎"]] as const).map((
                      [v, label, glyph],
                    ) => (
                      <MenuRow
                        dense
                        key={v}
                        onClick={() => {
                          setGroup(v);
                          setGroupMenu(false);
                        }}
                        active={group === v}
                      >
                        {glyph && <EntityIcon icon={null} fallback={glyph} className="text-ink-muted" />}
                        <span className="flex-1">{label}</span>
                        {group === v && (
                          <span className="text-[11px] text-copper">✓</span>
                        )}
                      </MenuRow>
                    ))}
                  </Popover>
                )}
              </div>
            )}
            {view === "board" && (
              <button
                type="button"
                onClick={() => setDense((v) => !v)}
                title="One line per card"
                aria-pressed={dense}
                className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] ${
                  dense ? "border-copper/50 text-copper" : "border-line text-ink-muted hover:text-ink-soft"
                }`}
              >
                <span className="text-[11px]">≡</span>
                Compact
              </button>
            )}
            {view === "board" && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setColMenu((o) => !o)}
                  title="Columns"
                  className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] ${
                    hideEmpty
                      ? "border-copper/50 text-copper"
                      : "border-line text-ink-muted hover:text-ink-soft"
                  }`}
                >
                  <span className="text-[11px]">▤</span>
                  Columns
                  <span className="text-[8px]">▾</span>
                </button>
                {colMenu && (
                  <Popover
                    onClose={() => setColMenu(false)}
                    className="w-[264px]"
                  >
                    <MenuRow onClick={() => setHideEmpty((v) => !v)}>
                      <span
                        className={`flex h-3.5 w-3.5 items-center justify-center rounded border text-[9px] ${
                          hideEmpty
                            ? "border-copper bg-copper text-copper-ink"
                            : "border-chipline"
                        }`}
                      >
                        {hideEmpty ? "✓" : ""}
                      </span>
                      <span className="flex-1">Hide empty statuses</span>
                    </MenuRow>
                    <StatusManager
                      statuses={board?.statuses ?? []}
                      onChanged={refresh}
                    />
                  </Popover>
                )}
              </div>
            )}
            </SessionBar>
          )}
        </header>
        )}
        {!board
          ? <p className="p-6 text-ink-muted">Loading…</p>
          : view === "board"
          ? (
            <Board
              board={sortedBoard ?? board}
              group={group}
              onMove={onMove}
              onOpen={(id) => openSession(id)}
              onOpenFull={(id) => openSession(id, true)}
              storyFilter={storyFilter}
              onFilterStory={toggleStoryFilter}
              noSpecs={noSpecs}
              hideEmpty={hideEmpty}
              dense={dense}
              selected={selected}
              onToggleSelect={toggleSelected}
              onSelectMany={selectMany}
            />
          )
          : view === "list"
          ? (
            <List
              board={sortedBoard ?? board}
              sort={sessionSort}
              onSortChange={setSessionSort}
              onOpen={(id) => openSession(id)}
              onOpenFull={(id) => openSession(id, true)}
              noSpecs={noSpecs}
              storyFilter={storyFilter}
              onFilterStory={toggleStoryFilter}
              selected={selected}
              onToggleSelect={toggleSelected}
              onSelectMany={selectMany}
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
                onOpenSession={openSession}
                onOpenClient={openClient}
                onOpenReport={openReport}
                onChanged={refresh}
              />
            )
            : <p className="p-6 text-ink-muted">No page selected.</p>)
          : view === "card"
          ? (cardSession
            ? (
              <Drawer
                key={cardSession.id}
                session={cardSession}
                board={board}
                embedded
                onOpenPage={openPage}
                // closing a card goes back to its story
                onClose={() => (cardSession.page_id ? openPage(cardSession.page_id) : setView("board"))}
                onSaved={refresh}
              />
            )
            : <p className="p-6 text-ink-muted">Session not found.</p>)
          : view === "database"
          ? (dbId
            ? (
              <DatabaseView
                key={dbId}
                dbId={dbId}
                epoch={udbEpoch}
                udbs={udbs}
                onReadOnly={setDbReadOnly}
              />
            )
            : <p className="p-6 text-ink-muted">No database selected.</p>)
          : view === "client"
          ? (clientId
            ? (
              <ClientView
                board={board}
                clientId={clientId}
                onOpenPage={openPage}
                onOpenSession={(id) => openSession(id)}
                onChanged={refresh}
              />
            )
            : <p className="p-6 text-ink-muted">No client selected.</p>)
          : view === "plugin"
          ? (() => {
            const Panel = FRONTEND_PLUGINS.find((p) => p.id === pluginId)
              ?.Panel;
            return Panel
              ? (
                <Panel
                  onOpenSettings={() => setModal("pluginSettings")}
                  onOpenPage={openPage}
                />
              )
              : <p className="p-6 text-ink-muted">Unknown plugin.</p>;
          })()
          : view === "agents"
          ? <AgentSessions board={board} onOpenSession={(id) => openSession(id)} />
          : (
            <Explore
              key={exploreEpoch}
              board={board}
              onOpenSettings={() => setModal("settings")}
              initialPath={exploreTarget}
              onConsumed={() => setExploreTarget(null)}
              onBack={exploreReturn ? () => openPage(exploreReturn) : undefined}
            />
          )}
      </main>
      {isSessions && selected.size > 0 && (
        <SelectionBar count={selected.size} onDelete={deleteSelected} onClear={() => setSelected(new Set())} />
      )}
      {openId && board && (() => {
        const session = board.sessions.find((s) => s.id === openId);
        return session
          ? (
            <Drawer
              key={session.id}
              session={session}
              board={board}
              onExpandedChange={(full) => full && openSession(session.id, true)}
              onOpenPage={openPage}
              onClose={() => setOpenId(null)}
              onSaved={refresh}
            />
          )
          : null;
      })()}
      {paletteOpen && (
        <Palette onClose={() => setPaletteOpen(false)} onPick={onPalettePick} />
      )}
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
        <NewSessionModal
          board={board}
          onClose={() => setModal(null)}
          onCreate={createSession}
        />
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
        <SettingsModal
          onClose={() => setModal(null)}
          onSaved={() => setExploreEpoch((e) => e + 1)}
          onOpenPlugins={() => setModal("plugins")}
        />
      )}
      {sharePageId && (
        <ShareModal
          pageId={sharePageId}
          onClose={() => setSharePageId(null)}
        />
      )}
      {modal === "plugins" && <PluginsModal onClose={() => setModal(null)} />}
      {modal === "pluginSettings" && pluginId && (
        <PluginSettingsModal
          pluginId={pluginId}
          onClose={() => setModal(null)}
        />
      )}
      <UpdateBanner update={update} updateState={updateState} dismissed={updateDismissed} onUpdate={onUpdate} onDismiss={() => setUpdateDismissed(true)} />
      <ConfirmHost />
    </div>
    </TreeCardsCtx.Provider>
    </AgentsContext.Provider>
  );
}
