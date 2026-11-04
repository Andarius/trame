import { expect, test } from "bun:test";
import { newestFor, parseSpec, satisfies } from "./compose-plugins.ts";

test("plugin specs are owner/repo[/name] with an optional tag, safe as paths", () => {
  expect(parseSpec("Andarius/trame-notebook-cells")).toEqual({ repo: "Andarius/trame-notebook-cells", ref: null, name: null });
  expect(parseSpec("o/r@v1.2.0")).toEqual({ repo: "o/r", ref: "v1.2.0", name: null });
  expect(parseSpec("o/plugins/k8s@k8s-v0.3.0")).toEqual({ repo: "o/plugins/k8s", ref: "k8s-v0.3.0", name: "k8s" });
  for (const bad of ["o", "o/r/x/y", "o/r/..", "../r", "o/.r", "o/r@", "o/r@-x", "o/r@a..b", "o/r@a@b", "o r/x"]) {
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

test("a plugins repo member's latest release is its newest name-vX.Y.Z", () => {
  const releases = [
    { tag_name: "k8s-v0.9.0" },
    { tag_name: "k8s-v0.10.0" },
    { tag_name: "k8s-v0.11.0", prerelease: true },
    { tag_name: "k8s-v1.0.0", draft: true },
    { tag_name: "k8s-extra-v5.0.0" },
    { tag_name: "sql-source-v2.0.0" },
  ];
  expect(newestFor(releases, "k8s")).toBe("k8s-v0.10.0");
  expect(newestFor(releases, "notebook")).toBeNull();
});
