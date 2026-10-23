// Light/dark theme — persisted per-machine, not synced. "system" follows the
// OS via prefers-color-scheme (styles.css); light/dark force it via data-theme.
import { useSyncExternalStore } from "react";
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

export type Resolved = "light" | "dark";

const LIGHT = "(prefers-color-scheme: light)";

export function resolvedTheme(): Resolved {
  const forced = document.documentElement.dataset.theme;
  if (forced === "light" || forced === "dark") return forced;
  return matchMedia(LIGHT).matches ? "light" : "dark";
}

// the theme in effect right now (explicit choice or the OS), re-read on either changing
export function useResolvedTheme(): Resolved {
  return useSyncExternalStore((notify) => {
    const mq = matchMedia(LIGHT);
    mq.addEventListener("change", notify);
    const obs = new MutationObserver(notify);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      mq.removeEventListener("change", notify);
      obs.disconnect();
    };
  }, resolvedTheme);
}
