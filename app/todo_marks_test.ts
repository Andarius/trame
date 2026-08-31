import { assertEquals } from "@std/assert";
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
} from "./todo-marks.ts";

const CREATED = "{{trame:created_at=2026-08-20}}";
const DONE = "{{trame:completed_at=2026-08-31}}";

Deno.test("readMarks / stripMarks read the line and its marks apart", async (t) => {
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
    await t.step(name, () => {
      assertEquals(readMarks(text), marks);
      assertEquals(stripMarks(text), stripped);
    });
  }
});

Deno.test("setMark never overwrites a mark a writer already put there", () => {
  assertEquals(
    setMark("Ship it", "created_at", "2026-08-31"),
    `Ship it ${"{{trame:created_at=2026-08-31}}"}`,
  );
  // the agent-written date wins over the app's
  assertEquals(
    setMark(`Ship it ${CREATED}`, "created_at", "2026-08-31"),
    `Ship it ${CREATED}`,
  );
  assertEquals(
    setMark("", "created_at", "2026-08-31"),
    "{{trame:created_at=2026-08-31}}",
  );
});

Deno.test("removeMark takes the mark and its separating space", () => {
  assertEquals(
    removeMark(`Ship it ${CREATED} ${DONE}`, "completed_at"),
    `Ship it ${CREATED}`,
  );
  assertEquals(removeMark("Ship it", "completed_at"), "Ship it");
});

Deno.test("carryMarks keeps what the rewrite left out", () => {
  assertEquals(
    carryMarks(`Ship it ${CREATED}`, "Ship it now"),
    `Ship it now ${CREATED}`,
  );
  // an explicit mark in the rewrite is not shadowed by the old one
  assertEquals(
    carryMarks(`Ship it ${CREATED}`, "Ship it {{trame:created_at=2026-01-01}}"),
    "Ship it {{trame:created_at=2026-01-01}}",
  );
});

Deno.test("stampTodoMarks fills the gaps and keeps done ⇔ completed_at", () => {
  assertEquals(
    stampTodoMarks([
      { type: "todo", text: "open", done: false },
      { type: "todo", text: "shipped", done: true },
      { type: "todo", text: `reopened ${DONE}`, done: false },
      { type: "todo", text: `dated ${CREATED}`, done: false },
      { type: "text", text: "not a todo" },
    ], "2026-09-01"),
    [
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
    ],
  );
});

Deno.test("todayMark is a local-time ISO day", () => {
  assertEquals(todayMark(new Date(2026, 0, 5)), "2026-01-05");
});

Deno.test("updated_at is a capped, deduped day list", async (t) => {
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
    await t.step(name, () => {
      const out = days.reduce(touchTodo, start);
      assertEquals(readList(out, "updated_at").join(","), expected);
    });
  }
});

Deno.test("carryMarks unions updated_at instead of letting one side win", () => {
  assertEquals(
    readList(
      carryMarks(
        "Ship it {{trame:updated_at=2026-08-01,2026-08-09}}",
        "Ship it {{trame:updated_at=2026-08-05}}",
      ),
      "updated_at",
    ),
    ["2026-08-01", "2026-08-05", "2026-08-09"],
  );
});

Deno.test("stampTodoMarks keeps updated_at and re-orders the marks", () => {
  const text = "Ship it {{trame:updated_at=2026-08-05}}";
  assertEquals(
    stampTodoMarks([{ type: "todo", text, done: false }], "2026-09-01"),
    [{
      type: "todo",
      text:
        "Ship it {{trame:created_at=2026-09-01}} {{trame:updated_at=2026-08-05}}",
      done: false,
    }],
  );
});

Deno.test("normalizeMarks moves stranded marks back to the end, in order", () => {
  assertEquals(
    normalizeMarks(
      "Mint a client {{trame:created_at=2026-08-11}} (policy scope)",
    ),
    "Mint a client (policy scope) {{trame:created_at=2026-08-11}}",
  );
  assertEquals(
    normalizeMarks(
      "Ship it {{trame:completed_at=2026-08-28}} {{trame:updated_at=2026-08-22}} {{trame:created_at=2026-08-11}}",
    ),
    "Ship it {{trame:created_at=2026-08-11}} {{trame:updated_at=2026-08-22}} {{trame:completed_at=2026-08-28}}",
  );
  assertEquals(normalizeMarks("no marks here"), "no marks here");
});
