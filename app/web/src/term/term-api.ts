// Embedded terminals: the backend owns the shells (crates/trame-local/src/pty.rs); this module
// holds the per-launch token in memory and the dock's tab list.
import { useSyncExternalStore } from "react";
import { readStore, writeStore } from "../ui/storage";

// `card`: the card the shell was opened for (Open in agent, the Terminals view), else null
// `project`: the project a shell without a card was opened for
export type TermInfo = {
  id: string;
  title: string;
  cwd: string;
  card: string | null;
  project?: string | null;
  exited: boolean;
};
export type TermOpts = {
  cwd?: string | null;
  command?: string;
  title?: string;
  card?: string | null;
  project?: string | null;
};
export const TOKEN_HEADER = "x-trame-term";
// close codes from pty.rs
export const CLOSE_AUTH = 4401;
export const CLOSE_GONE = 4404;
export const CLOSE_SUPERSEDED = 4000;

let token: Promise<string> | null = null;
// fetched once per page and kept out of storage; `fresh` refetches after the backend restarted
export const termToken = (fresh = false) => {
  if (fresh || !token) {
    token = fetch("/api/term/token", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`term token: ${r.status}`))))
      .then((d: { token: string }) => d.token);
    token.catch(() => (token = null));
  }
  return token;
};

// Ghostty's font and colors when it is installed (pty.rs reads its config), else null
export type TermTheme = {
  source: string;
  fontFamily: string | null;
  fontSize: number | null;
  theme: Record<string, string>;
};
let theme: Promise<TermTheme | null> | null = null;
export const termTheme = () =>
  (theme ??= call("/api/term/theme").then((t) => (t as TermTheme | null), () => null));

// agent CLIs installed for the user (pty.rs asks their login shell), for the + menu
export type TermAgent = { command: string; label: string };
let agents: Promise<TermAgent[]> | null = null;
export const termAgents = () =>
  (agents ??= call("/api/term/agents").then((a) => a as TermAgent[], () => {
    agents = null; // retry next time the menu opens
    return [];
  }));

const call = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(path, {
    ...init,
    headers: { ...init.headers, [TOKEN_HEADER]: await termToken(), "content-type": "application/json" },
  });
  if (!r.ok) {
    const info = (await r.json().catch(() => ({}))) as Record<string, string>;
    throw new TermError(info, info.error ?? `terminal: ${r.status}`);
  }
  return r.json();
};

// a refused request with the backend's details, e.g. `code: "missing_cwd"`
export class TermError extends Error {
  constructor(readonly info: Record<string, string>, message: string) {
    super(message);
  }
}

// pick a local folder for a card path that doesn't exist here; remembered by the backend
export const pickFolder = (from: string) =>
  call("/api/term/folders", { method: "POST", body: JSON.stringify({ from }) }) as Promise<
    { from: string; to: string } | { cancelled: true } | { error: string }
  >;

// any folder to open a shell in, from the native folder dialog opened at `start`
export const pickTermFolder = (start?: string | null) =>
  call("/api/term/pick", { method: "POST", body: JSON.stringify({ start }) }) as Promise<
    string | { cancelled: true } | { error: string }
  >;

export const MAX_PANES = 6;
export type SplitDir = "row" | "col";
// a split tree: leaves are shells; `row` puts `a` left of `b`, `col` above it
export type PaneNode = { term: string } | { dir: SplitDir; a: PaneNode; b: PaneNode };
// a dock tab: a split tree of shells; `focus` gets the keyboard
export type TermTab = { id: string; root: PaneNode; focus: string };
// what is being dragged onto the panes: a whole tab, one shell (from a tab or the sidebar), or a card from the
// Terminals column (its tab when it has one, else a new shell in its folder)
export type TermDrag =
  | { kind: "tab" | "term"; id: string }
  | { kind: "card"; id: string; tab: string | null; cwd: string | null };
