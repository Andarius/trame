import { assertEquals } from "@std/assert";
import type { BoardData } from "../api.ts";
import { projectFor } from "./project-for.ts";

const card = (repo: string, client: string, touched: string) => ({ repo_path: repo, client_id: client, last_touched: touched });
const board = {
  projects: [
    { id: "trame", name: "Trame", icon: "▲", color: null },
    { id: "obi", name: "Obitrain", icon: null, color: "#7bd88f" },
    { id: "side", name: "Side", icon: null, color: null },
  ],
  sessions: [
    card("/Users/j/trame", "side", "2026-10-01"),
    card("/Users/j/trame", "trame", "2026-10-10"),
    card("/Users/j/obiapp/.claude/worktrees/x", "obi", "2026-10-05"),
    card("/Users/j/trame/crates/sub", "side", "2026-09-01"),
  ],
} as unknown as BoardData;

Deno.test("terminal folder → card project", () => {
  for (
    const [cwd, expected] of [
      ["/Users/j/trame", "trame"], // latest card wins among equal matches
      ["/Users/j/trame/app/web", "trame"], // inside a card's repo
      ["/Users/j/trame/crates/sub/src", "side"], // the deepest repo wins
      ["/Users/j/obiapp", "obi"], // a worktree card under this folder
      ["/Users/j/trame-other", null], // a prefix that is not a path boundary
      ["/Users/j", null], // home holds every repo: no match
      [undefined, null],
    ] as const
  ) {
    assertEquals(projectFor(board, cwd)?.id ?? null, expected, String(cwd));
  }
});
