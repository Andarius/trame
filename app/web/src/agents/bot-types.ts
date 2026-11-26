// A bot's run history and stats as the API returns them; no imports, so tests and helpers stay DOM-free.
export type RunSource = "slack" | "hook" | "app" | "relay";
export type Outcome = "success" | "error" | "interrupted";
export type Agent = "claude" | "codex";
// what one start may change from the bot's defaults; a hook can't set `cwd`
export type StartOptions = { cwd?: string; agent?: Agent; mode?: string };
// one run a bot started, kept after the run itself is closed
export type BotRun = {
  id: string;
  source: RunSource;
  summary: string;
  requester: string;
  startedAt: string;
  endedAt: string | null;
  outcome: Outcome | null;
  live: boolean;
  needsYou: boolean;
  cwd: string | null; // where it worked; null before this was kept
  agent: Agent | null;
};
export type Daily = { day: string; runs: number; failed: number };
export type Sources = Record<RunSource, number>;
export type BotStats = {
  runs: number;
  success: number;
  error: number;
  interrupted: number;
  medianSeconds: number | null;
  daily: Daily[];
  sources: Sources;
  lastStartedAt: string | null;
};
export type BotActivity = { bot: string; runs: number; success: number; daily: Daily[]; sources: Sources };
