import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyUpdate,
  type AppStatus,
  type BoardData,
  createPage,
  createStatus,
  createUdb,
  createUdbRow,
  deleteSession,
  deleteStatus,
  deleteUdb,
  exportPage,
  getBoard,
  getIdentity,
  getPlugins,
  getStatus,
  getUpdate,
  importPage,
  listPages,
  listUdbs,
  moveStatus as apiMoveStatus,
  openInBrowser,
  type PageMeta,
  type PluginManifest,
  type SearchHit,
  setStatus as apiSetStatus,
  type Status,
  type StatusDef,
  syncNow,
  type UdbMeta,
  type UpdateInfo,
  updateStatus,
  updateUdb,
} from "./api";
import { AgentSessions } from "./AgentSessions";
import { Board } from "./Board";
import { Drawer } from "./Drawer";
import { Explore } from "./Explore";
import { List } from "./List";
import {
  ImportClaudeModal,
  NewSessionModal,
  NewUdbModal,
  SettingsModal,
} from "./modals";
import { Palette } from "./Palette";
import { ShareModal } from "./ShareModal";
import { confirmDeletePage, Page } from "./Page";
import { ClientView } from "./ClientView";
import {
  appConfirm,
  ConfirmHost,
  EntityIcon,
  pageGlyph,
  Popover,
  setStatuses,
} from "./ui";
import { FRONTEND_PLUGINS } from "./plugins";
import { PluginsModal } from "./plugins/PluginsModal";
import { PluginSettingsModal } from "./plugins/PluginSettingsModal";
import { IconPicker } from "./udb/cells";
import { DatabaseView } from "./udb/DatabaseTable";

type View =
  | "board"
  | "list"
  | "agents"
  | "explore"
  | "database"
  | "page"
  | "client"
  | "plugin";

const post = (path: string, body: unknown) =>
  fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// inline SVG with hardcoded colors — the span version relied on the --color-copper
// var and color-mix opacity, one of which the Linux WebKitGTK webview drops (logo
// rendered invisible). SVG with literal hex is bulletproof across both webviews.
function LogoMark() {
  return (
    <svg
      width="26"
      height="26"
      viewBox="0 0 26 26"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect width="26" height="26" rx="7" fill="#c98a63" />
      <rect
        x="6"
        y="11"
        width="14"
        height="3.5"
        rx="1.75"
        fill="#120e0b"
        fillOpacity="0.85"
      />
      <rect
        x="11.5"
        y="6"
        width="3.5"
        height="14"
        rx="1.75"
        fill="#120e0b"
        fillOpacity="0.55"
      />
    </svg>
  );
}

function GroupIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <rect x="2" y="2.5" width="12" height="4" rx="1" />
      <rect x="2" y="9.5" width="12" height="4" rx="1" />
    </svg>
  );
}

// inline SVG (not a glyph): the Unicode gear renders as a colored emoji on WKWebView
// and as tofu with the FE0E text selector on WebKitGTK — neither is acceptable
function GearIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

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

