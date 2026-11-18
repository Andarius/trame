// A dock tab's layout: a split tree whose leaves are panes of shells. Pure, so it is unit-tested.
export type SplitDir = "row" | "col";
// `row` puts `a` left of `b`, `col` above it
// a pane: shells shown as tabs, `active` the one on screen
export type PaneGroup = { group: string; terms: string[]; active: string };
// `ratio`: the share of `a`, 0.5 when unset
export type PaneNode = PaneGroup | { dir: SplitDir; a: PaneNode; b: PaneNode; ratio?: number };
export type DropSide = "left" | "right" | "top" | "bottom";
// `sub` beside the `at` shell: left/top put it first, right/bottom after
export const insertAt = (n: PaneNode, at: string, side: DropSide, sub: PaneNode): PaneNode => {
  if (!isGroup(n)) return { ...n, a: insertAt(n.a, at, side, sub), b: insertAt(n.b, at, side, sub) };
  if (!n.terms.includes(at)) return n;
  const dir: SplitDir = side === "left" || side === "right" ? "row" : "col";
  return side === "left" || side === "top" ? { dir, a: sub, b: n } : { dir, a: n, b: sub };
};

export const isGroup = (n: PaneNode): n is PaneGroup => "group" in n;
// every shell of a tree, pane by pane
export const leaves = (n: PaneNode): string[] => (isGroup(n) ? n.terms : [...leaves(n.a), ...leaves(n.b)]);
// the panes of a tree; MAX_PANES counts these
export const groups = (n: PaneNode): PaneGroup[] => (isGroup(n) ? [n] : [...groups(n.a), ...groups(n.b)]);
export const group = (terms: string[], active?: string): PaneGroup => ({
  group: crypto.randomUUID(),
  terms,
  active: active ?? terms.at(-1)!,
});
// the pane holding `term` shows it; unchanged nodes are returned as is
export const activate = (n: PaneNode, term: string): PaneNode => {
  if (isGroup(n)) return n.terms.includes(term) && n.active !== term ? { ...n, active: term } : n;
  const a = activate(n.a, term);
  const b = activate(n.b, term);
  return a === n.a && b === n.b ? n : { ...n, a, b };
};
// the tree with only the shells `keep` accepts, or null when nothing is left; empty panes and splits fold away
export const prune = (n: PaneNode, keep: (term: string) => boolean): PaneNode | null => {
  if (typeof n !== "object" || n === null) return null; // saved layouts are untrusted input
  // a layout saved before panes held tabs: a leaf was one shell
  const legacy = (n as { term?: unknown }).term;
  if (legacy !== undefined) return typeof legacy === "string" && keep(legacy) ? group([legacy]) : null;
  if (isGroup(n)) {
    if (!Array.isArray(n.terms)) return null;
    const terms = n.terms.filter((t) => typeof t === "string" && keep(t));
    if (!terms.length) return null;
    // a closed active shell hands over to the one that took its place
    const at = n.terms.indexOf(n.active);
    const active = terms.includes(n.active) ? n.active : terms[Math.min(Math.max(at, 0), terms.length - 1)];
    return { group: typeof n.group === "string" ? n.group : crypto.randomUUID(), terms, active };
  }
  if (!n.a || !n.b || (n.dir !== "row" && n.dir !== "col")) return null;
  const a = prune(n.a, keep);
  const b = prune(n.b, keep);
  const ratio = typeof n.ratio === "number" && n.ratio > 0 && n.ratio < 1 ? n.ratio : undefined;
  return a && b ? { dir: n.dir, a, b, ...(ratio ? { ratio } : {}) } : a ?? b;
};
// a new pane holding `term` beside the pane holding `at`
export const splitAt = (n: PaneNode, at: string, dir: SplitDir, term: string): PaneNode =>
  isGroup(n)
    ? (n.terms.includes(at) ? { dir, a: n, b: group([term]) } : n)
    : { ...n, a: splitAt(n.a, at, dir, term), b: splitAt(n.b, at, dir, term) };
