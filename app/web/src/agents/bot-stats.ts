import { fmtDuration } from "./agent-summary";
import type { Agent, BotRun, Daily, RunSource, Sources, StartOptions } from "./bot-types";

export type RunLabel = "working" | "needs you" | "finished" | "failed" | "stopped";
// what a run of the history shows as its state
export function runLabel(r: Pick<BotRun, "live" | "needsYou" | "outcome" | "endedAt">): RunLabel {
  if (r.needsYou) return "needs you";
  if (r.live && !r.endedAt) return "working";
  if (r.outcome === "error") return "failed";
  if (r.outcome === "interrupted") return "stopped";
  if (r.outcome === "success") return "finished";
  return r.live ? "working" : "stopped";
}

// "42 s", "6 min", "1 h 05"; null when unknown
export function fmtSeconds(s: number | null | undefined): string | null {
  if (s == null || !Number.isFinite(s) || s < 0) return null;
  return s < 60 ? `${Math.round(s)} s` : fmtDuration(s * 1000);
}

// how long a finished run took; null while it runs
export const runSeconds = (r: Pick<BotRun, "startedAt" | "endedAt">) =>
  r.endedAt ? (Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000 : null;

// 0 (none) to 3 (busiest day), or "x" for a day with a failure
export function heatLevel(d: Daily, max: number): 0 | 1 | 2 | 3 | "x" {
  if (d.failed > 0) return "x";
  if (d.runs <= 0 || max <= 0) return 0;
  const r = d.runs / max;
  return r <= 1 / 3 ? 1 : r <= 2 / 3 ? 2 : 3;
}

// a whole percentage, null for 0 / 0
export const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : null);

// the day initial above Mondays, "" elsewhere (dates are local YYYY-MM-DD)
export const mondayMark = (day: string) => new Date(`${day}T12:00:00`).getDay() === 1 ? "M" : "";

export const SOURCES: RunSource[] = ["slack", "hook", "app", "relay"];
export const sumSources = (all: Sources[]): Sources =>
  Object.fromEntries(SOURCES.map((k) => [k, all.reduce((n, s) => n + (s[k] ?? 0), 0)])) as Sources;

export const folderName = (cwd: string) => cwd.split("/").filter(Boolean).pop() ?? cwd;

type BotWhere = { provider: Agent; cwd: string | null; workspace: string };
// what a bot's folder reads as: its basename, or its own workspace
export const botFolder = (b: Pick<BotWhere, "cwd">) => b.cwd ? folderName(b.cwd) : "own workspace";

// what a run of the history did off the bot's defaults: another agent, another folder
export function runExtras(bot: BotWhere, r: Pick<BotRun, "agent" | "cwd">) {
  return {
    agent: r.agent && r.agent !== bot.provider ? r.agent : null,
    folder: r.cwd && r.cwd !== (bot.cwd ?? bot.workspace) ? folderName(r.cwd) : null,
  };
}

// a start's body beyond its text: only what differs from `defaults`; a mode is Claude's alone
export function startOptions(
  defaults: { agent: Agent; mode: string },
  pick: { agent: Agent; mode: string; cwd: string | null },
): StartOptions {
  const out: StartOptions = {};
  if (pick.cwd) out.cwd = pick.cwd;
  if (pick.agent !== defaults.agent) out.agent = pick.agent;
  const usual = defaults.agent === "claude" ? defaults.mode : "auto";
  if (pick.agent === "claude" && pick.mode !== usual) out.mode = pick.mode;
  return out;
}

// a stable 0–359 hue for a name, for a draft bot's preview
export function nameHue(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

// Slack member IDs from what the user typed: comma or space separated, deduplicated
export const memberIds = (text: string) => [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
