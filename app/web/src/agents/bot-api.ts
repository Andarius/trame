import { useEffect, useRef, useState } from "react";
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
  live: number; // its runs still running (idle or not), against its cap
  working: number; // of those, the ones mid-turn
  role: string | null;
  face: Face | null; // null: f1
  hue: number; // the backend derives one from the name when unset
  hasImage: boolean;
};
export type Face = "f1" | "f2" | "f3" | "f4";
export type BotInput =
  & Partial<Pick<Bot, "name" | "provider" | "cwd" | "mode" | "model" | "effort" | "slack" | "face">>
  & { role?: string; hue?: number | null };
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

export type { BotActivity, BotRun, BotStats, Daily, Outcome, RunSource, Sources } from "./bot-types";
import type { BotActivity, BotRun, BotStats } from "./bot-types";

export const botRuns = (id: string, limit = 50) => call<BotRun[]>(`/api/agent/bots/${id}/runs?limit=${limit}`);
export const botStats = (id: string, days = 30) => call<BotStats>(`/api/agent/bots/${id}/stats?days=${days}`);
export const botsActivity = (days = 28) => call<BotActivity[]>(`/api/agent/bots/activity?days=${days}`);
export const BOT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const BOT_IMAGE_MAX = 256 * 1024;
export async function putBotImage(id: string, file: Blob) {
  const r = await fetch(`/api/agent/bots/${id}/image`, {
    method: "PUT",
    body: file,
    headers: { "content-type": file.type, "x-trame-term": await termToken() },
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `image: ${r.status}`);
  }
}
export const deleteBotImage = (id: string) => call<{ ok: boolean }>(`/api/agent/bots/${id}/image`, { method: "DELETE" });
// <img> can't send the header; `v` busts the cache after an upload
export const botImageUrl = (id: string, token: string, v = 0) =>
  `/api/agent/bots/${id}/image?token=${encodeURIComponent(token)}&v=${v}`;

// Polls `load` every `ms` while mounted and the window is visible; a new `key` restarts it.
export function usePoll<T>(load: () => Promise<T>, ms: number, key: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    let alive = true;
    const run = () =>
      !document.hidden && latest.current().then((d) => alive && (setData(d), setError(null)), (e: Error) => alive && setError(e.message));
    void run();
    const timer = setInterval(run, ms);
    document.addEventListener("visibilitychange", run);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", run);
    };
  }, [key, ms, tick]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}

// what a cron, CI job or script runs to start the bot
export const hookCommand = (h: BotHook) =>
  `curl -X POST ${h.url} -H '${h.header}: ${h.token}' -H 'content-type: application/json' -d '{"text":"…","from":"my-hook"}'`;

// The bots, refreshed while something shows them; `reload` after a change.
export function useBots(enabled: boolean) {
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () => !document.hidden && listBots().then((b) => alive && setBots(b), () => {});
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [enabled, tick]);
  return { bots: bots ?? [], loaded: bots !== null, reload: () => setTick((t) => t + 1) };
}

// a name is how Slack addresses the bot: `name: task`
export const BOT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const botName = (folder: string) =>
  (folder.split("/").filter(Boolean).pop() ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "").slice(0, 32);
