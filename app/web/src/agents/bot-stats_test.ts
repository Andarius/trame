import { describe, expect, test } from "bun:test";
import { fmtSeconds, heatLevel, runLabel } from "./bot-stats.ts";

describe("runLabel", () => {
  const base = { live: false, needsYou: false, outcome: null, endedAt: null };
  for (
    const [id, run, expected] of [
      ["running", { ...base, live: true }, "working"],
      ["waits on a decision", { ...base, live: true, needsYou: true }, "needs you"],
      ["first turn done, run still open", { ...base, live: true, endedAt: "x", outcome: "success" }, "finished"],
      ["errored", { ...base, endedAt: "x", outcome: "error" }, "failed"],
      ["interrupted", { ...base, endedAt: "x", outcome: "interrupted" }, "stopped"],
      ["closed before its turn ended", base, "stopped"],
    ] as const
  ) test(id, () => expect(runLabel(run)).toBe(expected));
});

describe("fmtSeconds", () => {
  for (
    const [id, s, expected] of [
      ["seconds", 42, "42 s"],
      ["minutes", 360, "6 min"],
      ["hours", 3900, "1 h 05"],
      ["unknown", null, null],
      ["negative (clock skew)", -3, null],
    ] as const
  ) test(id, () => expect(fmtSeconds(s)).toBe(expected));
});

describe("heatLevel", () => {
  for (
    const [id, day, max, expected] of [
      ["no runs", { runs: 0, failed: 0 }, 9, 0],
      ["quiet day", { runs: 3, failed: 0 }, 9, 1],
      ["middle", { runs: 6, failed: 0 }, 9, 2],
      ["busiest", { runs: 9, failed: 0 }, 9, 3],
      ["a failure wins", { runs: 9, failed: 1 }, 9, "x"],
    ] as const
  ) test(id, () => expect(heatLevel({ day: "2026-11-26", ...day }, max)).toBe(expected));
});
