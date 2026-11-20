import { expect, test } from "bun:test";
import { activate, addTerms, type PaneNode, prune, splitAt } from "./pane-tree.ts";

// group ids are random: compare shapes without them
const shape = (n: PaneNode | null): unknown =>
  n === null ? null : "group" in n ? { terms: n.terms, active: n.active } : { ...n, a: shape(n.a), b: shape(n.b) };
const g = (terms: string[], active = terms.at(-1)!) => ({ group: "g", terms, active });

type Row = { id: string; saved: unknown; keep: string[]; want: unknown };
test.each<Row>([
  {
    id: "legacy one-shell leaves become panes of one, ratio kept",
    saved: { dir: "row", a: { term: "x" }, b: { term: "y" }, ratio: 0.3 },
    keep: ["x", "y"],
    want: { dir: "row", a: { terms: ["x"], active: "x" }, b: { terms: ["y"], active: "y" }, ratio: 0.3 },
  },
  {
    id: "a closed active shell hands over to its neighbour",
    saved: g(["x", "y", "z"], "y"),
    keep: ["x", "z"],
    want: { terms: ["x", "z"], active: "z" },
  },
  {
    id: "an emptied pane folds its split away",
    saved: { dir: "col", a: g(["x"]), b: g(["y"]) },
    keep: ["y"],
    want: { terms: ["y"], active: "y" },
  },
  {
    id: "an out-of-range ratio is dropped",
    saved: { dir: "row", a: g(["x"]), b: g(["y"]), ratio: 7 },
    keep: ["x", "y"],
    want: { dir: "row", a: { terms: ["x"], active: "x" }, b: { terms: ["y"], active: "y" } },
  },
  { id: "junk is ignored", saved: { dir: "row", a: 3, b: "no" }, keep: ["x"], want: null },
])("prune: $id", ({ saved, keep, want }) => {
  expect(shape(prune(saved as PaneNode, (t) => keep.includes(t)))).toEqual(want);
});

test("splitAt puts a new pane beside the pane holding the shell, which activate then shows", () => {
  const root = splitAt(g(["x", "y"], "y"), "x", "row", "z");
  expect(shape(root)).toEqual({ dir: "row", a: { terms: ["x", "y"], active: "y" }, b: { terms: ["z"], active: "z" } });
  expect(shape(activate(root, "x"))).toEqual({
    dir: "row",
    a: { terms: ["x", "y"], active: "x" },
    b: { terms: ["z"], active: "z" },
  });
  expect(activate(root, "z")).toBe(root);
});

test("addTerms appends new shells to the pane holding `at`, showing the last, and skips ones it holds", () => {
  const root = { dir: "row", a: g(["x"]), b: g(["y"]) } as PaneNode;
  expect(shape(addTerms(root, "y", ["z", "y", "w"]))).toEqual({
    dir: "row",
    a: { terms: ["x"], active: "x" },
    b: { terms: ["y", "z", "w"], active: "w" },
  });
  expect(addTerms(g(["x"]), "x", ["x"])).toEqual(g(["x"]));
});
