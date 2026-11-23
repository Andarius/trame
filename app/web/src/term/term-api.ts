// Embedded terminals: the backend owns the shells (crates/trame-local/src/pty.rs); this module
// holds the per-launch token in memory and the dock's tab list.
import { useSyncExternalStore } from "react";
import { readStore, writeStore } from "../ui/storage";
import { nextUnseen, type TermSession } from "./attention";
import { activate, addTerms, type DropSide, group, groupOf, groups, insertAt, isGroup, leaves, type PaneNode, prune, type SplitDir, splitAt } from "./pane-tree";
export { type DropSide, groups, isGroup, leaves, type PaneGroup, type PaneNode, type SplitDir } from "./pane-tree";

export type { TermSession };

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

// an image file a shell printed the path of, as an object URL the caller revokes
export async function termImage(path: string) {
  const r = await fetch(`/api/term/file?path=${encodeURIComponent(path)}`, {
    headers: { [TOKEN_HEADER]: await termToken() },
  });
  if (!r.ok) {
    const info = (await r.json().catch(() => ({}))) as Record<string, string>;
    throw new TermError(info, info.error ?? `image: ${r.status}`);
  }
  return URL.createObjectURL(await r.blob());
}

// pick a local folder for a card path that doesn't exist here; remembered by the backend
export const pickFolder = (from: string) =>
  call("/api/term/folders", { method: "POST", body: JSON.stringify({ from }) }) as Promise<
    { from: string; to: string } | { cancelled: true } | { error: string }
  >;

// the folders among `paths` that are git worktrees
export const termWorktrees = (paths: string[]) =>
  (call("/api/term/worktrees", { method: "POST", body: JSON.stringify({ paths }) }) as Promise<{ worktrees: string[] }>)
    .then((r) => new Set(r.worktrees), () => new Set<string>());

// any folder to open a shell in, from the native folder dialog opened at `start`
export const pickTermFolder = (start?: string | null) =>
  call("/api/term/pick", { method: "POST", body: JSON.stringify({ start }) }) as Promise<
    string | { cancelled: true } | { error: string }
  >;

export const MAX_PANES = 6;
// a dock tab: a split tree of panes; `focus` gets the keyboard and is always its pane's active shell
export type TermTab = { id: string; root: PaneNode; focus: string };
// what is being dragged onto the panes: a whole tab, one shell (from a tab or the sidebar), or a card from the
// Terminals column (its tab when it has one, else a new shell in its folder)
export type TermDrag =
  | { kind: "tab" | "term"; id: string }
  | { kind: "card"; id: string; tab: string | null; cwd: string | null };
// `max`: the dock fills the main area instead of sitting under the current view
// `out`: shells shown in a window of their own (TermPopout), with the pane they left
type DockState = {
  terms: Record<string, TermInfo>;
  out: Record<string, Origin>;
  tabs: TermTab[];
  active: string | null;
  open: boolean;
  max: boolean;
  drag: TermDrag | null;
};
type Origin = { tab: string; near: string | null };
let state: DockState = { terms: {}, out: {}, tabs: [], active: null, open: false, max: false, drag: null };
const listeners = new Set<() => void>();
const LAYOUT_KEY = "trame:termLayout";
const set = (next: Partial<DockState>) => {
  if (next.tabs) next = { ...next, tabs: next.tabs.map((t) => ({ ...t, root: activate(t.root, t.focus) })) };
  state = { ...state, ...next };
  if (next.tabs) writeStore(LAYOUT_KEY, JSON.stringify(state.tabs.map((t) => t.root)));
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useTermDock = () => useSyncExternalStore(subscribe, () => state);

// the cards a tab works for (a merged tab can hold several); empty for plain shells
export const tabCards = (t: TermTab, terms: Record<string, TermInfo>) => [
  ...new Set(leaves(t.root).map((id) => terms[id]?.card).filter((c): c is string => !!c)),
];
// cards with a shell still running, for the board's live-shell marker
export const liveCards = (terms: Record<string, TermInfo>) =>
  new Set(Object.values(terms).filter((t) => t.card && !t.exited).map((t) => t.card!));
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
  // shells still open in their own window (this page reloaded) stay out of the dock
  const out = Object.fromEntries([...await openPopouts()].filter((id) => terms[id]).map((id) => [id, { tab: "", near: null }]));
  let saved: PaneNode[] = [];
  try {
    saved = JSON.parse(readStore(LAYOUT_KEY) ?? "[]");
  } catch { /* corrupt layout: one tab per shell */ }
  const placed = new Set<string>();
  const tabs: TermTab[] = [];
  for (const root of Array.isArray(saved) ? saved : []) {
    const kept = prune(root, (id) => !!terms[id] && !out[id] && !placed.has(id) && !!placed.add(id));
    if (kept) tabs.push(tab(kept));
  }
  for (const t of list) if (!placed.has(t.id) && !out[t.id]) tabs.push(tab(group([t.id])));
  set({ terms, out, tabs, active: tabs[0]?.id ?? null });
}

