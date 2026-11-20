import { expect, test } from "bun:test";
import { bundle } from "./together.ts";

const tabs: Record<string, string | undefined> = { a: "t1", b: "t2", c: "t1", d: undefined, e: "t3" };

test.each<[string, string[], string[][]]>([
  ["cards sharing a tab join the first one's place", ["a", "b", "c", "d"], [["a", "c"], ["b"], ["d"]]],
  ["a tab holding one listed card is no bundle", ["b", "e"], [["b"], ["e"]]],
  ["nothing listed", [], []],
])("bundle: %s", (_, items, want) => {
  expect(bundle(items, (x) => tabs[x])).toEqual(want);
});
