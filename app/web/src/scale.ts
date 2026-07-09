// Interface scale — the UI uses hardcoded px sizes, so we scale the whole root
// with CSS `zoom` (fonts + layout together). Persisted per-machine, not synced.

const KEY = "trame:ui-scale";

export const SCALES = [0.9, 1, 1.1, 1.25, 1.5] as const;

export function getScale(): number {
  const v = Number(localStorage.getItem(KEY));
  return Number.isFinite(v) && v > 0 ? v : 1;
}

export function applyScale(scale: number) {
  localStorage.setItem(KEY, String(scale));
  document.documentElement.style.zoom = String(scale);
}
