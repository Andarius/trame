import { describe, expect, test } from "bun:test";
import {
  carryMarks,
  normalizeMarks,
  readList,
  readMarks,
  removeMark,
  setMark,
  stampTodoMarks,
  stripMarks,
  todayMark,
  touchTodo,
} from "../core/todo-marks.ts";

const CREATED = "{{trame:created_at=2026-08-20}}";
const DONE = "{{trame:completed_at=2026-08-31}}";

describe("readMarks / stripMarks read the line and its marks apart", () => {
  const cases: [string, string, Record<string, string>, string][] = [
    ["no marks", "Ship it", {}, "Ship it"],
    ["one mark", `Ship it ${CREATED}`, { created_at: "2026-08-20" }, "Ship it"],
    [
      "both marks",
      `Ship it ${CREATED} ${DONE}`,
      { created_at: "2026-08-20", completed_at: "2026-08-31" },
      "Ship it",
    ],
    ["mark mid-line", `a ${CREATED} b`, { created_at: "2026-08-20" }, "a b"],
    ["empty value", "a {{trame:created_at=}}", { created_at: "" }, "a"],
    // a colour pill is not a mark and must survive untouched
    ["pill left alone", "a {{green:done}}", {}, "a {{green:done}}"],
    ["first wins", `a ${CREATED} {{trame:created_at=2026-01-01}}`, {
      created_at: "2026-08-20",
    }, "a"],
  ];
  for (const [name, text, marks, stripped] of cases) {
    test(name, () => {
      expect(readMarks(text)).toStrictEqual(marks);
      expect(stripMarks(text)).toStrictEqual(stripped);
    });
  }
});

test("setMark never overwrites a mark a writer already put there", () => {
  expect(setMark("Ship it", "created_at", "2026-08-31")).toStrictEqual(`Ship it ${"{{trame:created_at=2026-08-31}}"}`);
  // the agent-written date wins over the app's
  expect(setMark(`Ship it ${CREATED}`, "created_at", "2026-08-31")).toStrictEqual(`Ship it ${CREATED}`);
  expect(setMark("", "created_at", "2026-08-31")).toStrictEqual("{{trame:created_at=2026-08-31}}");
});

test("removeMark takes the mark and its separating space", () => {
  expect(removeMark(`Ship it ${CREATED} ${DONE}`, "completed_at")).toStrictEqual(`Ship it ${CREATED}`);
  expect(removeMark("Ship it", "completed_at")).toStrictEqual("Ship it");
});

test("carryMarks keeps what the rewrite left out", () => {
  expect(carryMarks(`Ship it ${CREATED}`, "Ship it now")).toStrictEqual(`Ship it now ${CREATED}`);
  // an explicit mark in the rewrite is not shadowed by the old one
  expect(carryMarks(`Ship it ${CREATED}`, "Ship it {{trame:created_at=2026-01-01}}")).toStrictEqual("Ship it {{trame:created_at=2026-01-01}}");
});

test("stampTodoMarks fills the gaps and keeps done ⇔ completed_at", () => {
  expect(stampTodoMarks([
      { type: "todo", text: "open", done: false },
      { type: "todo", text: "shipped", done: true },
      { type: "todo", text: `reopened ${DONE}`, done: false },
      { type: "todo", text: `dated ${CREATED}`, done: false },
      { type: "text", text: "not a todo" },
    ], "2026-09-01")).toStrictEqual([
      {
        type: "todo",
        text: "open {{trame:created_at=2026-09-01}}",
        done: false,
      },
      {
        type: "todo",
        text:
          "shipped {{trame:created_at=2026-09-01}} {{trame:completed_at=2026-09-01}}",
        done: true,
      },
      {
        type: "todo",
        text: "reopened {{trame:created_at=2026-09-01}}",
        done: false,
      },
      { type: "todo", text: `dated ${CREATED}`, done: false },
      { type: "text", text: "not a todo" },
    ]);
});

test("todayMark is a local-time ISO day", () => {
  expect(todayMark(new Date(2026, 0, 5))).toStrictEqual("2026-01-05");
});

describe("updated_at is a capped, deduped day list", () => {
  const cases: [string, string, string[], string][] = [
    [
      "first touch",
      "Ship it {{trame:created_at=2026-08-20}}",
      ["2026-08-25"],
      "2026-08-25",
    ],
    // an edit on the day the item was raised says nothing created_at does not
    ["same day as created_at", "Ship it {{trame:created_at=2026-08-20}}", [
      "2026-08-20",
    ], ""],
    [
      "same day twice collapses",
      "Ship it",
      ["2026-08-25", "2026-08-25"],
      "2026-08-25",
    ],
    [
      "out of order sorts",
      "Ship it",
      ["2026-08-25", "2026-08-21"],
      "2026-08-21,2026-08-25",
    ],
    ["caps at the 5 most recent", "Ship it", [
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
    ], "2026-08-02,2026-08-03,2026-08-04,2026-08-05,2026-08-06"],
  ];
  for (const [name, start, days, expected] of cases) {
    test(name, () => {
      const out = days.reduce(touchTodo, start);
      expect(readList(out, "updated_at").join(",")).toStrictEqual(expected);
    });
  }
});

test("carryMarks unions updated_at instead of letting one side win", () => {
  expect(readList(
      carryMarks(
        "Ship it {{trame:updated_at=2026-08-01,2026-08-09}}",
        "Ship it {{trame:updated_at=2026-08-05}}",
      ),
      "updated_at",
    )).toStrictEqual(["2026-08-01", "2026-08-05", "2026-08-09"]);
});

test("stampTodoMarks keeps updated_at and re-orders the marks", () => {
  const text = "Ship it {{trame:updated_at=2026-08-05}}";
  expect(stampTodoMarks([{ type: "todo", text, done: false }], "2026-09-01")).toStrictEqual([{
      type: "todo",
      text:
        "Ship it {{trame:created_at=2026-09-01}} {{trame:updated_at=2026-08-05}}",
      done: false,
    }]);
});

test("normalizeMarks moves stranded marks back to the end, in order", () => {
  expect(normalizeMarks(
      "Mint a client {{trame:created_at=2026-08-11}} (policy scope)",
    )).toStrictEqual("Mint a client (policy scope) {{trame:created_at=2026-08-11}}");
  expect(normalizeMarks(
      "Ship it {{trame:completed_at=2026-08-28}} {{trame:updated_at=2026-08-22}} {{trame:created_at=2026-08-11}}",
    )).toStrictEqual("Ship it {{trame:created_at=2026-08-11}} {{trame:updated_at=2026-08-22}} {{trame:completed_at=2026-08-28}}");
  expect(normalizeMarks("no marks here")).toStrictEqual("no marks here");
});
