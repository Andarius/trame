// Compile-time plugin registry. main.ts routes /api/plugins/* here and calls
// startPlugins() once at boot; nothing else in the app knows about plugins.
import type { Plugin, PluginContext, PluginManifest } from "./types.ts";
import {
  getPluginSettings,
  isPluginEnabled,
  savePluginSettings,
  setPluginEnabled,
} from "./settings.ts";
import deployments from "./deployments/mod.ts";
import cockpit from "./cockpit/mod.ts";

export const PLUGINS: Plugin[] = [deployments, cockpit];

const byId = new Map(PLUGINS.map((p) => [p.id, p]));

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

const ctxFor = (p: Plugin): PluginContext => ({
  enabled: () => isPluginEnabled(p.id),
  settings: () => getPluginSettings(p.id),
});

export async function listPluginManifests(): Promise<PluginManifest[]> {
  const out: PluginManifest[] = [];
  for (const p of PLUGINS) {
    out.push({
      id: p.id,
      label: p.label,
      glyph: p.glyph,
      description: p.description,
      enabled: await isPluginEnabled(p.id),
      badge: p.badge?.() ?? null,
    });
  }
  return out;
}

export function startPlugins(): void {
  for (const p of PLUGINS) p.start?.(ctxFor(p));
}

// /api/plugins/<id>/enable and /settings are registry-owned and NOT gated on
// enabled (a plugin is configured before it is switched on); everything else
// dispatches to the plugin and 403s while disabled.
export async function handlePluginRoute(
  req: Request,
  url: URL,
): Promise<Response> {
  const m = url.pathname.match(/^\/api\/plugins\/([^/]+)(\/.*)?$/);
  const plugin = m ? byId.get(m[1]) : undefined;
  if (!plugin) return json({ error: "unknown plugin" }, 404);
  const subPath = m![2] ?? "/";

  if (subPath === "/enable" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const enabled = body.enabled === true;
    await setPluginEnabled(plugin.id, enabled);
    if (enabled) plugin.onEnabled?.(); // the start() loop may be an idle interval away
    return json({ enabled });
  }
  if (subPath === "/settings") {
    if (req.method === "POST") {
      const raw = await req.json().catch(() => ({}));
      const current = await getPluginSettings(plugin.id);
      const patch = plugin.sanitizeSettings?.(raw, current) ?? {};
      await savePluginSettings(plugin.id, patch);
    }
    const slice = await getPluginSettings(plugin.id);
    return json({
      ...(plugin.settingsView?.(slice) ?? slice),
      enabled: slice.enabled === true,
    });
  }

  if (
    !plugin.ungatedRoutes?.includes(subPath) &&
    !(await isPluginEnabled(plugin.id))
  ) {
    return json({ error: "plugin disabled" }, 403);
  }
  return (await plugin.routes(req, subPath, url)) ??
    json({ error: "not found" }, 404);
}
