import type { BoardData, LiveAgent, Project, Session } from "../api.ts";

export type LiveState = "working" | "waiting";
export type Shell = { id: string; title: string; card: string | null; exited: boolean };

// one card in the tree: its live agent, its shells, and the cards forked from it
export type CardNode = {
  card: Session;
  agent: { a: LiveAgent; state: LiveState } | null;
  shells: Shell[];
  forks: CardNode[];
};
export type StoryNode = { id: string | null; title: string; project: Project | null; cards: CardNode[] };

// waiting, then working, then a live shell, then idle; a card ranks with its busiest fork
const rank = (n: CardNode): number =>
  Math.min(
    n.agent?.state === "waiting" ? 0 : n.agent ? 1 : n.shells.some((s) => !s.exited) ? 2 : 3,
    ...n.forks.map(rank),
  );
const latest = (n: CardNode): number =>
  Math.max(n.agent?.a.at ?? 0, Date.parse(n.card.last_touched) || 0, ...n.forks.map(latest));

/**
 * What runs now, nested story → card → fork. A card is in when an agent or a shell works on it;
 * a card working on another card's spec page is that card's fork, and brings it in too.
 */
export function workingNow(
  board: BoardData,
  live: { a: LiveAgent; state: LiveState }[],
  shells: Shell[],
): StoryNode[] {
  const cards = new Map(board.sessions.map((s) => [s.id, s]));
  const bySpec = new Map(board.sessions.filter((s) => s.specs_page_id).map((s) => [s.specs_page_id!, s.id]));
  const agentOf = new Map(live.map((l) => [l.a.session_id, l]));
  const shellsOf = new Map<string, Shell[]>();
  for (const s of shells) if (s.card && cards.has(s.card)) shellsOf.set(s.card, [...(shellsOf.get(s.card) ?? []), s]);

  // fork → parent, from the agent's links to another card's spec page
  const parentOf = new Map<string, string>();
  for (const { a } of live) {
    const parent = a.links.map((l) => bySpec.get(l.page_id)).find((p) => p && p !== a.session_id);
    if (!parent || !cards.has(a.session_id)) continue;
    // a link that would close a loop is ignored: each card sits in the tree once
    let up: string | undefined = parent;
    while (up && up !== a.session_id) up = parentOf.get(up);
    if (!up) parentOf.set(a.session_id, parent);
  }
  const active = new Set([
    ...[...agentOf.keys()].filter((id) => cards.has(id)),
    ...[...shellsOf.entries()].filter(([, list]) => list.some((s) => !s.exited)).map(([id]) => id),
  ]);
  // a fork's ancestors join, even when nothing runs on them, so the fork has a home
  for (const child of [...active]) {
    for (let p = parentOf.get(child); p; p = parentOf.get(p)) active.add(p);
  }

  const node = (id: string): CardNode => ({
    card: cards.get(id)!,
    agent: agentOf.get(id) ?? null,
    shells: shellsOf.get(id) ?? [],
    forks: [...active]
      .filter((c) => parentOf.get(c) === id)
      .map(node)
      .sort((x, y) => rank(x) - rank(y) || latest(y) - latest(x)),
  });
  const roots = [...active].filter((id) => !parentOf.has(id)).map(node);

  const pages = new Map(board.pages.map((p) => [p.id, p]));
  const stories = new Map<string | null, StoryNode>();
  for (const n of roots) {
    const page = n.card.page_id ? pages.get(n.card.page_id) : undefined;
    const key = page?.id ?? null;
    if (!stories.has(key)) {
      const client = page?.client_id ?? n.card.client_id;
      stories.set(key, {
        id: key,
        title: page?.title ?? "No story",
        project: board.projects.find((p) => p.id === client) ?? null,
        cards: [],
      });
    }
    stories.get(key)!.cards.push(n);
  }
  const list = [...stories.values()];
  for (const s of list) s.cards.sort((x, y) => rank(x) - rank(y) || latest(y) - latest(x));
  const best = (s: StoryNode) => Math.min(...s.cards.map(rank));
  const recent = (s: StoryNode) => Math.max(...s.cards.map(latest));
  return list.sort((x, y) => best(x) - best(y) || recent(y) - recent(x));
}
