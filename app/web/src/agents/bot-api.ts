import { useEffect, useState } from "react";
import { termToken } from "../term/term-api";
import type { Provider, RunSummary } from "./agent-run-state";

// A bot: a named agent setup that Slack, a hook or the app starts fresh runs from.
export type Bot = {
  id: string;
  name: string;
  provider: Provider;
  cwd: string;
  mode: string | null;
  model: string | null;
  effort: string | null;
  slack: boolean;
  live: number; // its runs still running
};
export type BotInput = Partial<Pick<Bot, "name" | "provider" | "cwd" | "mode" | "model" | "effort" | "slack">>;
export type BotHook = { url: string; token: string; header: string };

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await termToken();
  const r = await fetch(path, { ...init, headers: { "content-type": "application/json", "x-trame-term": token } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string }).error ?? `bots: ${r.status}`);
  return body as T;
}

export const listBots = () => call<Bot[]>("/api/agent/bots");
export const createBot = (b: BotInput) => call<Bot>("/api/agent/bots", { method: "POST", body: JSON.stringify(b) });
export const updateBot = (id: string, b: BotInput) =>
  call<Bot>(`/api/agent/bots/${id}`, { method: "PATCH", body: JSON.stringify(b) });
export const deleteBot = (id: string) => call<{ ok: boolean }>(`/api/agent/bots/${id}`, { method: "DELETE" });
export const botHook = (id: string) => call<BotHook>(`/api/agent/bots/${id}/hook`);
export const rotateBotHook = (id: string) => call<BotHook>(`/api/agent/bots/${id}/hook`, { method: "POST" });
export const runBot = (id: string, text: string) =>
  call<RunSummary>(`/api/agent/bots/${id}/runs`, { method: "POST", body: JSON.stringify({ text }) });

// what a cron, CI job or script runs to start the bot
export const hookCommand = (h: BotHook) =>
  `curl -X POST ${h.url} -H '${h.header}: ${h.token}' -H 'content-type: application/json' -d '{"text":"…","from":"my-hook"}'`;

// The bots, refreshed while something shows them; `reload` after a change.
export function useBots(enabled: boolean) {
  const [bots, setBots] = useState<Bot[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () => listBots().then((b) => alive && setBots(b), () => {});
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [enabled, tick]);
  return { bots, reload: () => setTick((t) => t + 1) };
}

// a name is how Slack addresses the bot: `name: task`
export const BOT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const botName = (folder: string) =>
  (folder.split("/").filter(Boolean).pop() ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "").slice(0, 32);
