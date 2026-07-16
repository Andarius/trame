// Focused settings modal for a single plugin — opened from the plugin's own
// panel (its ⚙ button) so you can configure it without going through the
// full plugins manager. Same shell as PluginsModal, minus the plugin list.
import { useEffect, useState } from "react";
import { getPlugins, type PluginManifest, setPluginEnabled } from "../api";
import { FRONTEND_PLUGINS } from "./index";
import { Toggle } from "./PluginsModal";

export function PluginSettingsModal(
  { pluginId, onClose }: { pluginId: string; onClose: () => void },
) {
  const [manifest, setManifest] = useState<PluginManifest | null>(null);

  useEffect(() => {
    getPlugins().then((ps) =>
      setManifest(ps.find((p) => p.id === pluginId) ?? null)
    )
      .catch(() => {});
  }, [pluginId]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", h);
    return () => removeEventListener("keydown", h);
  }, [onClose]);

  const Settings = FRONTEND_PLUGINS.find((f) => f.id === pluginId)?.Settings;
  const toggle = (v: boolean) => {
    setManifest((m) => (m ? { ...m, enabled: v } : m));
    setPluginEnabled(pluginId, v).catch(() => {});
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-[620px] flex-col overflow-hidden rounded-xl border border-[#323649] bg-[#171923] shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-5 py-3.5">
          <span className="text-[12px] text-copper">{manifest?.glyph ?? ""}</span>
          <span className="text-[13.5px] font-semibold">
            {manifest?.label ?? "Plugin"}
          </span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">
            {manifest?.description ?? ""}
          </span>
          <span className="text-[10px] font-medium tracking-[0.4px] text-ink-muted/80">
            ENABLED
          </span>
          <Toggle on={manifest?.enabled ?? false} onChange={toggle} />
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto p-5">
          {Settings
            ? <Settings />
            : (
              <p className="m-0 text-[12px] text-ink-muted">
                Nothing to configure.
              </p>
            )}
        </div>
        <div className="flex items-center gap-2 border-t border-line bg-sidebar px-5 py-3">
          <span className="flex-1 text-[10.5px] text-ink-muted/85">
            stored per-machine (not synced) · tokens never leave this device
          </span>
          <button
            type="button"
            className="rounded-md px-2.5 py-1.5 text-xs text-ink-muted hover:text-ink-soft"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
