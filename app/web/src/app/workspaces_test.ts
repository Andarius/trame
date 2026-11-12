import { expect, test } from "bun:test";
import { activate, cardOfLocation, close, HOME, move, parse, previous, save, type Workspaces } from "./workspaces";

const specs = new Map([["page-1", "card-1"]]);

test.each([
  ["view=card&card=card-1", "card-1"],
  ["card=card-1", "card-1"],
  ["view=terminals&term=card-2", "card-2"],
  ["view=terminals&term=all", null],
  ["view=terminals&term=plain", null],
  ["view=terminals&term=project:p1", null],
  ["view=terminals&term=term:t1", null],
  ["view=terminals&term=recent:x", null],
  ["view=terminals", null],
  ["view=page&page=page-1", "card-1"],
  ["view=page&page=page-2", null],
  ["", null],
  ["view=insights", null],
])("cardOfLocation(%p) = %p", (query, expected) => {
  expect(cardOfLocation(new URLSearchParams(query), specs)).toBe(expected);
});

const base = (): Workspaces => ({
  list: [{ id: HOME, name: null, search: "" }, { id: "a", name: null, search: "?card=a" }, { id: "b", name: null, search: "?card=b" }],
  active: "b",
  mru: ["b", "a", HOME],
});

test("activate creates a new workspace last and puts it first in MRU", () => {
  const s = activate(base(), "c", "?card=c");
  expect(s.list.map((w) => w.id)).toEqual([HOME, "a", "b", "c"]);
  expect(s.active).toBe("c");
  expect(s.mru).toEqual(["c", "b", "a", HOME]);
  expect(previous(s)).toBe("b");
});

test("save writes the active workspace's place only", () => {
  const s = save(base(), "?view=page&page=p");
  expect(s.list.map((w) => w.search)).toEqual(["", "?card=a", "?view=page&page=p"]);
});

test.each([
  [["b"], "a", [HOME, "a"]],
  [["a"], "b", [HOME, "b"]],
  [[HOME], "b", [HOME, "a", "b"]],
  [["a", "b"], HOME, [HOME]],
  [["zzz"], "b", [HOME, "a", "b"]],
])("close(%p) leaves %p active", (ids, active, list) => {
  const s = close(base(), ids);
  expect(s.active).toBe(active);
  expect(s.list.map((w) => w.id)).toEqual(list);
});

test.each([
  ["b", -1, [HOME, "b", "a"]],
  ["a", -1, [HOME, "a", "b"]],
  ["b", 1, [HOME, "a", "b"]],
  [HOME, 1, [HOME, "a", "b"]],
] as const)("move(%p, %p)", (id, by, list) => {
  expect(move(base(), id, by).list.map((w) => w.id)).toEqual([...list]);
});

test.each([
  [null, [HOME], HOME],
  ["not json", [HOME], HOME],
  ['{"list":[{"id":"a"}]}', [HOME], HOME],
  ['{"list":[{"id":"a","search":"?card=a"}],"active":"a","mru":["a"]}', [HOME, "a"], "a"],
  ['{"list":[{"id":"home","search":""}],"active":"gone","mru":[]}', [HOME], HOME],
])("parse(%p)", (raw, ids, active) => {
  const s = parse(raw);
  expect(s.list.map((w) => w.id)).toEqual(ids);
  expect(s.active).toBe(active);
});
