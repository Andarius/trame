import { expect, test } from "bun:test";
import { parseCards } from "./cards.ts";

test("parseCards: value, label and optional trailing color", () => {
  expect(parseCards(`
// a comment line

154 | PRs merged | green
2 | deploys
1 | red
0 | a | b | copper
`)).toStrictEqual([
      { value: "154", label: "PRs merged", color: "green" },
      { value: "2", label: "deploys", color: null },
      // a two-field line keeps its label, even when the label names a color
      { value: "1", label: "red", color: null },
      { value: "0", label: "a | b", color: "copper" },
    ]);
});
