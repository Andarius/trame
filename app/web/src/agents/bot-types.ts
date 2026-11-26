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
// a bot's own Slack app, as the bot list shows it
export type BotSlackApp = { connected: true; botUser: string; botName: string; teamName: string };
// a bot's own Slack app in full; the tokens only masked
export type BotSlack = {
  connected: boolean;
  team?: string;
  teamName?: string;
  botUser?: string; // its Slack user id
  botName?: string; // its Slack user name, the @name people type
  appId?: string | null;
  allowed?: string[];
  anyone?: boolean;
  appToken?: string;
  botToken?: string;
  listening: boolean; // its Socket Mode listener runs on this machine
  error: string | null; // why Slack stopped it
  manifestUrl: string; // creates the app in Slack, named after the bot
};
// the shared @Trame app this machine holds, if any
export type SharedSlack = { shared: { connected: boolean; channel: string } | null };