const create = async (opts: TermOpts) => {
  const info = (await call("/api/term", { method: "POST", body: JSON.stringify(opts) })) as TermInfo;
  state = { ...state, terms: { ...state.terms, [info.id]: info } };
  return info;
};

// no cwd starts in the home directory; `command` runs first, then the shell stays;
// `into` adds it as a tab of the pane holding that shell, when that pane is still there
export async function openTerminal(opts: TermOpts, into?: { tab: string; term: string } | null) {
  const info = await create(opts);
  const dst = into && state.tabs.find((t) => t.id === into.tab && leaves(t.root).includes(into.term));
  if (dst) {
    const next = { ...dst, root: addTerms(dst.root, into!.term, [info.id]), focus: info.id };
    set({ tabs: state.tabs.map((t) => (t === dst ? next : t)), active: dst.id, open: true });
    return info;
  }
  const t = tab(group([info.id]));
  set({ tabs: [...state.tabs, t], active: t.id, open: true });
  return info;
}

// a Claude session running in a terminal outside Trame: stopped there, resumed in a new tab here;
// refused with `code: "busy"` mid-turn unless `force`
export async function moveIntoTrame(opts: { session: string; card: string | null; title: string; force?: boolean }) {
  const info = (await call("/api/term/move-in", { method: "POST", body: JSON.stringify(opts) })) as TermInfo;
  state = { ...state, terms: { ...state.terms, [info.id]: info } };
  const t = tab(group([info.id]));
  set({ tabs: [...state.tabs, t], active: t.id, open: true });
  return info;
}

// a new shell beside the `at` shell of a tab, or in a tab of its own without one (or when that tab is full)
export async function openTerminalAt(opts: TermOpts, at?: { tab: string; term: string; side: DropSide }) {
  const fits = (t?: TermTab) => !!t && leaves(t.root).includes(at!.term) && groups(t.root).length < MAX_PANES;
  if (!at || !fits(state.tabs.find((t) => t.id === at.tab))) return openTerminal(opts);
  const info = await create(opts);
  const dst = state.tabs.find((t) => t.id === at.tab);
  if (!fits(dst)) {
    const own = tab(group([info.id]));
    set({ tabs: [...state.tabs, own], active: own.id, open: true });
    return info;
  }
  const next = { ...dst!, root: insertAt(dst!.root, at.term, at.side, group([info.id])), focus: info.id };
  set({ tabs: state.tabs.map((t) => (t.id === dst!.id ? next : t)), active: dst!.id, open: true });
  return info;
}

// a new shell next to the focused one, in the same folder
// the folder a shell is in now (it may have cd'd since it started), else the one it started in
export type TermNow = { cwd: string | null; process: string | null };
// the folder a shell is in now and what runs in its foreground (the shell itself when idle)
export const termNow = async (id: string) =>
  (await call(`/api/term/${id}/now`).catch(() => null)) as TermNow | null;
export const liveCwd = async (id: string) => (await termNow(id))?.cwd ?? state.terms[id]?.cwd ?? null;

