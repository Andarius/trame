// Plugins manager — master-detail: plugin list on the left (enabled dot per
// plugin), the selected plugin's settings on the right. Enable/disable applies
// immediately; field edits are saved by the plugin's own Settings component.
import { useEffect, useState } from "react";
import { getPlugins, type PluginManifest, setPluginEnabled } from "../api";
import { FRONTEND_PLUGINS } from "./index";

export function Toggle(
  { on, onChange }: { on: boolean; onChange: (v: boolean) => void },
) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors ${
        on ? "bg-copper" : "bg-chipline"
      }`}
    >
      <span
        className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all ${
          on ? "left-4 bg-copper-ink" : "left-0.5 bg-ink-soft"
        }`}
      />
    </button>
  );
}

export function PluginsModal({ onClose }: { onClose: () => void }) {
  const [plugins, setPlugins] = useState<PluginManifest[]>([]);
  const [sel, setSel] = useState<string | null>(null);

  useEffect(() => {
    getPlugins().then((p) => {
      setPlugins(p);
      setSel((s) => s ?? p[0]?.id ?? null);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", h);
    return () => removeEventListener("keydown", h);
  }, [onClose]);

  const toggle = (id: string, enabled: boolean) => {
    setPlugins((l) => l.map((p) => p.id === id ? { ...p, enabled } : p));
    setPluginEnabled(id, enabled).catch(() => {});
  };

  const cur = plugins.find((p) => p.id === sel) ?? null;
  const Settings = FRONTEND_PLUGINS.find((f) => f.id === sel)?.Settings;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[76vh] w-[760px] flex-col overflow-hidden rounded-xl border border-overlay-border bg-panel-modal shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex min-h-0 flex-1">
          <div className="w-[190px] shrink-0 border-r border-line bg-sidebar px-2.5 py-3.5">
            <div className="px-2 pb-2 text-[10px] font-medium tracking-[0.8px] text-ink-muted/80">
              PLUGINS
            </div>
            {plugins.map((p) => (
              <button
                type="button"
                key={p.id}
                onClick={() => setSel(p.id)}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[12.5px] ${
                  p.id === sel
                    ? "bg-active-row font-medium text-ink"
                    : "text-ink-muted hover:text-ink-soft"
                }`}
              >
                <span className="text-[12px] text-copper">{p.glyph}</span>
                <span className="min-w-0 flex-1 truncate">{p.label}</span>
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    p.enabled ? "bg-[--color-active]" : "bg-chipline"
                  }`}
                  title={p.enabled ? "enabled" : "disabled"}
                />
              </button>
            ))}
          </div>
          <div className="min-w-0 flex-1 overflow-y-auto p-5">
            {cur
              ? (
                <div className="flex flex-col gap-3.5">
                  <div className="flex items-center gap-2.5">
                    <span className="text-[13.5px] font-semibold">
                      {cur.label}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">
                      {cur.description}
                    </span>
                    <span className="text-[10px] font-medium tracking-[0.4px] text-ink-muted/80">
                      ENABLED
                    </span>
                    <Toggle
                      on={cur.enabled}
                      onChange={(v) => toggle(cur.id, v)}
                    />
                  </div>
                  <div className="h-px bg-line" />
                  {Settings
                    ? <Settings />
                    : (
                      <p className="m-0 text-[12px] text-ink-muted">
                        Nothing to configure.
                      </p>
                    )}
                </div>
              )
              : <p className="m-0 text-[12px] text-ink-muted">No plugins.</p>}
          </div>
        </div>
        <div className="flex items-center gap-2 border-t border-line bg-sidebar px-5 py-3">
          <span className="flex-1 text-[10.5px] text-ink-muted/85">
            stored per-machine in settings.json (not synced) · tokens never
            leave this device
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
