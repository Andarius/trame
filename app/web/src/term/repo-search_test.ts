import { expect, test } from "bun:test";
import type { BoardData } from "../api";
import { boardRepos, matches } from "./repo-search.ts";

test.each<[string, string, boolean]>([
  ["one word", "acme", true],
  ["every word, any order", "web acme", true],
  ["case-insensitive", "ACME-WEB", true],
  ["a word that is missing", "acme api", false],
])("matches /src/acme-web: %s", (_, query, want) => {
  expect(matches("/src/acme-web", query)).toBe(want);
});

test("boardRepos keeps each repo once, with its latest card's project, most recent first", () => {
  const card = (repo_path: string | null, client_id: string, last_touched: string) => ({ repo_path, client_id, last_touched });
  const board = {
    sessions: [card("/src/a/", "p1", "2026-11-01"), card("/src/b", "p2", "2026-11-03"), card("/src/a", "p3", "2026-11-02"), card(null, "p4", "2026-11-04")],
  } as unknown as BoardData;
  expect([...boardRepos(board)]).toEqual([["/src/b", "p2"], ["/src/a", "p3"]]);
});
