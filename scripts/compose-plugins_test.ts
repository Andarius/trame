import { expect, test } from "bun:test";
import { parseSpec } from "./compose-plugins.ts";

test("plugin specs are owner/repo with an optional tag, safe as paths", () => {
  expect(parseSpec("Andarius/trame-notebook-cells")).toEqual({ repo: "Andarius/trame-notebook-cells", ref: null });
  expect(parseSpec("o/r@v1.2.0")).toEqual({ repo: "o/r", ref: "v1.2.0" });
  for (const bad of ["o", "o/r/x", "../r", "o/.r", "o/r@", "o/r@-x", "o/r@a..b", "o/r@a@b", "o r/x"]) {
    expect(() => parseSpec(bad), bad).toThrow();
  }
});
