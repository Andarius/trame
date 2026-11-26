import { describe, expect, test } from "bun:test";
import { fmtSeconds, heatLevel, runExtras, runLabel, startOptions } from "./bot-stats.ts";

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

describe("startOptions", () => {
  const claude = { agent: "claude", mode: "plan" } as const;
  for (
    const [id, defaults, pick, expected] of [
      ["the bot's defaults send nothing", claude, { agent: "claude", mode: "plan", cwd: null }, {}],
      ["another mode", claude, { agent: "claude", mode: "auto", cwd: null }, { mode: "auto" }],
      ["a chosen folder", claude, { agent: "claude", mode: "plan", cwd: "/w" }, { cwd: "/w" }],
      ["codex never sends a mode", claude, { agent: "codex", mode: "auto", cwd: null }, { agent: "codex" }],
      ["claude from a codex bot starts in auto", { agent: "codex", mode: "plan" }, { agent: "claude", mode: "auto", cwd: null }, {
        agent: "claude",
      }],
      ["claude from a codex bot, another mode", { agent: "codex", mode: "auto" }, { agent: "claude", mode: "plan", cwd: null }, {
        agent: "claude",
        mode: "plan",
      }],
    ] as const
  ) test(id, () => expect(startOptions(defaults, pick)).toEqual(expected));
});

describe("runExtras", () => {
  const bot = { provider: "claude", cwd: null, workspace: "/data/bots/b1" } as const;
  for (
    const [id, run, expected] of [
      ["as the bot is set", { agent: "claude", cwd: "/data/bots/b1" }, { agent: null, folder: null }],
      ["kept before agent and folder were", { agent: null, cwd: null }, { agent: null, folder: null }],
      ["another agent and folder", { agent: "codex", cwd: "/src/web/" }, { agent: "codex", folder: "web" }],
    ] as const
  ) test(id, () => expect(runExtras(bot, run)).toEqual(expected));
});
