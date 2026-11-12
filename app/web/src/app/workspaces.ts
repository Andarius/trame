import { useSyncExternalStore } from "react";

// A workspace is a card's last place in the app (its URL query), so you can get back to what you were doing.
// "home" holds the work that belongs to no card; it is always first and never closes.
export const HOME = "home";
export type Workspace = { id: string; name: string | null; search: string };
export type Workspaces = { list: Workspace[]; active: string; mru: string[] };

const KEY = "trame:workspaces";
const EMPTY: Workspaces = { list: [{ id: HOME, name: null, search: "" }], active: HOME, mru: [HOME] };

// the card a location belongs to: the card view, a card's shells, its spec page or its open drawer
export function cardOfLocation(q: URLSearchParams, specPages: ReadonlyMap<string, string>): string | null {
  const view = q.get("view") ?? (q.get("card") ? "card" : q.get("page") ? "page" : "board");
  if (view === "card") return q.get("card");
  if (view === "terminals") {
    const term = q.get("term");
    return term && !["all", "plain", "history"].includes(term) && !/^(project|term|recent):/.test(term) ? term : null;
  }
  if (view === "page") return specPages.get(q.get("page") ?? "") ?? null;
  return null;
}

const touch = (mru: string[], id: string) => [id, ...mru.filter((x) => x !== id)];

// make `id` the active workspace, creating it at the end when new
export function activate(s: Workspaces, id: string, search?: string): Workspaces {
  const known = s.list.some((w) => w.id === id);
  const list = known ? s.list : [...s.list, { id, name: null, search: search ?? "" }];
  return { list, active: id, mru: touch(s.mru, id) };
}

// remember where the active workspace is now
export function save(s: Workspaces, search: string): Workspaces {
  return { ...s, list: s.list.map((w) => (w.id === s.active ? { ...w, search } : w)) };
}

// close workspaces (never home); closing the active one falls back to the most recent other
export function close(s: Workspaces, ids: Iterable<string>): Workspaces {
  const gone = new Set([...ids].filter((id) => id !== HOME));
  if (![...gone].some((id) => s.list.some((w) => w.id === id))) return s;
  const mru = s.mru.filter((id) => !gone.has(id));
  return {
    list: s.list.filter((w) => !gone.has(w.id)),
    active: gone.has(s.active) ? mru[0] ?? HOME : s.active,
    mru: mru.length ? mru : [HOME],
  };
}

// the workspace Ctrl+Tab goes to: the one used before the active one
export const previous = (s: Workspaces) => s.mru.find((id) => id !== s.active) ?? null;

export function rename(s: Workspaces, id: string, name: string | null): Workspaces {
  return { ...s, list: s.list.map((w) => (w.id === id ? { ...w, name: name?.trim() || null } : w)) };
}

// move a workspace one step left or right; home stays first
export function move(s: Workspaces, id: string, by: -1 | 1): Workspaces {
  const i = s.list.findIndex((w) => w.id === id);
  const j = i + by;
  if (i < 1 || j < 1 || j >= s.list.length) return s;
  const list = [...s.list];
  [list[i], list[j]] = [list[j], list[i]];
  return { ...s, list };
}

// a stored value, checked: anything unreadable starts over from home alone
export function parse(raw: string | null): Workspaces {
  try {
    const v = JSON.parse(raw ?? "null") as Workspaces | null;
    if (!v || !Array.isArray(v.list) || !v.list.every((w) => typeof w?.id === "string" && typeof w.search === "string")) {
      return EMPTY;
    }
    const list = v.list.some((w) => w.id === HOME) ? v.list : [EMPTY.list[0], ...v.list];
    const ids = new Set(list.map((w) => w.id));
    const active = ids.has(v.active) ? v.active : HOME;
    const mru = Array.isArray(v.mru) ? v.mru.filter((id) => ids.has(id)) : [];
    return { list, active, mru: mru.length ? mru : [active] };
  } catch {
    return EMPTY;
  }
}

// per machine, in localStorage (no hub sync); storage can be missing or throw
let state: Workspaces = (() => {
  try {
    return parse(localStorage.getItem(KEY));
  } catch {
    return EMPTY;
  }
})();
const listeners = new Set<() => void>();
export function setWorkspaces(f: (s: Workspaces) => Workspaces) {
  const next = f(state);
  if (next === state) return;
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // kept for this run only
  }
  for (const l of listeners) l();
}
export const getWorkspaces = () => state;
export const useWorkspaces = () =>
  useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, getWorkspaces);

// App registers how to go to a place (push it to history and show it); the rail and the keys go through here
let navigate: ((search: string) => void) | null = null;
export function onWorkspaceNavigate(f: (search: string) => void) {
  navigate = f;
  return () => {
    if (navigate === f) navigate = null;
  };
}
const placeOf = (w: Workspace) => w.search || (w.id === HOME ? "" : `?view=card&card=${encodeURIComponent(w.id)}`);
const goActive = () => {
  const w = state.list.find((x) => x.id === state.active);
  if (w) navigate?.(placeOf(w));
};

// save where we are into the current workspace, then go to where `id` was left
export function switchWorkspace(id: string) {
  if (id === state.active || !state.list.some((w) => w.id === id)) return;
  setWorkspaces((s) => activate(save(s, location.search), id));
  goActive();
}

// close workspaces; when the active one goes, show the one used before it
export function closeWorkspaces(ids: Iterable<string>) {
  const before = state.active;
  setWorkspaces((s) => close(s, ids));
  if (state.active !== before) goActive();
}

// keys a focused shell needs for itself: Ctrl+2…8 send control codes, Alt+←/→ move by word
const inTerminal = (e: Event) => e.target instanceof Element && !!e.target.closest(".xterm");

// Ctrl+1…9 a workspace, Ctrl+Tab the previous one, Alt+←/→ and the mouse's back/forward buttons walk history
export function workspaceKeys(): () => void {
  const onKey = (e: KeyboardEvent) => {
    const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
    if (ctrl && !e.shiftKey && e.key === "Tab") {
      const id = previous(state);
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      switchWorkspace(id);
    } else if (ctrl && !e.shiftKey && /^[1-9]$/.test(e.key) && !inTerminal(e)) {
      const w = state.list[Number(e.key) - 1];
      if (!w) return;
      e.preventDefault();
      e.stopPropagation();
      switchWorkspace(w.id);
    } else if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      if (inTerminal(e) || (e.target instanceof HTMLElement && e.target.isContentEditable)) return;
      e.preventDefault();
      if (e.key === "ArrowLeft") history.back();
      else history.forward();
    }
  };
  const onMouse = (e: MouseEvent) => {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault();
    if (e.button === 3) history.back();
    else history.forward();
  };
  addEventListener("keydown", onKey, true);
  addEventListener("mouseup", onMouse);
  return () => {
    removeEventListener("keydown", onKey, true);
    removeEventListener("mouseup", onMouse);
  };
}
