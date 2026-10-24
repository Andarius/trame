// Frontend plugin registry (mirror of crates/trame-local/src/plugins.rs). Static imports on
// purpose: React.lazy would reintroduce the WebKitGTK dynamic-import failure
// mode the backend defends against. Labels/glyphs/enabled come from the server
// manifest (GET /api/plugins) — only the components live here.
import { type ComponentType, type ReactNode, useMemo } from "react";
import { createPortal } from "react-dom";
import type { PageDetail, Session } from "../api";
import { DeploymentsCardPath } from "./deployments/CardPath";
import { DeploymentsPanel } from "./deployments/Panel";
import { DeploymentsSettings } from "./deployments/Settings";
import { NotebookPanel } from "./notebook/Panel";
import { NotebookSettingsView } from "./notebook/Settings";
import { SqlSourceDatabaseActions, SqlSourceDatabaseEmpty } from "./sql-source/Actions";
import { SqlSourceSettings } from "./sql-source/Settings";
import { LOCAL_PLUGINS } from "./local.gen";
export { isPluginEnabled, markPluginEnabled, openPluginSettings, setEnabledPlugins, usePluginEnabled } from "./enabled";

/** What the host hands a panel. A panel may declare only the props it uses. */
export type PanelProps = {
  onOpenSettings: () => void;
  onOpenPage: (id: string) => void;
  onOpenSession: (id: string) => void;
  /** the sidebar column, for a plugin that declares `column`: portal its list there */
  column?: HTMLElement | null;
};

export type CardFace = { name: string; avatar: string | null };

/** A plugin block as a page stores it; the fields besides `type` and `id` are the plugin's. */
export type PluginBlockData = { type: string; id?: string; [field: string]: unknown };

/** What the host hands a plugin's block view. */
export type BlockViewProps = {
  block: PluginBlockData;
  /** off, the view only shows what the block holds */
  enabled: boolean;
  onPatch: (patch: Record<string, unknown>) => void;
  onRemove: () => void;
  /** a new empty block of the same type above or below; returns its id */
  onInsert: (where: "above" | "below") => string;
  /** the plugin's settings, where it is turned on */
  onOpenSettings: () => void;
};

/** A block type a plugin owns: its "/" menu entry, a new block's fields and its view. */
export type PluginBlock = {
  type: string;
  label: string;
  hint: string;
  /** a new block's fields besides `type` and `id` */
  create: () => Record<string, unknown>;
  View: ComponentType<BlockViewProps>;
  /** a page holding one widens so text and these blocks share one edge */
  wide?: boolean;
};

/** What a plugin shows in the host's own views; the host renders these and never names a plugin. */
export type FrontendPlugin = {
  id: string;
  /** its own sidebar view; without one the plugin lives in Settings and its host hooks */
  Panel?: ComponentType<PanelProps>;
  /** the Panel fills the sidebar column (through `PanelProps.column`); without it the rail stands alone */
  column?: boolean;
  Settings?: ComponentType;
  /** under a page's brief */
  PageHeader?: ComponentType<{ page: PageDetail; onDone: () => void }>;
  /** in a database page's header, before "New row"; `onDone` reloads the table */
  DatabaseActions?: ComponentType<{ dbId: string; onDone: () => void }>;
  /** a choice in an empty database's "start" options; `onDone` reloads the table */
  DatabaseEmpty?: ComponentType<{ dbId: string; onDone: () => void }>;
  /** a small mark on a card's board tile and story row */
  CardBadge?: ComponentType<{ sessionId: string }>;
  /** who handed me each card, by session id: a face after its title on the graph */
  useCardFaces?: () => Record<string, CardFace>;
  /** extra rows (`FieldRow`s) in the card view's field grid; `specs` is the spec page's content */
  CardFields?: ComponentType<{ session: Session; specs: unknown[] }>;
  /** marks that are metadata: hidden in text, and a line holding only them is not empty */
  metadataMarks?: string[];
  /** block types it renders in pages */
  blocks?: PluginBlock[];
};

/** renders a Panel's list into the sidebar column it was handed (`PanelProps.column`), else in place */
export function SidebarColumn({ column, children }: { column?: HTMLElement | null; children: ReactNode }) {
  return column ? createPortal(children, column) : children;
}

export const FRONTEND_PLUGINS: FrontendPlugin[] = [
  { id: "deployments", Panel: DeploymentsPanel, column: true, Settings: DeploymentsSettings, CardFields: DeploymentsCardPath },
  { id: "sql-source", Settings: SqlSourceSettings, DatabaseActions: SqlSourceDatabaseActions, DatabaseEmpty: SqlSourceDatabaseEmpty },
  { id: "notebook", Panel: NotebookPanel, Settings: NotebookSettingsView },
  ...LOCAL_PLUGINS,
];

/** The composed plugins' bundle, loaded before the first render; a compiled-in plugin with the same id wins. */
export function registerRuntimePlugins(list: FrontendPlugin[]): void {
  for (const p of list) if (!FRONTEND_PLUGINS.some((f) => f.id === p.id)) FRONTEND_PLUGINS.push(p);
}

// lazy: the registry and the views that read it import each other
export const isMetadataMark = (key: string) => FRONTEND_PLUGINS.some((p) => p.metadataMarks?.includes(key));

// every plugin's card faces merged; the registry is static, so the hook order never changes
export function useCardFaces(): Record<string, CardFace> {
  const maps = FRONTEND_PLUGINS.map((p) => p.useCardFaces?.());
  // oxlint-disable-next-line react/use-memo, react-hooks/exhaustive-deps -- one entry per static plugin
  return useMemo(() => Object.assign({}, ...maps), maps);
}

/** The plugin block owning `type`, with its plugin's id. */
export function blockOf(type: string): (PluginBlock & { plugin: string }) | undefined {
  for (const p of FRONTEND_PLUGINS) {
    const b = p.blocks?.find((x) => x.type === type);
    if (b) return { ...b, plugin: p.id };
  }
}
export const pluginBlocks = () => FRONTEND_PLUGINS.flatMap((p) => (p.blocks ?? []).map((b) => ({ ...b, plugin: p.id })));
