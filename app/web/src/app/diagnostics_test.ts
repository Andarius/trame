import { describe, expect, test } from "bun:test";
import { cpuRate, formatBytes, formatDuration } from "./Diagnostics";

describe("diagnostics formatting", () => {
  test.each([
    [null, "—"],
    [512, "512 B"],
    [2048, "2.0 KB"],
    [266_528 * 1024, "260 MB"],
    [3 * 1024 ** 3, "3.0 GB"],
  ])("formatBytes(%p) = %p", (n, wanted) => {
    expect(formatBytes(n)).toBe(wanted);
  });

  test.each([
    [65, "1m 5s"],
    [3_900, "1h 5m"],
    [90_000, "1d 1h"],
  ])("formatDuration(%p) = %p", (s, wanted) => {
    expect(formatDuration(s)).toBe(wanted);
  });

  test("cpuRate is the share of one core between two samples", () => {
    expect(cpuRate(0, 10, 2000, 11)).toBe(0.5);
    expect(cpuRate(2000, 10, 2000, 11)).toBeNull(); // same instant
    expect(cpuRate(0, 10, 2000, 9)).toBe(0); // a reaped child never counts backwards
  });
});
