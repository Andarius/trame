import { expect, test } from "bun:test";
import type { UdbProp, UdbRow } from "../api.ts";
import { type ChartSeries, chartData, sanitizeChart } from "./chart.ts";

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

test("chartData: groups are the categories, measures are the columns", () => {
  const d = chartData(ROWS, PROPS, {
    kind: "bar",
    x: "p2",
    series: COUNT_AND_SUM,
  });
  expect(d.xLabel).toStrictEqual("Status");
  expect(d.series.map((s) => [s.key, s.label])).toStrictEqual([
    ["s0", "Count"],
    ["s1", "Points (sum)"],
  ]);
  // select groups keep the option order and colour; the empty one trails
  expect(d.rows).toStrictEqual([
    { x: "Todo", k: "st1", c: "#7a9ee7", s0: 2, s1: 30 },
    { x: "Done", k: "st2", c: "#7bd88f", s0: 1, s1: 5 },
    { x: "(empty)", k: "\0", c: undefined, s0: 1, s1: null },
  ]);
  expect(d.hidden).toStrictEqual(0);
});

test("chartData: no grouping draws one category per row, gaps stay null", () => {
  const d = chartData(ROWS, PROPS, {
    kind: "line",
    x: null,
    series: [{ propId: "p3", agg: "sum" }],
  });
  expect(d.xLabel).toStrictEqual("Name");
  expect(d.rows.map((r) => [r.x, r.s0])).toStrictEqual([
    ["a", 10],
    ["b", 20],
    ["c", 5],
    ["d", null], // an empty cell is a gap in the line, never a zero
  ]);
});

test("chartData: a deleted column drops, a deleted x falls back to per-row", () => {
  const d = chartData(ROWS, PROPS, {
    kind: "bar",
    x: "gone",
    series: [
      { propId: "gone", agg: "sum" },
      { propId: "p1", agg: "sum" }, // a title is not aggregatable
      { propId: null, agg: "count" },
    ],
  });
  expect(d.series.map((s) => s.label)).toStrictEqual(["Count"]);
  expect(d.rows.length).toStrictEqual(4);
});

test("chartData: a pie folds its tail without losing the total", () => {
  const rows = Array.from(
    { length: 9 },
    (_, i) => row(`r${i}`, `n${i}`, null, i + 1),
  );
  const d = chartData(rows, PROPS, {
    kind: "pie",
    x: null,
    series: [{ propId: "p3", agg: "sum" }],
  });
  expect(d.rows.length).toStrictEqual(6);
  expect(d.rows[5].x).toStrictEqual("Other (4)");
  expect(d.rows.reduce((n, r) => n + Number(r.s0), 0)).toStrictEqual(45);
});

test("chartData: a bar caps the categories and says how many are left", () => {
  const rows = Array.from(
    { length: 30 },
    (_, i) => row(`r${i}`, `n${i}`, null, 1),
  );
  const d = chartData(rows, PROPS, {
    kind: "bar",
    x: null,
    series: [{ propId: null, agg: "count" }],
  });
  expect(d.rows.length).toStrictEqual(24);
  expect(d.hidden).toStrictEqual(6);
});

test("chartData: the series list caps at the palette", () => {
  const d = chartData(ROWS, PROPS, {
    kind: "bar",
    x: "p2",
    series: Array.from({ length: 11 }, () => ({
      propId: "p3",
      agg: "sum" as const,
    })),
  });
  expect(d.series.length).toStrictEqual(8);
  expect(d.series[7].key).toStrictEqual("s7");
});

test("sanitizeChart: junk from localStorage never reaches the renderer", () => {
  expect(sanitizeChart({ kind: "sankey", series: [] })).toStrictEqual(undefined);
  expect(sanitizeChart({ kind: "bar", series: "nope" })).toStrictEqual(undefined);
  expect(sanitizeChart(null)).toStrictEqual(undefined);
  expect(sanitizeChart(42)).toStrictEqual(undefined);
  expect(sanitizeChart({
      kind: "pie",
      x: 7,
      donut: true,
      series: [{ propId: "p3", agg: "sum" }, { propId: "p3", agg: "median" }],
    })).toStrictEqual({
      kind: "pie",
      x: null,
      series: [{ propId: "p3", agg: "sum" }],
      donut: true,
    });
});

const BREAKS = prop("p4", "Breaks", "number", {
  color_mode: "fixed",
  color: "#e06c75",
});
const SCALED = prop("p5", "Scaled", "number", {
  color_mode: "scale",
  color: "#111111",
});

test("chartData: series colour is explicit, then column fixed, then palette", () => {
  const cases: [string, ChartSeries, UdbProp[], string | null][] = [
    ["explicit wins", { propId: "p4", agg: "sum", color: "#00ff00" }, [BREAKS], "#00ff00"],
    ["column fixed", { propId: "p4", agg: "sum" }, [BREAKS], "#e06c75"],
    ["invalid explicit falls to column", { propId: "p4", agg: "sum", color: "red" }, [BREAKS], "#e06c75"],
    ["non-fixed mode ignores column colour", { propId: "p5", agg: "sum" }, [SCALED], null],
    ["no colour at all", { propId: "p3", agg: "sum" }, [POINTS], null],
    ["count takes explicit", { propId: null, agg: "count", color: "#abc" }, [], "#abc"],
  ];
  for (const [name, s, props, want] of cases) {
    const d = chartData(ROWS, props, { kind: "bar", x: null, series: [s] });
    expect(d.series[0].color, name).toStrictEqual(want);
  }
});

test("sanitizeChart: keeps a valid series colour, drops an invalid one", () => {
  const out = sanitizeChart({
    kind: "bar",
    series: [
      { propId: "p3", agg: "sum", color: "#e06c75" },
      { propId: "p3", agg: "sum", color: "javascript:x" },
    ],
  });
  expect(out?.series.map((s) => s.color)).toStrictEqual(["#e06c75", undefined]);
});
