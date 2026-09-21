import { assertEquals } from "@std/assert";
import type { UdbProp, UdbRow } from "../api.ts";
import { chartData, sanitizeChart } from "./chart.ts";

const prop = (
  id: string,
  name: string,
  type: UdbProp["type"],
  config: UdbProp["config"] = {},
): UdbProp => ({
  id,
  db_id: "d",
  name,
  type,
  config,
  sort_key: id,
  width: null,
});

const NAME = prop("p1", "Name", "title");
const STATUS = prop("p2", "Status", "select", {
  options: [
    { id: "st1", name: "Todo", color: "#7a9ee7" },
    { id: "st2", name: "Done", color: "#7bd88f" },
  ],
});
const POINTS = prop("p3", "Points", "number");
const PROPS = [NAME, STATUS, POINTS];

const row = (
  id: string,
  name: string,
  status: string | null,
  points: number | null,
): UdbRow => ({
  id,
  icon: null,
  sort_key: id,
  vals: { p1: name, p2: status, p3: points },
  relations: {},
  derived: {},
});

const ROWS = [
  row("r1", "a", "st1", 10),
  row("r2", "b", "st1", 20),
  row("r3", "c", "st2", 5),
  row("r4", "d", null, null),
];

const COUNT_AND_SUM = [
  { propId: null, agg: "count" as const },
  { propId: "p3", agg: "sum" as const },
];

Deno.test("chartData: groups are the categories, measures are the columns", () => {
  const d = chartData(ROWS, PROPS, {
    kind: "bar",
    x: "p2",
    series: COUNT_AND_SUM,
  });
  assertEquals(d.xLabel, "Status");
  assertEquals(d.series.map((s) => [s.key, s.label]), [
    ["s0", "Count"],
    ["s1", "Points (sum)"],
  ]);
  // select groups keep the option order and colour; the empty one trails
  assertEquals(d.rows, [
    { x: "Todo", k: "st1", c: "#7a9ee7", s0: 2, s1: 30 },
    { x: "Done", k: "st2", c: "#7bd88f", s0: 1, s1: 5 },
    { x: "(empty)", k: "\0", c: undefined, s0: 1, s1: null },
  ]);
  assertEquals(d.hidden, 0);
});

Deno.test("chartData: no grouping draws one category per row, gaps stay null", () => {
  const d = chartData(ROWS, PROPS, {
    kind: "line",
    x: null,
    series: [{ propId: "p3", agg: "sum" }],
  });
  assertEquals(d.xLabel, "Name");
  assertEquals(d.rows.map((r) => [r.x, r.s0]), [
    ["a", 10],
    ["b", 20],
    ["c", 5],
    ["d", null], // an empty cell is a gap in the line, never a zero
  ]);
});

Deno.test("chartData: a deleted column drops, a deleted x falls back to per-row", () => {
  const d = chartData(ROWS, PROPS, {
    kind: "bar",
    x: "gone",
    series: [
      { propId: "gone", agg: "sum" },
      { propId: "p1", agg: "sum" }, // a title is not aggregatable
      { propId: null, agg: "count" },
    ],
  });
  assertEquals(d.series.map((s) => s.label), ["Count"]);
  assertEquals(d.rows.length, 4);
});

Deno.test("chartData: a pie folds its tail without losing the total", () => {
  const rows = Array.from(
    { length: 9 },
    (_, i) => row(`r${i}`, `n${i}`, null, i + 1),
  );
  const d = chartData(rows, PROPS, {
    kind: "pie",
    x: null,
    series: [{ propId: "p3", agg: "sum" }],
  });
  assertEquals(d.rows.length, 6);
  assertEquals(d.rows[5].x, "Other (4)");
  assertEquals(d.rows.reduce((n, r) => n + Number(r.s0), 0), 45);
});

Deno.test("chartData: a bar caps the categories and says how many are left", () => {
  const rows = Array.from(
    { length: 30 },
    (_, i) => row(`r${i}`, `n${i}`, null, 1),
  );
  const d = chartData(rows, PROPS, {
    kind: "bar",
    x: null,
    series: [{ propId: null, agg: "count" }],
  });
  assertEquals(d.rows.length, 24);
  assertEquals(d.hidden, 6);
});

Deno.test("chartData: the series list caps at the palette", () => {
  const d = chartData(ROWS, PROPS, {
    kind: "bar",
    x: "p2",
    series: Array.from({ length: 11 }, () => ({
      propId: "p3",
      agg: "sum" as const,
    })),
  });
  assertEquals(d.series.length, 8);
  assertEquals(d.series[7].key, "s7");
});

Deno.test("sanitizeChart: junk from localStorage never reaches the renderer", () => {
  assertEquals(sanitizeChart({ kind: "sankey", series: [] }), undefined);
  assertEquals(sanitizeChart({ kind: "bar", series: "nope" }), undefined);
  assertEquals(sanitizeChart(null), undefined);
  assertEquals(sanitizeChart(42), undefined);
  assertEquals(
    sanitizeChart({
      kind: "pie",
      x: 7,
      donut: true,
      series: [{ propId: "p3", agg: "sum" }, { propId: "p3", agg: "median" }],
    }),
    {
      kind: "pie",
      x: null,
      series: [{ propId: "p3", agg: "sum" }],
      donut: true,
    },
  );
});
