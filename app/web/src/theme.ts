// Light/dark theme — persisted per-machine, not synced. "system" follows the
// OS via prefers-color-scheme (styles.css); light/dark force it via data-theme.
import { readStore, writeStore } from "./storage";

const KEY = "trame:theme";

export type Theme = "system" | "light" | "dark";

export function getTheme(): Theme {
  const v = readStore(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function applyTheme(theme: Theme) {
  writeStore(KEY, theme);
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}
