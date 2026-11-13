// Settings' Plugins pages: the list, and one page per plugin. Enable/disable applies
// immediately; field edits are saved by the plugin's own Settings component.
import { useEffect, useState } from "react";
import {
  getPluginUpdates,
  getPlugins,
  openInBrowser,
  type PluginManifest,
  type PluginUpdate,
  setPluginEnabled,
} from "../api";
import { FRONTEND_PLUGINS, markPluginEnabled } from "./index";

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

function usePlugins() {
  const [plugins, setPlugins] = useState<PluginManifest[] | null>(null);
  const [updates, setUpdates] = useState<PluginUpdate[]>([]);
  useEffect(() => {
    getPlugins().then(setPlugins).catch(() => setPlugins([]));
    getPluginUpdates().then((u) => Array.isArray(u) && setUpdates(u)).catch(() => {});
  }, []);
  const toggle = (id: string, enabled: boolean) => {
    setPlugins((l) => l && l.map((p) => p.id === id ? { ...p, enabled } : p));
    markPluginEnabled(id, enabled);
    setPluginEnabled(id, enabled).catch(() => {});
  };
  const update = (id: string) => updates.find((u) => u.id === id && u.available);
  return { plugins, toggle, update };
}

const HINT = "stored per-machine in settings.json (not synced) · tokens never leave this device";

export function PluginList({ onOpen }: { onOpen: (id: string) => void }) {
  const { plugins, toggle, update } = usePlugins();
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="text-[14px] font-semibold">Plugins</span>
        {plugins && (
          <span className="text-[10.5px] text-ink-muted/70">
            {plugins.filter((p) => p.enabled).length} of {plugins.length} enabled
          </span>
        )}
      </div>
      {plugins?.length === 0 && <p className="m-0 text-[12px] text-ink-muted">No plugins.</p>}
      <div className="flex flex-col gap-1">
        {plugins?.map((p) => (
          <div
            key={p.id}
            className="flex items-center gap-2.5 rounded-lg border border-line bg-panel px-3 py-2.5"
          >
            <button
              type="button"
              onClick={() => onOpen(p.id)}
              className="flex min-w-0 flex-1 items-center gap-2.5 text-left hover:text-copper"
            >
              <span className="text-[12px] text-copper">{p.glyph}</span>
              <span className="text-[13px] font-medium">{p.label}</span>
              {p.version && <span className="text-[10.5px] text-ink-muted/80">v{p.version}</span>}
              {update(p.id) && (
                <span className="text-[10.5px] font-semibold text-copper" title="update available">↑</span>
              )}
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-muted">{p.description}</span>
            </button>
            <Toggle on={p.enabled} onChange={(v) => toggle(p.id, v)} />
          </div>
        ))}
      </div>
      <p className="m-0 text-[10.5px] text-ink-muted/85">{HINT}</p>
    </>
  );
}

export function PluginPage({ id }: { id: string }) {
  const { plugins, toggle, update: updateOf } = usePlugins();
  const cur = plugins?.find((p) => p.id === id) ?? null;
  const Settings = FRONTEND_PLUGINS.find((f) => f.id === id)?.Settings;
  const update = updateOf(id);
  if (!plugins) return null;
  if (!cur) return <p className="m-0 text-[12px] text-ink-muted">No plugin “{id}”.</p>;
  return (
    <>
      <div className="flex items-center gap-2.5">
        <span className="text-[13px] text-copper">{cur.glyph}</span>
        <span className="text-[14px] font-semibold">{cur.label}</span>
        {cur.version && <span className="text-[10.5px] text-ink-muted/80">v{cur.version}</span>}
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-muted">{cur.description}</span>
        <span className="text-[10px] font-medium tracking-[0.4px] text-ink-muted/80">ENABLED</span>
        <Toggle on={cur.enabled} onChange={(v) => toggle(cur.id, v)} />
      </div>
      {update && (
        <div className="flex flex-col gap-1 rounded-lg border border-copper/40 bg-copper/10 px-3 py-2 text-[12px]">
          <div className="flex items-center gap-2">
            <span className="font-medium text-ink">
              Update available: v{update.current} → v{update.latest}
            </span>
            <span className="flex-1" />
            {update.releaseUrl && (
              <button
                type="button"
                className="text-[11.5px] text-copper hover:underline"
                onClick={() => openInBrowser(update.releaseUrl!)}
              >
                Release notes ↗
              </button>
            )}
          </div>
          <span className="text-[11.5px] text-ink-muted">
            To install: <code>git pull</code> in the plugin's checkout, run{" "}
            <code>just plugins-install</code> in Trame's, then restart Trame.
          </span>
        </div>
      )}
      <div className="h-px bg-line" />
      {Settings ? <Settings /> : <p className="m-0 text-[12px] text-ink-muted">Nothing to configure.</p>}
      <p className="m-0 text-[10.5px] text-ink-muted/85">{HINT}</p>
    </>
  );
}
