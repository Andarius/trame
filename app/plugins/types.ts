// Minimal first-party plugin contract. Plugins are in-tree and compile-time
// registered (deno desktop --compress embeds the whole import graph, so there
// is no runtime loading); per-device enablement lives in the settings JSON.

export type PluginSettings = Record<string, unknown>;

export type PluginManifest = {
  id: string;
  label: string;
  glyph: string;
  description: string;
  enabled: boolean;
  badge: number | null;
};

export type PluginContext = {
  // Re-read from disk on each call so settings changes apply without a restart.
  enabled(): Promise<boolean>;
  settings(): Promise<PluginSettings>;
};

export interface Plugin {
  id: string; // url-safe slug, also the settings key under `plugins.<id>`
  label: string;
  glyph: string;
  description: string; // one line, shown in the plugins manager
  // Handles /api/plugins/<id>/<subPath> (subPath starts with "/"); null → 404.
  routes(
    req: Request,
    subPath: string,
    url: URL,
  ): Promise<Response | null> | Response | null;
  // subPaths reachable while the plugin is disabled (e.g. a connection test
  // used from the settings UI before enabling). Everything else 403s when off.
  ungatedRoutes?: string[];
  // Called once at boot regardless of enabled state. The plugin owns its own
  // setInterval; each tick must check ctx.enabled() first (sync-loop pattern —
  // toggling in settings takes effect on the next tick, no teardown needed).
  start?(ctx: PluginContext): void;
  // Nav badge from in-memory state — must not do I/O.
  badge?(): number | null;
  // Allowlist/sanitize a settings patch before it is merged into the slice
  // (per-plugin analogue of the /api/settings field allowlist).
  sanitizeSettings?(
    raw: PluginSettings,
    current: PluginSettings,
  ): PluginSettings;
  // Redact the slice for GET — never echo tokens, return hasToken booleans.
  settingsView?(slice: PluginSettings): PluginSettings;
}
