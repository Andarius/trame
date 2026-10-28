// A leaf module: @trame/web-api re-exports it, and its namespace is built before plugins/index runs.
import { useSyncExternalStore } from "react";

// enabled plugin ids: App feeds them from GET /api/plugins, the plugin toggles keep them current
let enabledIds = new Set<string>();
const enabledListeners = new Set<() => void>();
function setEnabled(next: Set<string>) {
  if (next.size === enabledIds.size && [...next].every((id) => enabledIds.has(id))) return;
  enabledIds = next;
  for (const l of enabledListeners) l();
}
export const setEnabledPlugins = (ids: string[]) => setEnabled(new Set(ids));
export function markPluginEnabled(id: string, on: boolean) {
  const next = new Set(enabledIds);
  if (on) next.add(id);
  else next.delete(id);
  setEnabled(next);
}
export const isPluginEnabled = (id: string) => enabledIds.has(id);
const subscribeEnabled = (l: () => void) => (enabledListeners.add(l), () => enabledListeners.delete(l));
export const usePluginEnabled = (id: string) => useSyncExternalStore(subscribeEnabled, () => enabledIds.has(id));

/** Opens one plugin's settings modal from anywhere (App listens). */
export const openPluginSettings = (id: string) => dispatchEvent(new CustomEvent("trame:plugin-settings", { detail: id }));
