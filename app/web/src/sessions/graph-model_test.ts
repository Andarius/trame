import { assertEquals } from "@std/assert";
import type { BoardData, Session } from "../api.ts";
import { buildGraph } from "./graph-model.ts";

const card = (
  id: string,
  title: string,
  client_id: string | null,
  status = "active",
) =>
  ({
    id,
    title,
    client_id,
    status,
    page_id: null,
    last_touched: "2026-10-01T00:00:00Z",
  }) as Session;

const board = (sessions: Session[]) =>
  ({
    projects: [{ id: "p1", name: "Obitrain", color: "#7bd88f", icon: null }, {
      id: "p2",
      name: "Soren",
      color: null,
      icon: null,
    }],
    stories: [],
    pages: [],
    sessions,
    statuses: [
      {
        id: "a",
        key: "active",
        label: "Active",
        color: "",
        terminal: false,
        sort_key: "a",
      },
      {
        id: "d",
        key: "done",
        label: "Done",
        color: "",
        terminal: true,
        sort_key: "b",
      },
    ],
  }) as BoardData;

const edges = (b: BoardData) =>
  buildGraph(b).links.map((l) => `${l.source}>${l.target}`).sort();

for (
  const [id, sessions, want] of [
    ["shared repo bridges projects", [
      card("1", "trame — a", "p1"),
      card("2", "trame — b", "p2"),
    ], [
      "project:p1>repo:trame",
      "project:p2>repo:trame",
      "repo:trame>card:1",
      "repo:trame>card:2",
    ]],
    ["no repo hangs off the project", [card("1", "Plan the week", "p1")], [
      "project:p1>card:1",
    ]],
    ["no project", [card("1", "x — y", null)], [
      "project:none>repo:x",
      "repo:x>card:1",
    ]],
    ["terminal cards are left out", [card("1", "trame — a", "p1", "done")], []],
  ] as const
) {
  Deno.test(`buildGraph: ${id}`, () =>
    assertEquals(edges(board([...sessions])), [...want]));
}

Deno.test("buildGraph: counts open cards per project and repo", () => {
  const g = buildGraph(
    board([
      card("1", "trame — a", "p1"),
      card("2", "trame — b", "p2"),
      card("3", "c", "p1"),
    ]),
  );
  const cards = Object.fromEntries(
    g.nodes.flatMap((n) => n.kind === "card" ? [] : [[n.id, n.cards]]),
  );
  assertEquals(cards, { "project:p1": 2, "repo:trame": 2, "project:p2": 1 });
});
