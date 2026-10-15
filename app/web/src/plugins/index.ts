// Frontend plugin registry (mirror of app/plugins/index.ts). Static imports on
// purpose: React.lazy would reintroduce the WebKitGTK dynamic-import failure
// mode the backend defends against. Labels/glyphs/enabled come from the server
// manifest (GET /api/plugins) — only the components live here.
import { type ComponentType, useMemo } from "react";
import type { PageDetail, Session } from "../api";
import { DeploymentsCardPath } from "./deployments/CardPath";
import { DeploymentsPanel } from "./deployments/Panel";
import { DeploymentsSettings } from "./deployments/Settings";
import { SqlSourceDatabaseActions, SqlSourceDatabaseEmpty } from "./sql-source/Actions";
import { SqlSourcePanel } from "./sql-source/Panel";
import { SqlSourceSettings } from "./sql-source/Settings";
import { LOCAL_PLUGINS } from "./local.gen";

/** What the host hands a panel. A panel may declare only the props it uses. */
export type PanelProps = {
  onOpenSettings: () => void;
  onOpenPage: (id: string) => void;
  onOpenSession: (id: string) => void;
};

export type CardFace = { name: string; avatar: string | null };

/** What a plugin shows in the host's own views; the host renders these and never names a plugin. */
export type FrontendPlugin = {
  id: string;
  Panel: ComponentType<PanelProps>;
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
};

export const FRONTEND_PLUGINS: FrontendPlugin[] = [
  { id: "deployments", Panel: DeploymentsPanel, Settings: DeploymentsSettings, CardFields: DeploymentsCardPath },
  { id: "sql-source", Panel: SqlSourcePanel, Settings: SqlSourceSettings, DatabaseActions: SqlSourceDatabaseActions, DatabaseEmpty: SqlSourceDatabaseEmpty },
  ...LOCAL_PLUGINS,
];

/** Out-of-process plugins loaded before the first render; a compiled-in plugin with the same id wins. */
export function registerRuntimePlugins(list: FrontendPlugin[]): void {
  for (const p of list) if (!FRONTEND_PLUGINS.some((f) => f.id === p.id)) FRONTEND_PLUGINS.push(p);
}

// lazy: the registry and the views that read it import each other
export const isMetadataMark = (key: string) => FRONTEND_PLUGINS.some((p) => p.metadataMarks?.includes(key));

// every plugin's card faces merged; the registry is static, so the hook order never changes
export function useCardFaces(): Record<string, CardFace> {
  const maps = FRONTEND_PLUGINS.map((p) => p.useCardFaces?.());
  return useMemo(() => Object.assign({}, ...maps), maps);
}