// a new shell beside the focused pane, in the folder that pane's shell is in now
export async function splitTerminal(dir: SplitDir) {
  const current = activeTab();
  if (!current) return openTerminal({ cwd: null });
  if (groups(current.root).length >= MAX_PANES) return;
  const lead = state.terms[current.focus];
  const info = await create({ cwd: await liveCwd(current.focus), card: lead?.card ?? null });
  // re-read after the awaits: the tab may have changed, filled up or closed meanwhile
  const now = state.tabs.find((t) => t.id === current.id);
  const at = now && leaves(now.root).includes(current.focus) ? current.focus : now?.focus;
  if (!now || !at || groups(now.root).length >= MAX_PANES) {
    const own = tab(group([info.id]));
    set({ tabs: [...state.tabs, own], active: own.id, open: true });
    return;
  }
  const next = { ...now, root: splitAt(now.root, at, dir, info.id), focus: info.id };
  set({ tabs: state.tabs.map((t) => (t.id === now.id ? next : t)), open: true });
}

const kill = (id: string) => call(`/api/term/${id}`, { method: "DELETE" }).catch(() => {});

// the tabs without `id`: its tab goes when its last pane does
const unplace = (id: string): Pick<DockState, "tabs" | "active" | "open" | "max"> => {
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
  return { tabs, active, open: state.open && tabs.length > 0, max: state.max && tabs.length > 0 };
};

// ends one shell
export async function closeTerminal(id: string) {
  const { [id]: _, ...terms } = state.terms;
  const { [id]: _o, ...out } = state.out;
  set({ ...unplace(id), terms, out });
  await kill(id);
}

// a background session `/fork` started, by the session it was forked from
export type Fork = {
  job: string; // what `claude attach` takes
  id: string;
  parent: string;
  name: string | null;
  intent: string | null;
  state: string | null; // blocked (waits on you), done, stopped, …
  cwd: string | null;
  updated_at: string | null;
};
export const termForks = () => call("/api/term/forks") as Promise<Fork[]>;

// stop an agent's current turn, as Esc in its shell would
export const interruptTerminal = (id: string) => call(`/api/term/${id}/interrupt`, { method: "POST" });

export async function closeTab(tabId: string) {
  const t = state.tabs.find((x) => x.id === tabId);
  for (const id of t ? leaves(t.root) : []) await closeTerminal(id);
}

export const selectTab = (id: string) => set({ active: id, open: true });

// `{transcript id: term id}` for the Claude/Codex sessions running in a live shell
export const runningAgents = () => call("/api/term/running") as Promise<Record<string, string>>;

const SESSIONS_POLL_MS = 3000;
let sessions: TermSession[] = [];
// shells whose agent finished while you looked elsewhere
let unseen: ReadonlySet<string> = new Set();
const sessionListeners = new Set<() => void>();
let sessionTimer: ReturnType<typeof setInterval> | undefined;
const pollSessions = () =>
  void (call("/api/term/sessions") as Promise<TermSession[]>).then((next) => {
    if (JSON.stringify(next) === JSON.stringify(sessions)) return;
    unseen = nextUnseen(sessions, next, unseen);
    sessions = next;
    sessionListeners.forEach((l) => l());
  }, () => {});
// the shell is in front of you: it no longer needs you for having finished
export const seeTerm = (term: string) => {
  if (!unseen.has(term)) return;
  unseen = new Set([...unseen].filter((t) => t !== term));
  sessionListeners.forEach((l) => l());
};
// polled while something shows them
const subscribeSessions = (l: () => void) => {
  sessionListeners.add(l);
  if (sessionListeners.size === 1) {
    pollSessions();
    sessionTimer = setInterval(pollSessions, SESSIONS_POLL_MS);
  }
  return () => {
    sessionListeners.delete(l);
    if (sessionListeners.size === 0) clearInterval(sessionTimer);
  };
};
export const useTermSessions = () => useSyncExternalStore(subscribeSessions, () => sessions);
export const useUnseenTerms = () => useSyncExternalStore(subscribeSessions, () => unseen);
// what a session is called: its /rename name, else the agent's own
export const sessionLabel = (s: TermSession) => s.name ?? s.agent;

