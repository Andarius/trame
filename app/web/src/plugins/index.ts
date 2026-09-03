// Frontend plugin registry (mirror of app/plugins/index.ts). Static imports on
// purpose: React.lazy would reintroduce the WebKitGTK dynamic-import failure
// mode the backend defends against. Labels/glyphs/enabled come from the server
// manifest (GET /api/plugins) — only the components live here.
import type { ComponentType } from "react";
import { DeploymentsPanel } from "./deployments/Panel";
import { DeploymentsSettings } from "./deployments/Settings";
import { CockpitPanel } from "./cockpit/Panel";
import { CockpitSettings } from "./cockpit/Settings";

/** What the host hands a panel. A panel may declare only the props it uses. */
export type PanelProps = {
  onOpenSettings: () => void;
  onOpenPage: (id: string) => void;
};

export type FrontendPlugin = {
  id: string;
  Panel: ComponentType<PanelProps>;
  Settings?: ComponentType;
};

export const FRONTEND_PLUGINS: FrontendPlugin[] = [
  { id: "deployments", Panel: DeploymentsPanel, Settings: DeploymentsSettings },
  { id: "cockpit", Panel: CockpitPanel, Settings: CockpitSettings },
];
