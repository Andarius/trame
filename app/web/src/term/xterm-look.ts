import type { ITheme } from "@xterm/xterm";

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
export const FONT_STACK = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
// Trame's own colors, used when no Ghostty config is found
export const theme = (): ITheme => ({
  background: css("--color-block"),
  foreground: css("--color-ink"),
  cursor: css("--color-copper"),
  cursorAccent: css("--color-block"),
  selectionBackground: `${css("--color-copper")}55`,
});
// xterm's own scrollbar slider, readable on either theme (a Ghostty theme sets none)
export const scrollbar = (): ITheme => ({
  scrollbarSliderBackground: `${css("--color-ink-faint")}66`,
  scrollbarSliderHoverBackground: `${css("--color-ink-faint")}99`,
  scrollbarSliderActiveBackground: `${css("--color-ink-faint")}cc`,
});
// web-links' own URL pattern, plus file:// like a desktop terminal
export const URL_RE = /(https?|HTTPS?|file):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/;

// Ctrl/⌘ + = - 0 in a focused shell: every shell's font, a pixel a step, kept per machine
const ZOOM_KEY = "trame:termFontStep";
const ZOOM_EVENT = "trame:term-zoom";
const fontStep = () => {
  try {
    return Number(localStorage.getItem(ZOOM_KEY)) || 0;
  } catch {
    return 0;
  }
};
export const termFontSize = (base: number) => Math.min(32, Math.max(8, base + fontStep()));
// for attachCustomKeyEventHandler: true when `e` was a zoom key, so xterm leaves it alone
export function termZoomKey(e: KeyboardEvent): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
  const step = e.key === "=" || e.key === "+" || e.code === "NumpadAdd"
    ? 1
    : e.key === "-" || e.code === "NumpadSubtract"
    ? -1
    : e.key === "0" || e.code === "Numpad0"
    ? 0
    : null;
  if (step === null) return false;
  e.preventDefault();
  if (e.type !== "keydown") return true;
  const next = step === 0 ? 0 : Math.min(19, Math.max(-5, fontStep() + step));
  try {
    localStorage.setItem(ZOOM_KEY, String(next));
  } catch {
    // this run only
  }
  dispatchEvent(new Event(ZOOM_EVENT));
  return true;
}
export function onTermZoom(f: () => void) {
  addEventListener(ZOOM_EVENT, f);
  return () => removeEventListener(ZOOM_EVENT, f);
}
