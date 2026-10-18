import { assertEquals } from "@std/assert";
import type { BoardData, LiveAgent } from "../api.ts";
import { type CardNode, workingNow } from "./working-now.ts";

const card = (id: string, story: string | null, touched = "2026-10-01") => ({
  id,
  title: id,
  page_id: story,
  client_id: null,
  specs_page_id: `spec-${id}`,
  last_touched: touched,
});
const board = {
  projects: [],
  pages: [
    { id: "us1", title: "Terminal", client_id: null },
    { id: "us2", title: "Rotation", client_id: null },
  ],
  sessions: [card("main", "us1"), card("fork1", "us1"), card("fork2", "us2"), card("idle", "us1"), card("sre", "us2", "2026-10-05")],
} as unknown as BoardData;
const agent = (id: string, state: "working" | "waiting", links: string[] = [], at = 1) => ({
  a: { session_id: id, at, links: links.map((page_id) => ({ page_id })) } as unknown as LiveAgent,
  state,
});
const shape = (n: CardNode): unknown => [n.card.id, n.agent?.state ?? null, n.shells.map((s) => s.id), n.forks.map(shape)];

// expected card shape: [id, agent state, shell ids, forks]
const n = (id: string, state: string | null, shells: string[] = [], forks: unknown[] = []) => [id, state, shells, forks];

Deno.test("working now: stories → cards → forks", () => {
  const cases: [string, unknown[], unknown[], unknown][] = [
    ["nothing running", [], [], []],
    [
      "a fork nests under the card whose spec page it works on, even from another story",
      [agent("main", "working"), agent("fork1", "working", ["spec-main"]), agent("fork2", "waiting", ["spec-main"])],
      [],
      [["us1", [n("main", "working", [], [n("fork2", "waiting"), n("fork1", "working")])]]],
    ],
    [
      "an idle parent joins to hold its running fork; exited shells keep nothing alive",
      [agent("fork1", "working", ["spec-main"])],
      [{ id: "t1", title: "zsh", card: "idle", exited: true }, { id: "t2", title: "zsh", card: "sre", exited: false }],
      [["us1", [n("main", null, [], [n("fork1", "working")])]], ["us2", [n("sre", null, ["t2"])]]],
    ],
    [
      "a self-link is no fork; the link closing a loop is dropped; a waiting fork ranks its story first",
      [agent("sre", "working", ["spec-sre"]), agent("fork1", "waiting", ["spec-fork2"]), agent("fork2", "working", ["spec-fork1"])],
      [],
      [["us2", [n("fork2", "working", [], [n("fork1", "waiting")]), n("sre", "working")]]],
    ],
  ];
  for (const [name, live, shells, expected] of cases) {
    const tree = workingNow(board, live as never, shells as never);
    assertEquals(tree.map((s) => [s.id, s.cards.map(shape)]), expected, name);
  }
});