// `max`: the dock fills the main area instead of sitting under the current view
type DockState = {
  terms: Record<string, TermInfo>;
  tabs: TermTab[];
  active: string | null;
  open: boolean;
  max: boolean;
  drag: TermDrag | null;
};
let state: DockState = { terms: {}, tabs: [], active: null, open: false, max: false, drag: null };
const listeners = new Set<() => void>();
const LAYOUT_KEY = "trame:termLayout";
const set = (next: Partial<DockState>) => {
  state = { ...state, ...next };
  if (next.tabs) writeStore(LAYOUT_KEY, JSON.stringify(state.tabs.map((t) => t.root)));
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useTermDock = () => useSyncExternalStore(subscribe, () => state);

export const leaves = (n: PaneNode): string[] => ("term" in n ? [n.term] : [...leaves(n.a), ...leaves(n.b)]);
// the cards a tab works for (a merged tab can hold several); empty for plain shells
export const tabCards = (t: TermTab, terms: Record<string, TermInfo>) => [
  ...new Set(leaves(t.root).map((id) => terms[id]?.card).filter((c): c is string => !!c)),
];
// cards with a shell still running, for the board's live-shell marker
export const liveCards = (terms: Record<string, TermInfo>) =>
  new Set(Object.values(terms).filter((t) => t.card && !t.exited).map((t) => t.card!));
// the tree without `term`, or null when nothing is left; keeps only shells `keep` accepts
const prune = (n: PaneNode, keep: (term: string) => boolean): PaneNode | null => {
  if (typeof n !== "object" || n === null) return null; // saved layouts are untrusted input
  if ("term" in n) return typeof n.term === "string" && keep(n.term) ? n : null;
  if (!n.a || !n.b || (n.dir !== "row" && n.dir !== "col")) return null;
  const a = prune(n.a, keep);
  const b = prune(n.b, keep);
  return a && b ? { ...n, a, b } : a ?? b;
};
const splitAt = (n: PaneNode, at: string, dir: SplitDir, term: string): PaneNode =>
  "term" in n
    ? (n.term === at ? { dir, a: n, b: { term } } : n)
    : { ...n, a: splitAt(n.a, at, dir, term), b: splitAt(n.b, at, dir, term) };

const tab = (root: PaneNode, focus?: string): TermTab => ({
  id: crypto.randomUUID(),
  root,
  focus: focus ?? leaves(root).at(-1)!,
});
const activeTab = () => state.tabs.find((t) => t.id === state.active);

// re-adopt the shells that outlived a page reload, in the splits they were in
export async function restoreTerminals() {
  let list: TermInfo[];
  try {
    list = (await call("/api/term")) as TermInfo[];
  } catch {
    return; // not served here (link view, old backend)
  }
  // shells that exited while no window watched close now, as they would have live
  for (const t of list.filter((t) => t.exited)) void kill(t.id);
  list = list.filter((t) => !t.exited);
  if (!list.length) return;
  const terms = Object.fromEntries(list.map((t) => [t.id, t]));
  let saved: PaneNode[] = [];
  try {
    saved = JSON.parse(readStore(LAYOUT_KEY) ?? "[]");
  } catch { /* corrupt layout: one tab per shell */ }
  const placed = new Set<string>();
  const tabs: TermTab[] = [];
  for (const root of Array.isArray(saved) ? saved : []) {
    const kept = prune(root, (id) => !!terms[id] && !placed.has(id) && !!placed.add(id));
    if (kept) tabs.push(tab(kept));
  }
  for (const t of list) if (!placed.has(t.id)) tabs.push(tab({ term: t.id }));
  set({ terms, tabs, active: tabs[0].id });
}

const create = async (opts: TermOpts) => {
  const info = (await call("/api/term", { method: "POST", body: JSON.stringify(opts) })) as TermInfo;
  state = { ...state, terms: { ...state.terms, [info.id]: info } };
  return info;
};

// no cwd starts in the home directory; `command` runs first, then the shell stays
export async function openTerminal(opts: TermOpts) {
  const info = await create(opts);
  const t = tab({ term: info.id });
  set({ tabs: [...state.tabs, t], active: t.id, open: true });
  return info;
}

// a new shell beside the `at` shell of a tab, or in a tab of its own without one (or when that tab is full)
export async function openTerminalAt(opts: TermOpts, at?: { tab: string; term: string; side: DropSide }) {
  const fits = (t?: TermTab) => !!t && leaves(t.root).includes(at!.term) && leaves(t.root).length < MAX_PANES;
  if (!at || !fits(state.tabs.find((t) => t.id === at.tab))) return openTerminal(opts);
  const info = await create(opts);
  const dst = state.tabs.find((t) => t.id === at.tab);
  if (!fits(dst)) {
    const own = tab({ term: info.id });
    set({ tabs: [...state.tabs, own], active: own.id, open: true });
    return info;
  }
  const next = { ...dst!, root: insertAt(dst!.root, at.term, at.side, { term: info.id }), focus: info.id };
  set({ tabs: state.tabs.map((t) => (t.id === dst!.id ? next : t)), active: dst!.id, open: true });
  return info;
}

// a new shell next to the focused one, in the same folder
export async function splitTerminal(dir: SplitDir) {
  const current = activeTab();
  if (!current) return openTerminal({ cwd: null });
  if (leaves(current.root).length >= MAX_PANES) return;
  const lead = state.terms[current.focus];
  const info = await create({ cwd: lead?.cwd ?? null, card: lead?.card ?? null });
  const next = { ...current, root: splitAt(current.root, current.focus, dir, info.id), focus: info.id };
  set({ tabs: state.tabs.map((t) => (t.id === current.id ? next : t)), open: true });
}

const kill = (id: string) => call(`/api/term/${id}`, { method: "DELETE" }).catch(() => {});

// ends one shell; its tab goes when its last pane does
export async function closeTerminal(id: string) {
  const i = state.tabs.findIndex((t) => leaves(t.root).includes(id));
  const tabs: TermTab[] = [];
  for (const t of state.tabs) {
    const order = leaves(t.root);
    if (!order.includes(id)) {
      tabs.push(t);
      continue;
    }
    const root = prune(t.root, (term) => term !== id);
    if (!root) continue;
    const rest = leaves(root);
    const near = rest[Math.min(order.indexOf(id), rest.length - 1)];
    tabs.push({ ...t, root, focus: t.focus === id ? near : t.focus });
  }
  const gone = !tabs.some((t) => t.id === state.active);
  const active = gone ? (tabs[Math.min(i, tabs.length - 1)]?.id ?? null) : state.active;
  const { [id]: _, ...terms } = state.terms;
  set({ terms, tabs, active, open: state.open && tabs.length > 0, max: state.max && tabs.length > 0 });
  await kill(id);
}

export async function closeTab(tabId: string) {
  const t = state.tabs.find((x) => x.id === tabId);
  for (const id of t ? leaves(t.root) : []) await closeTerminal(id);
}

export const selectTab = (id: string) => set({ active: id, open: true });
export type DropSide = "left" | "right" | "top" | "bottom";
// `sub` beside the `at` shell: left/top put it first, right/bottom after
const insertAt = (n: PaneNode, at: string, side: DropSide, sub: PaneNode): PaneNode => {
  if (!("term" in n)) return { ...n, a: insertAt(n.a, at, side, sub), b: insertAt(n.b, at, side, sub) };
  if (n.term !== at) return n;
  const dir: SplitDir = side === "left" || side === "right" ? "row" : "col";
  return side === "left" || side === "top" ? { dir, a: sub, b: n } : { dir, a: n, b: sub };
};

// a whole tab dropped onto a shell of another tab: its splits join that layout (Konsole-style)
export function mergeTab(source: string, target: string, at: string, side: DropSide) {
  const src = state.tabs.find((t) => t.id === source);
  const dst = state.tabs.find((t) => t.id === target);
  if (!src || !dst || src === dst) return false;
  if (leaves(src.root).length + leaves(dst.root).length > MAX_PANES) return false;
  const merged = { ...dst, root: insertAt(dst.root, at, side, src.root), focus: src.focus };
  set({ tabs: state.tabs.filter((t) => t.id !== source).map((t) => (t.id === target ? merged : t)), active: target });
  return true;
}

// one shell dropped beside another: it leaves its own tab (which closes when emptied)
export function moveTerm(term: string, target: string, at: string, side: DropSide) {
  const src = state.tabs.find((t) => leaves(t.root).includes(term));
  const dst = state.tabs.find((t) => t.id === target);
  if (!src || !dst || term === at) return false;
  if (src !== dst && leaves(src.root).length === 1) return mergeTab(src.id, target, at, side);
  if (src !== dst && leaves(dst.root).length >= MAX_PANES) return false;
  const rest = prune(src.root, (id) => id !== term)!;
  const tabs = state.tabs.map((t) => {
    const root = t === src ? rest : t.root;
    if (t === dst) return { ...t, root: insertAt(root, at, side, { term }), focus: term };
    return t === src ? { ...t, root, focus: t.focus === term ? leaves(root)[0] : t.focus } : t;
  });
  set({ tabs, active: target });
  return true;
}

export const setTermDrag = (drag: TermDrag | null) => set({ drag });
export const focusPane = (tabId: string, pane: string) =>
  set({ tabs: state.tabs.map((t) => (t.id === tabId && t.focus !== pane ? { ...t, focus: pane } : t)) });
export const setDockOpen = (open: boolean) => set({ open });
export const setDockMax = (max: boolean) => set({ max, open: true });