// opens the dock on the tab holding `term`, focused on it; a shell no tab holds yet (opened elsewhere) gets one
export async function revealTerminal(term: string) {
  if (state.out[term]) {
    showPopout(term);
    return true;
  }
  const t = state.tabs.find((x) => leaves(x.root).includes(term));
  if (t) {
    set({ tabs: state.tabs.map((x) => (x === t ? { ...x, focus: term } : x)), active: t.id, open: true });
    return true;
  }
  const info = ((await call("/api/term")) as TermInfo[]).find((x) => x.id === term && !x.exited);
  if (!info) return false;
  const own = tab(group([term]));
  set({ terms: { ...state.terms, [term]: info }, tabs: [...state.tabs, own], active: own.id, open: true });
  return true;
}
// a whole tab dropped onto a shell of another tab: its splits join that layout (Konsole-style)
export function mergeTab(source: string, target: string, at: string, side: DropSide) {
  const src = state.tabs.find((t) => t.id === source);
  const dst = state.tabs.find((t) => t.id === target);
  if (!src || !dst || src === dst) return false;
  if (groups(src.root).length + groups(dst.root).length > MAX_PANES) return false;
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
  if (src !== dst && groups(dst.root).length >= MAX_PANES) return false;
  const rest = prune(src.root, (id) => id !== term)!;
  const tabs = state.tabs.map((t) => {
    const root = t === src ? rest : t.root;
    if (t === dst) return { ...t, root: insertAt(root, at, side, group([term])), focus: term };
    return t === src ? { ...t, root, focus: t.focus === term ? leaves(root)[0] : t.focus } : t;
  });
  set({ tabs, active: target });
  return true;
}

// a split's divider moved: `path` walks from the tab's root ("a"/"b" per level)
export function resizeSplit(tabId: string, path: string, ratio: number) {
  const walk = (n: PaneNode, rest: string): PaneNode => {
    if (isGroup(n)) return n;
    if (!rest) return { ...n, ratio };
    return rest[0] === "a" ? { ...n, a: walk(n.a, rest.slice(1)) } : { ...n, b: walk(n.b, rest.slice(1)) };
  };
  set({ tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, root: walk(t.root, path) } : t)) });
}

// shells dropped onto the middle of a pane: they leave their tabs (closing emptied ones) and join it as tabs
export function joinPane(terms: string[], target: string, at: string) {
  const dst = state.tabs.find((t) => t.id === target);
  const into = dst && groupOf(dst.root, at);
  const moving = into ? terms.filter((t) => !into.terms.includes(t)) : [];
  if (!moving.length) return false;
  const tabs: TermTab[] = [];
  for (const t of state.tabs) {
    let root = prune(t.root, (id) => !moving.includes(id));
    if (!root) continue;
    if (t.id === target) root = addTerms(root, at, moving);
    const focus = t.id === target ? moving.at(-1)! : leaves(root).includes(t.focus) ? t.focus : leaves(root)[0];
    tabs.push({ ...t, root, focus });
  }
  set({ tabs, active: target });
  return true;
}

export const setTermDrag = (drag: TermDrag | null) => set({ drag });

// where a drag was last seen over the window: WebKitGTK ends a drag dropped outside it at 0,0
let lastOver: { x: number; y: number } | null = null;
globalThis.addEventListener?.("dragover", (e) => (lastOver = { x: e.clientX, y: e.clientY }), true);
const EDGE = 48;
// a drag no drop target took, released outside the window
export function droppedOutside(e: DragEvent): boolean {
  if (e.dataTransfer?.dropEffect !== "none") return false;
  const { x, y } = e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : lastOver ?? { x: innerWidth / 2, y: innerHeight / 2 };
  const margin = e.clientX || e.clientY ? 0 : EDGE;
  return x < margin || y < margin || x > innerWidth - margin || y > innerHeight - margin;
}
export const focusPane = (tabId: string, pane: string) =>
  set({ tabs: state.tabs.map((t) => (t.id === tabId && t.focus !== pane ? { ...t, focus: pane } : t)) });
