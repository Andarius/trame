// Plugin settings live under a top-level `plugins.<id>` key in the device-local
// settings JSON, via the serialized store (the slice may hold forge tokens).
import { readSettings, updateSettings } from "../settings-store.ts";
import type { PluginSettings } from "./types.ts";

function slices(all: Record<string, unknown>): Record<string, PluginSettings> {
  return (all.plugins ?? {}) as Record<string, PluginSettings>;
}

export async function getPluginSettings(id: string): Promise<PluginSettings> {
  return slices(await readSettings())[id] ?? {};
}

export async function isPluginEnabled(id: string): Promise<boolean> {
  // Disabled by default: a networked plugin must never start scanning
  // external services just because the app was installed or updated.
  return (await getPluginSettings(id)).enabled === true;
}

export async function savePluginSettings(
  id: string,
  patch: PluginSettings,
): Promise<void> {
  await updateSettings((settings) => {
    const plugins = slices(settings);
    plugins[id] = { ...plugins[id], ...patch };
    settings.plugins = plugins;
  });
}

export async function setPluginEnabled(
  id: string,
  enabled: boolean,
): Promise<void> {
  await savePluginSettings(id, { enabled });
}
