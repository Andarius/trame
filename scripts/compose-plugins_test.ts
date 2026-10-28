import { expect, test } from "bun:test";
import { parseSpec, satisfies } from "./compose-plugins.ts";

test("plugin specs are owner/repo with an optional tag, safe as paths", () => {
  expect(parseSpec("Andarius/trame-notebook-cells")).toEqual({ repo: "Andarius/trame-notebook-cells", ref: null });
  expect(parseSpec("o/r@v1.2.0")).toEqual({ repo: "o/r", ref: "v1.2.0" });
  for (const bad of ["o", "o/r/x", "../r", "o/.r", "o/r@", "o/r@-x", "o/r@a..b", "o/r@a@b", "o r/x"]) {
    expect(() => parseSpec(bad), bad).toThrow();
  }
});

test("a plugin's TRAME range is space-separated comparators", () => {
  for (const [version, range, want] of [
    ["0.24.0", ">=0.24.0", true],
    ["0.23.9", ">=0.24.0", false],
    ["0.24.3", ">=0.24.0 <0.25.0", true],
    ["0.25.0", ">=0.24.0 <0.25.0", false],
    ["0.24.0", "0.24.0", true],
    ["0.10.0", ">0.9.0", true],
  ] as const) {
    expect(satisfies(version, range), `${version} ${range}`).toBe(want);
  }
  for (const bad of ["", "^0.24.0", ">=0.24", "~1.2.3"]) expect(() => satisfies("0.24.0", bad), bad).toThrow();
});
