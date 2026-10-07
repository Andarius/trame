// Frontend plugin registry (mirror of app/plugins/index.ts). Static imports on
// purpose: React.lazy would reintroduce the WebKitGTK dynamic-import failure
// mode the backend defends against. Labels/glyphs/enabled come from the server
// manifest (GET /api/plugins) — only the components live here.
import type { ComponentType } from "react";
import type { PageDetail, Session } from "../api";
import { DeploymentsPanel } from "./deployments/Panel";
import { DeploymentsSettings } from "./deployments/Settings";
import { LOCAL_PLUGINS } from "./local.gen";

/** What the host hands a panel. A panel may declare only the props it uses. */
export type PanelProps = {
  onOpenSettings: () => void;
  onOpenPage: (id: string) => void;
};

/** What a plugin shows in the host's own views; the host renders these and never names a plugin. */
export type FrontendPlugin = {
  id: string;
  Panel: ComponentType<PanelProps>;
  Settings?: ComponentType;
  /** under a page's brief */
  PageHeader?: ComponentType<{ page: PageDetail; onDone: () => void }>;
  /** a small mark on a card's board tile and story row */
  CardBadge?: ComponentType<{ sessionId: string }>;
  /** extra rows (`FieldRow`s) in the card view's field grid; `specs` is the spec page's content */
  CardFields?: ComponentType<{ session: Session; specs: unknown[] }>;
  /** marks that are metadata: hidden in text, and a line holding only them is not empty */
  metadataMarks?: string[];
};

export const FRONTEND_PLUGINS: FrontendPlugin[] = [
  { id: "deployments", Panel: DeploymentsPanel, Settings: DeploymentsSettings },
  ...LOCAL_PLUGINS,
];

// lazy: the registry and the views that read it import each other
export const isMetadataMark = (key: string) => FRONTEND_PLUGINS.some((p) => p.metadataMarks?.includes(key));
