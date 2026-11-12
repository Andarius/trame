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
