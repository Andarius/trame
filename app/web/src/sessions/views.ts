import { useSyncExternalStore } from "react";
import { getSettings, patchSettings } from "../api";

export type Group = "none" | "story" | "project";
// a named session query, shown as a chip under the query box
export type BoardView = { name: string; q: string; group: Group };

// stored per machine in settings.json (`boardViews`); the server normalizes them
const subs = new Set<() => void>();
let views: BoardView[] = [];
let loaded = false;

const emit = (next: BoardView[]) => {
  views = next;
  subs.forEach((f) => f());
};

function subscribe(f: () => void) {
  subs.add(f);
  if (!loaded) {
    loaded = true;
    getSettings().then((s) => emit(s.boardViews ?? [])).catch(() => (loaded = false));
  }
  return () => subs.delete(f);
}

export const useBoardViews = () => useSyncExternalStore(subscribe, () => views);

const store = (next: BoardView[]) =>
  patchSettings({ boardViews: next }).then((s) => emit(s.boardViews ?? []));

// add or replace by name (case-insensitive)
export const saveView = (v: BoardView) =>
  store([...views.filter((x) => x.name.toLowerCase() !== v.name.toLowerCase()), v]);

export const deleteView = (name: string) => store(views.filter((x) => x.name !== name));

export const sameQuery = (a: string, b: string) => a.trim().split(/\s+/).join(" ") === b.trim().split(/\s+/).join(" ");