export const setDockOpen = (open: boolean) => set({ open });
export const setDockMax = (max: boolean) => set({ max, open: true });

// links a running shell to a card (null unlinks): the card then lists and shows it
export async function linkTermCard(id: string, card: string | null) {
  const info = (await call(`/api/term/${id}`, { method: "PATCH", body: JSON.stringify({ card }) })) as TermInfo;
  set({ terms: { ...state.terms, [id]: info } });
}

// Popouts: a shell in a window of its own. The windows and the dock talk over a BroadcastChannel; the desktop
// app (trame-desktop main.rs) opens `/?popout=<id>` as a window and posts `close` when one is shut.
export type PopoutMsg = { open: string } | { close: string } | { exit: string } | { ping: true };
export const POPOUT_CHANNEL = "trame:term-popout";
export const popoutUrl = (id: string) => `/?popout=${encodeURIComponent(id)}`;
const popoutName = (id: string) => `trame-term-${id}`;
const windows = new Map<string, Window>();

// the shells some window shows now, from their answers to a ping
const openPopouts = () =>
  new Promise<Set<string>>((resolve) => {
    if (typeof BroadcastChannel === "undefined") return resolve(new Set());
    const ch = new BroadcastChannel(POPOUT_CHANNEL);
    const seen = new Set<string>();
    ch.onmessage = (e: MessageEvent<PopoutMsg>) => "open" in e.data && seen.add(e.data.open);
    ch.postMessage({ ping: true } satisfies PopoutMsg);
    setTimeout(() => {
      ch.close();
      resolve(seen);
    }, 250);
  });

// raises the shell's window, or opens it (the desktop app focuses one it already has)
const showPopout = (id: string) => {
  const w = windows.get(id);
  if (w && !w.closed) return w.focus();
  const opened = globalThis.open?.(popoutUrl(id), popoutName(id), "popup,width=900,height=560");
  if (opened) windows.set(id, opened);
};

// the shell leaves the dock for a window of its own; closing that window brings it back
export function popOut(id: string) {
  const t = state.tabs.find((x) => leaves(x.root).includes(id));
  if (!t) return;
  const near = groupOf(t.root, id)!.terms.find((x) => x !== id) ?? leaves(t.root).find((x) => x !== id) ?? null;
  set({ ...unplace(id), out: { ...state.out, [id]: { tab: t.id, near } } });
  showPopout(id);
}

// back from its window: into the pane it left when that is still there, else a tab of its own
export function popIn(id: string) {
  const from = state.out[id];
  if (!from) return;
  const { [id]: _, ...out } = state.out;
  windows.delete(id);
  if (!state.terms[id]) return set({ out });
  const dst = state.tabs.find((t) => t.id === from.tab && from.near && leaves(t.root).includes(from.near));
  if (dst) {
    const next = { ...dst, root: addTerms(dst.root, from.near!, [id]), focus: id };
    return set({ out, tabs: state.tabs.map((t) => (t === dst ? next : t)), active: dst.id, open: true });
  }
  const own = tab(group([id]));
  set({ out, tabs: [...state.tabs, own], active: own.id, open: true });
}

// the dock's side: a window that opened (after this page reloaded too) holds its shell, one closed gives it back
export function watchPopouts() {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const ch = new BroadcastChannel(POPOUT_CHANNEL);
  ch.onmessage = (e: MessageEvent<PopoutMsg>) => {
    const m = e.data;
    if ("close" in m) popIn(m.close);
    else if ("exit" in m) void closeTerminal(m.exit);
    else if ("open" in m && !state.out[m.open] && state.terms[m.open]) {
      const t = state.tabs.find((x) => leaves(x.root).includes(m.open));
      set({ ...unplace(m.open), out: { ...state.out, [m.open]: { tab: t?.id ?? "", near: null } } });
    }
  };
  return () => ch.close();
}