function PageNode(
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
          active
            ? "bg-active-row font-medium text-ink"
            : "text-ink-muted hover:text-ink-soft"
        }`}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        <button
          type="button"
          className={`w-[14px] shrink-0 text-[9px] ${
            hasKids ? "text-ink-muted/70 hover:text-ink" : "text-transparent"
          }`}
          onClick={() => hasKids && onToggle(p.id)}
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
            <EntityIcon icon={p.icon} fallback={pageGlyph(p.kind)} />
          </span>
          <span
            className={`truncate ${p.title ? "" : "italic text-ink-muted/60"}`}
          >
            {p.title || "Untitled"}
          </span>
        </button>
        <button
          type="button"
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

// A root page owned by another hub user reached us via a share — group it apart.
// Ownerless pages (legacy rows, dev mode) count as mine.
function isSharedIn(p: PageMeta, meId: string | null): boolean {
  return meId != null && p.owner_id != null && p.owner_id !== meId;
}

function Sidebar(
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
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      return new Set<string>(
        JSON.parse(localStorage.getItem("trame:expanded") ?? "[]"),
      );
    } catch {
      return new Set<string>();
    }
  });
  useEffect(() => {
    localStorage.setItem("trame:expanded", JSON.stringify([...expanded]));
  }, [expanded]);

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

  // opening a deep page (deep link, subpage nav) expands its ancestors
  useEffect(() => {
    if (!pageId) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (let p = byId.get(pageId); p?.parent_id; p = byId.get(p.parent_id)) {
        next.add(p.parent_id);
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
      {/* one tree, three root sections: projects (what sessions ladder up to),
          pages shared in by other users, and unfiled pages (the inbox to triage) */}
      <div className="px-2 pb-1.5 pt-4 text-[10.5px] font-medium tracking-[0.8px] text-ink-muted/70">
        PROJECTS
      </div>
      {(childrenOf.get(null) ?? []).filter((p) =>
        (p.kind === "project" || p.kind === "story") && !isSharedIn(p, meId)
      ).map((p) => (
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
      {(childrenOf.get(null) ?? []).some((p) => isSharedIn(p, meId)) && (
        <>
          <div className="px-2 pb-1.5 pt-4 text-[10.5px] font-medium tracking-[0.8px] text-ink-muted/70">
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
                onOpenPage={onOpenPage}
                onOpenDb={onOpenDb}
                onNewChild={(id) => onNewPage(id)}
              />
            ),
          )}
        </>
      )}
      <div className="px-2 pb-1.5 pt-4 text-[10.5px] font-medium tracking-[0.8px] text-ink-muted/70">
        UNFILED
      </div>
      {(childrenOf.get(null) ?? []).filter((p) =>
        p.kind === "page" && !isSharedIn(p, meId)
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
          onOpenPage={onOpenPage}
          onOpenDb={onOpenDb}
          onNewChild={(id) => onNewPage(id)}
        />
      ))}
      <div className="flex flex-wrap items-center gap-1.5">
        <NewChip label="New page" indent={26} onClick={() => onNewPage(null)} />
        <NewChip label="Import" indent={9} onClick={onImportPage} />
      </div>
      <div className="px-2 pb-1.5 pt-4 text-[10.5px] font-medium tracking-[0.8px] text-ink-muted/70">
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
      <div className="flex-1" />
      <div className="flex items-center gap-2 px-2 py-2 text-[11.5px] text-ink-muted">
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
  );
}

const STATUS_PALETTE = [
  "#7bd88f",
  "#5fb8e8",
  "#7a9ee7",
  "#b590e7",
  "#e08bc4",
  "#e06c75",
  "#e3925e",
  "#e3c567",
  "#9aa4b2",
  "#6b7280",
];

// Board-column manager (lives in the "Columns" popover): reorder, rename, recolor,
// flag done-like (terminal), delete, and add statuses. All edits hit the synced DB.
function StatusManager(
  { statuses, onChanged }: { statuses: StatusDef[]; onChanged: () => void },
) {
  const [paletteFor, setPaletteFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = (p: Promise<unknown>) => {
    setBusy(true);
    p.then(onChanged).finally(() => setBusy(false));
  };
  return (
    <div className="mt-1 border-t border-line-soft pt-1.5">
      <div className="px-2 pb-1 text-[9.5px] font-medium tracking-[0.8px] text-ink-muted/70">
        STATUSES
      </div>
      {statuses.map((s, i) => (
        <div key={s.id}>
          <div className="flex items-center gap-1 px-1.5 py-0.5">
            <div className="flex flex-col leading-none">
              <button
                type="button"
                disabled={i === 0 || busy}
                onClick={() => run(apiMoveStatus(s.id, -1))}
                className="text-[7px] text-ink-muted hover:text-ink disabled:opacity-25"
                title="move up"
              >
                ▲
              </button>
              <button
                type="button"
                disabled={i === statuses.length - 1 || busy}
                onClick={() => run(apiMoveStatus(s.id, 1))}
                className="text-[7px] text-ink-muted hover:text-ink disabled:opacity-25"
                title="move down"
              >
                ▼
              </button>
            </div>
            <button
              type="button"
              onClick={() => setPaletteFor((c) => (c === s.id ? null : s.id))}
              className="h-3 w-3 shrink-0 rounded-full ring-1 ring-inset ring-white/10"
              style={{ background: s.color }}
              title="change color"
            />
            <input
              defaultValue={s.label}
              key={s.label}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== s.label) run(updateStatus(s.id, { label: v }));
              }}
              onKeyDown={(e) =>
                e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-xs text-ink-soft outline-none hover:bg-panel/60 focus:border-chipline focus:bg-panel"
            />
            <button
              type="button"
              onClick={() => run(updateStatus(s.id, { terminal: !s.terminal }))}
              disabled={busy}
              className={`shrink-0 rounded px-1 text-[10px] ${
                s.terminal
                  ? "text-copper"
                  : "text-ink-muted/50 hover:text-ink-muted"
              }`}
              title={s.terminal
                ? "done-like column (click to unset)"
                : "mark as a done-like column"}
            >
              ⚑
            </button>
            <button
              type="button"
              disabled={statuses.length <= 1 || busy}
              onClick={() =>
                appConfirm(
                  `Delete the "${s.label}" status? Sessions in it move to another column.`,
                ).then((ok) => ok && run(deleteStatus(s.id)))}
              className="shrink-0 rounded px-1 text-[11px] text-ink-muted/60 hover:text-blocked disabled:opacity-25"
              title="delete status"
            >
              ✕
            </button>
          </div>
          {paletteFor === s.id && (
            <div className="flex flex-wrap gap-1 px-2 pb-1.5 pt-0.5">
              {STATUS_PALETTE.map((c) => (
                <button
                  type="button"
                  key={c}
                  onClick={() => {
                    setPaletteFor(null);
                    if (c !== s.color) run(updateStatus(s.id, { color: c }));
                  }}
                  className={`h-4 w-4 rounded-full ring-1 ring-inset ${
                    c === s.color ? "ring-white/70" : "ring-white/10"
                  }`}
                  style={{ background: c }}
                />
              ))}
            </div>
          )}
        </div>
      ))}
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          run(createStatus({ label: "New status", color: STATUS_PALETTE[2] }))}
        className="mt-0.5 flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11.5px] text-ink-muted/70 hover:text-copper disabled:opacity-50"
      >
        <span className="text-[11px]">＋</span> Add status
      </button>
    </div>
  );
}

export function App() {
  const params = new URLSearchParams(location.search);
  const [board, setBoard] = useState<BoardData | null>(null);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [view, setView] = useState<View>(() => {
    const v = params.get("view") as View | null;
    if (v) return v;
    // bare entity links (?page=, ?db=, ...) imply their view
    if (params.get("page")) return "page";
    if (params.get("db")) return "database";
    if (params.get("client")) return "client";
    if (params.get("plugin")) return "plugin";
    return "board";
  });
  const [group, setGroup] = useState<"none" | "story" | "project">(() => {
    const g = params.get("group");
    return g === "story" || g === "objective"
      ? "story"
      : g === "project"
      ? "project"
      : "none";
  });
  const [groupMenu, setGroupMenu] = useState(false);
  const [colMenu, setColMenu] = useState(false);
  const [storyFilter, setStoryFilter] = useState<string | null>(
    params.get("story"),
  ); // narrow sessions to one story
  // column order + the status set itself now live in the synced DB (board.statuses);
  // only "hide empty" stays a per-device preference.
  const [hideEmpty, setHideEmpty] = useState<boolean>(() =>
    localStorage.getItem("trame:hideEmpty") === "1"
  );
  useEffect(
    () => localStorage.setItem("trame:hideEmpty", hideEmpty ? "1" : "0"),
    [hideEmpty],
  );
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
  const [openId, setOpenId] = useState<string | null>(params.get("session"));
  const [exploreEpoch, setExploreEpoch] = useState(0); // bump to rescan files after settings change
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
    if (h.kind === "session") setOpenId(h.id);
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectMany = (ids: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) on ? next.add(id) : next.delete(id);
      return next;
    });
  useEffect(() => setSelected(new Set()), [view]);
  useEffect(() => {
    if (selected.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(new Set());
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [selected.size]);
  const deleteSelected = async () => {
    const n = selected.size;
    if (!(await appConfirm(`Delete ${n} session${n > 1 ? "s" : ""}?`))) return;
    await Promise.all([...selected].map((id) => deleteSession(id).catch(() => {})));
    setSelected(new Set());
    refresh();
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
      msg = r
        ? (r.pulled || r.pushed ? `${r.pulled}↓ ${r.pushed}↑` : "up to date")
        : "offline";
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
    put("session", openId);
    put("group", group === "none" ? null : group);
    put("story", storyFilter);
    history.replaceState(null, "", u);
  }, [view, pageId, dbId, clientId, pluginId, openId, group, storyFilter]);
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
    setExploreReturn(null);
    setDbId(id);
    setView("database");
  };
  const openPage = (id: string) => {
    setExploreReturn(null);
    setPageId(id);
    setView("page");
  };
  const openClient = (id: string) => {
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
  const currentPage = view === "page"
    ? pages.find((p) => p.id === pageId) ?? null
    : null;

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

  return (
    <div className="flex h-full">
      <Sidebar
        view={view}
        onNav={(v) => {
          setExploreReturn(null);
          setView(v);
        }}
        status={status}
        onSettings={() => setModal("settings")}
        pages={pages}
        pageId={pageId}
        plugins={plugins}
        pluginId={pluginId}
        onOpenPlugin={openPlugin}
        onOpenPage={openPage}
        onNewPage={newPage}
        onNewProject={newProject}
        onImportPage={importPageFile}
        udbs={udbs}
        dbId={dbId}
        onOpenDb={openDb}
        onNewDb={newDb}
        update={update}
        updateState={updateState}
        onUpdate={onUpdate}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-col gap-2 border-b border-line px-6 py-3">
          <div className="flex items-center gap-3">
            {view === "page" && currentPage
              ? (
                <div className="flex min-w-0 items-center gap-1 text-[13px] text-ink-muted">
                  {crumbs.map((c) => (
                    <span key={c.id} className="flex items-center gap-1">
                      <button
                        type="button"
                        className="max-w-[160px] truncate hover:text-ink-soft"
                        onClick={() =>
                          openPage(c.id)}
                      >
                        {c.title || "Untitled"}
                      </button>
                      <span className="text-ink-muted/50">/</span>
                    </span>
                  ))}
                  <span className="truncate font-medium text-ink">
                    {currentPage.title || "Untitled"}
                  </span>
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
                    ? "Story"
                    : "Project"}
                  <span className="text-[8px]">▾</span>
                </button>
                {groupMenu && (
                  <Popover onClose={() => setGroupMenu(false)} className="w-40">
                    <div className="px-2 pb-1 pt-1 text-[9.5px] font-medium tracking-[0.8px] text-ink-muted/70">
                      GROUP BY
                    </div>
                    {([["none", "None"], ["story", "◇ Story"], [
                      "project",
                      "◎ Project",
                    ]] as const).map(([v, label]) => (
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
                        {group === v && (
                          <span className="text-[11px] text-copper">✓</span>
                        )}
                      </button>
                    ))}
                  </Popover>
                )}
              </div>
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
                    <button
                      type="button"
                      onClick={() => setHideEmpty((v) => !v)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-ink-soft hover:bg-panel"
                    >
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
                    </button>
                    <StatusManager
                      statuses={board?.statuses ?? []}
                      onChanged={refresh}
                    />
                  </Popover>
                )}
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
                className="rounded-md border border-line px-2.5 py-1 text-[11.5px] text-ink-muted hover:text-blocked"
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
          {isSessions && storyFilter && (
            <div className="flex">
              <button
                type="button"
                onClick={() => setStoryFilter(null)}
                title="Clear filter"
                className="flex max-w-full items-center gap-1.5 rounded-md border border-copper/50 px-2 py-1 text-[11.5px] text-copper hover:bg-copper/10"
              >
                {(() => {
                  const fp = board?.pages.find((p) => p.id === storyFilter);
                  return (
                    <>
                      <EntityIcon icon={fp?.icon} fallback={pageGlyph(fp?.kind ?? "story")} className="shrink-0 text-[9px]" />
                      <span className="truncate">{fp?.title ?? "story"}</span>
                    </>
                  );
                })()}
                <span className="shrink-0 text-[11px]">✕</span>
              </button>
            </div>
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
              onFilterStory={(id) =>
                setStoryFilter((cur) => cur === id ? null : id)}
              hideEmpty={hideEmpty}
              selected={selected}
              onToggleSelect={toggleSelected}
              onSelectMany={selectMany}
            />
          )
          : view === "list"
          ? (
            <List
              board={board}
              onOpen={setOpenId}
              storyFilter={storyFilter}
              onFilterStory={(id) =>
                setStoryFilter((cur) => cur === id ? null : id)}
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
                onOpenSession={setOpenId}
                onOpenClient={openClient}
                onOpenReport={openReport}
                onChanged={refresh}
              />
            )
            : <p className="p-6 text-ink-muted">No page selected.</p>)
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
                onOpenSession={setOpenId}
              />
            )
            : <p className="p-6 text-ink-muted">No client selected.</p>)
          : view === "plugin"
          ? (() => {
            const Panel = FRONTEND_PLUGINS.find((p) => p.id === pluginId)
              ?.Panel;
            return Panel
              ? <Panel onOpenSettings={() => setModal("pluginSettings")} />
              : <p className="p-6 text-ink-muted">Unknown plugin.</p>;
          })()
          : view === "agents"
          ? <AgentSessions board={board} onOpenSession={setOpenId} />
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
        <div className="fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-line bg-panel px-3.5 py-2 shadow-xl shadow-black/40">
          <span className="text-[12px] text-ink-soft">
            {selected.size} selected
          </span>
          <button
            type="button"
            onClick={deleteSelected}
            className="rounded-md border border-blocked/50 px-2.5 py-1 text-[11.5px] text-blocked hover:bg-blocked/10"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            title="Clear selection (Esc)"
            className="text-[12px] text-ink-muted hover:text-ink-soft"
          >
            ✕
          </button>
        </div>
      )}
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
      {update && (update.available || update.applied) && !updateDismissed && (
        <div className="fixed bottom-4 right-4 z-[60] flex w-[320px] flex-col gap-2.5 rounded-xl border border-overlay-border bg-panel-modal p-3.5 shadow-2xl shadow-black/50">
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
                  <span className="text-copper">↑</span> Trame v{update.latest}
                  {" "}
                  is available
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
                    {updateState === "busy"
                      ? "Updating…"
                      : update.canSelfUpdate
                      ? "Update now"
                      : "Open release"}
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
