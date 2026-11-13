import { expect, test } from "bun:test";
import { needsYou, nextUnseen, type TermSession } from "./attention.ts";

const s = (term: string, busy: boolean, waiting: string | null = null): TermSession => ({
  term,
  agent: "claude",
  id: `c-${term}`,
  name: null,
  named: false,
  busy,
  waiting,
  started_at: null,
});

test.each([
  ["busy then idle is flagged", [s("t1", true)], [s("t1", false)], [], ["t1"]],
  ["idle from the start is not", [], [s("t1", false)], [], []],
  ["stays flagged while idle", [s("t1", false)], [s("t1", false)], ["t1"], ["t1"]],
  ["busy again clears it", [s("t1", false)], [s("t1", true)], ["t1"], []],
  ["agent gone clears it", [s("t1", false)], [], ["t1"], []],
] as const)("%s", (_, prev, next, unseen, want) => {
  expect([...nextUnseen([...prev], [...next], new Set(unseen))]).toEqual([...want]);
});

test.each([
  ["asking beats finished", [s("t1", false), s("t2", false, "permission")], ["t1"], "needs you: permission"],
  ["finished unseen", [undefined, s("t1", false)], ["t1"], "finished"],
  ["idle and seen", [s("t1", false)], [], null],
  ["no agent", [undefined], [], null],
] as const)("%s", (_, shells, unseen, want) => {
  expect(needsYou([...shells], new Set(unseen))).toBe(want);
});
