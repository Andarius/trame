import { describe, expect, test } from "bun:test";
import { burn, costOf, costParts, costSum, heatLevels, hourGrid, modelMix, priceOf, topModels, weekOf } from "./insights-stats.ts";

describe("priceOf", () => {
  test.each([
    ["claude-opus-5-5", 4],
    ["claude-opus-5-5[1m]", 4],
    ["claude-opus-5", 5],
    ["claude-opus-5-20260101", 5],
    ["claude-sonnet-4-6", 3],
    ["gpt-6.1-sol", null],
    [null, null],
  ])("%s → $%s input", (model, input) => {
    expect(priceOf(model)?.in ?? null).toBe(input);
  });
});

describe("costOf", () => {
  test.each([
    // 1M plain input, 0.2M cache writes, 0.1M output, 2M cache reads on Opus 5.5
    ["split row", { m: "claude-opus-5-5", tokens: 1_300_000, out: 100_000, written: 200_000, cached: 2_000_000 }, 4 + 1 + 2 + 0.4],
    ["unpriced model", { m: "gpt-6.1-sol", tokens: 1000, out: 10, cached: 0, written: 0 }, null],
    ["another device's row (no split)", { m: "claude-opus-5-5", tokens: 1000, out: 0, cached: 0, written: 0 }, null],
  ])("%s", (_, row, want) => {
    const got = costOf(row);
    if (want === null) expect(got).toBeNull();
    else expect(got).toBeCloseTo(want, 6);
  });

  test("costSum reports the share of tokens it priced", () => {
    const { usd, covered } = costSum([
      { m: "claude-haiku-5-5", tokens: 1_000_000, out: 0, cached: 1, written: 0 },
      { m: "gpt-6.1-sol", tokens: 3_000_000, out: 1, cached: 0, written: 0 },
    ]);
    expect(usd).toBeCloseTo(0.1, 6);
    expect(covered).toBe(0.25);
  });
});

test("costParts splits a row's cost by kind of token", () => {
  const row = { m: "claude-opus-5-5", tokens: 1_300_000, out: 100_000, written: 200_000, cached: 2_000_000 };
  expect(costParts([row, { m: "gpt-6.1-sol", tokens: 9, out: 1, cached: 0, written: 0 }])).toEqual({
    input: 4,
    write: 1,
    read: 0.4,
    out: 2,
  });
});

test("burn projects month-to-date spend to the month's end", () => {
  const day = (d: string) => ({ d, m: "claude-haiku-5-5", tokens: 1_000_000, out: 0, cached: 1, written: 0 });
  // $0.10 per row
  const b = burn([day("2026-10-31"), day("2026-10-02"), day("2026-11-01"), day("2026-11-03")], "2026-11-10");
  expect(b.mtd).toBeCloseTo(0.2, 6);
  expect(b.projected).toBeCloseTo(0.6, 6);
  expect(b.last).toBeCloseTo(0.2, 6);
});

test("weekOf starts weeks on Monday", () => {
  expect([weekOf("2026-11-23"), weekOf("2026-11-29"), weekOf("2026-11-30")]).toEqual([
    "2026-11-23",
    "2026-11-23",
    "2026-11-30",
  ]);
});

test("modelMix keeps the given models and folds the rest into other", () => {
  const rows = [
    { d: "2026-11-23", m: "a", tokens: 10 },
    { d: "2026-11-24", m: "b", tokens: 5 },
    { d: "2026-11-30", m: "c", tokens: 1 },
    { d: "2026-11-30", m: null, tokens: 0 },
  ];
  const keys = topModels(rows, 2);
  expect(keys).toEqual(["a", "b"]);
  const { keys: series, buckets } = modelMix(rows, keys);
  expect(series).toEqual(["a", "b", "other"]);
  expect(buckets.map(([w, m]) => [w, Object.fromEntries(m)])).toEqual([
    ["2026-11-23", { a: 10, b: 5 }],
    ["2026-11-30", { other: 1 }],
  ]);
  expect(modelMix(rows, keys, (d) => d).buckets.map(([d]) => d)).toEqual(["2026-11-23", "2026-11-24", "2026-11-30"]);
});

test("heatLevels splits non-zero values by quartile", () => {
  const level = heatLevels([0, 1, 2, 3, 4, 1000]);
  expect([0, 1, 2, 3, 4, 1000].map(level)).toEqual([0, 1, 1, 2, 3, 4]);
});

test("hourGrid indexes weekdays from Monday", () => {
  const grid = hourGrid([{ d: "2026-11-23", h: 9, n: 3 }, { d: "2026-11-29", h: 23, n: 1 }]);
  expect(grid[0][9]).toBe(3);
  expect(grid[6][23]).toBe(1);
});
