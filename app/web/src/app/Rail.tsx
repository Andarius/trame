import type { ReactNode } from "react";
import type { AppStatus, PluginManifest, UpdateInfo } from "../api";
import { useAgents } from "../agents/agents";
import { FRONTEND_PLUGINS } from "../plugins";
import { useTermDock } from "../term/term-api";
import { ChartIcon, GearIcon, LogoMark, SidebarIcon } from "../ui/icons";
import type { View } from "./view";

export const NAV: { key: "sessions" | "agents" | "terminals" | "explore" | "insights"; glyph: ReactNode; label: string; view: View }[] = [
  { key: "sessions", glyph: "▦", label: "Sessions", view: "board" },
  { key: "agents", glyph: "↻", label: "AI Sessions", view: "agents" },
  { key: "terminals", glyph: "›_", label: "Terminals", view: "terminals" },
  { key: "explore", glyph: "✦", label: "Explore", view: "explore" },
  { key: "insights", glyph: <ChartIcon />, label: "Insights", view: "insights" },
];

// the rail's tab for the current view: plugins are their own, page/db/card views belong to Sessions
export const railKey = (view: View, pluginId: string | null) =>
  view === "plugin" ? `plugin:${pluginId}` : view === "diagnostics" ? "diagnostics" : NAV.find((n) => n.view === view)?.key ?? "sessions";

// shown beside the icon after a short hover (native titles wait ~1s and can't be styled)
export function RailTip({ label, hint }: { label: string; hint?: string }) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none absolute left-full top-1/2 z-50 ml-2.5 flex -translate-x-1 -translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded-md border border-line bg-panel px-2 py-1 text-[11.5px] font-medium text-ink opacity-0 shadow-lg transition duration-100 group-hover/rail:translate-x-0 group-hover/rail:opacity-100 group-hover/rail:delay-75 group-focus-visible/rail:translate-x-0 group-focus-visible/rail:opacity-100"
    >
      {label}
      {hint && <span className="font-normal text-ink-muted">· {hint}</span>}
    </span>
  );
}

function RailButton(
  { label, hint, active, disabled, onClick, children, badge }: {
    label: string;
    hint?: string;
    active: boolean;
    disabled?: boolean;
    onClick: () => void;
    children: React.ReactNode;
    badge?: React.ReactNode;
  },
) {
  return (
    <button
      type="button"
      aria-label={hint ? `${label}, ${hint}` : label}
      aria-current={active ? "page" : undefined}
      disabled={disabled}
      onClick={onClick}
      className={`group/rail relative grid h-9 w-9 place-items-center rounded-lg text-[14px] ${
        active
          ? "bg-active-row text-copper"
          : disabled
          ? "text-ink-muted opacity-30"
          : "text-ink-muted hover:bg-active-row/60 hover:text-ink-soft"
      }`}
    >
      {children}
      {badge}
      <RailTip label={label} hint={hint} />
    </button>
  );
}

const dot = (color: string) => (
  <span className="absolute right-1 top-1 h-[7px] w-[7px] rounded-full ring-2 ring-sidebar" style={{ background: color }} />
);
const count = (n: number, tone = "bg-chipline text-ink-soft") => (
  <span className={`absolute -right-0.5 -top-0.5 min-w-[15px] rounded-full px-1 text-center text-[9px] font-semibold leading-[15px] ring-2 ring-sidebar ${tone}`}>
    {n}
  </span>
);

// Codex-style icon rail: every view one click away, with what needs you as badges; the column beside it follows the view
export function Rail(
  { view, pluginId, plugins, onNav, onOpenPlugin, status, onSettings, update, updateState, onUpdate, sidebar, onToggleSidebar }: {
    view: View;
    pluginId: string | null;
    plugins: PluginManifest[];
    onNav: (v: View) => void;
    onOpenPlugin: (id: string) => void;
    status: AppStatus | null;
    onSettings: () => void;
    update: UpdateInfo | null;
    updateState: "idle" | "busy" | "done";
    onUpdate: () => void;
    sidebar: boolean | null; // the column beside the rail: shown, hidden, or none for this view
    onToggleSidebar: () => void;
  },
) {
  const { live } = useAgents();
  const shells = Object.values(useTermDock().terms).filter((t) => !t.exited).length;
  const waiting = live.some((l) => l.state === "waiting");
  const active = railKey(view, pluginId);
  const synced = status?.remote && status.lastSync;
  const nWaiting = live.filter((l) => l.state === "waiting").length;
  const hintOf = (key: string) =>
    key === "agents" && live.length > 0
      ? nWaiting ? `${nWaiting} need${nWaiting > 1 ? "" : "s"} you` : `${live.length} live`
      : key === "terminals" && shells > 0
      ? `${shells} shell${shells > 1 ? "s" : ""}`
      : undefined;
  const badgeOf = (key: string) =>
    key === "agents" && live.length > 0
      ? dot(waiting ? "var(--color-wait)" : "var(--color-live)")
      : key === "terminals" && shells > 0
      ? count(shells)
      : undefined;
  return (
    <nav aria-label="Views" className="flex w-[52px] shrink-0 flex-col items-center gap-1 border-r border-line py-3">
      <div className="mb-3">
        <LogoMark debug={status?.debug} />
      </div>
      {/* always rendered, so the icons below never shift between views */}
      <RailButton
        label={sidebar === null ? "No sidebar in this view" : sidebar ? "Hide sidebar" : "Show sidebar"}
        hint={sidebar === null ? undefined : `${navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl+"}\\`}
        active={false}
        disabled={sidebar === null}
        onClick={onToggleSidebar}
      >
        <SidebarIcon />
      </RailButton>
      {NAV.map((n) => (
        <RailButton
          key={n.key}
          label={n.label}
          hint={hintOf(n.key)}
          active={active === n.key}
          onClick={() => onNav(n.view)}
          badge={badgeOf(n.key)}
        >
          {n.glyph}
        </RailButton>
      ))}
      <div className="my-1.5 h-px w-6 bg-line" />
      {plugins.filter((p) => p.enabled && FRONTEND_PLUGINS.some((f) => f.id === p.id && f.Panel)).map((p) => (
        <RailButton
          key={p.id}
          label={p.label}
          hint={p.badge ? String(p.badge) : undefined}
          active={active === `plugin:${p.id}`}
          onClick={() => onOpenPlugin(p.id)}
          badge={p.badge ? count(p.badge, "bg-copper/25 text-copper") : undefined}
        >
          {p.glyph}
        </RailButton>
      ))}
      <div className="flex-1" />
      {(update?.available || update?.applied) && (
        <RailButton
          label={updateState === "done" ? "updated — restart Trame to finish" : `update to v${update.latest}`}
          active={false}
          onClick={onUpdate}
        >
          <span className="text-[12px] text-copper">{updateState === "done" ? "↻" : "↑"}</span>
        </RailButton>
      )}
      <span className="group/rail relative grid h-5 w-9 place-items-center" tabIndex={0}>
        <span className="h-[7px] w-[7px] rounded-full" style={{ background: synced ? "var(--color-active)" : "var(--color-done)" }} />
        <RailTip
          label={status ? (status.remote ? (status.lastSync ? "Synced" : "Sync pending…") : "Local only") : "…"}
          hint={status?.nodeId}
        />
      </span>
      <RailButton label="Settings" active={false} onClick={onSettings}>
        <GearIcon />
      </RailButton>
    </nav>
  );
}
