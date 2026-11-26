import type { HistoryItem } from "../api";

export type Provider = "claude" | "codex";
export type RunStatus = "starting" | "ready" | "busy" | "interrupting" | "stopped" | "failed";
export type Interaction = {
  requestId: string;
  kind: "permission" | "question" | "plan";
  tool: string;
  toolUseId?: string;
  input: Record<string, unknown>;
};
export type RunState = {
  status: RunStatus;
  provider?: Provider;
  // what the provider's view offers: Codex has no permission modes; Claude restarts to change effort
  capabilities?: { modes: boolean; effortRestarts?: boolean };
  cwd: string;
  sessionId: string;
  model: string | null;
  mode: string | null;
  effort?: string | null;
  models?: ModelChoice[];
  // messages from outside waiting for an idle moment
  queued?: number;
  // this run takes the agent relay's incoming messages; why it can't, when it can't
  relay?: boolean;
  relayError?: string | null;
  turn: number;
  items: HistoryItem[];
  droppedItems: number;
  partial: string;
  error: string | null;
  interactions: Interaction[];
};
export type RunSummary = {
  id: string;
  cwd: string;
  epoch: string;
  status: RunStatus;
  sessionId: string;
  provider?: Provider;
  bot?: string | null; // the bot that started it
};
export type Reply = { accepted: boolean; reason?: string };
// a model the provider offers: `value` is what to ask for, `resolved` what it runs as
export type ModelChoice = { value: string; resolved?: string | null; label: string; description?: string | null; efforts?: string[] | null };
// Claude Code's permission modes, as its own picker words them; bypassing checks stays in the terminal
export const MODES = [
  { mode: "auto", label: "Auto", hint: "Claude handles permission decisions" },
  { mode: "manual", label: "Manual", hint: "Always ask before making changes" },
  { mode: "acceptEdits", label: "Accept edits", hint: "Automatically accept all file edits" },
  { mode: "plan", label: "Plan", hint: "Create a plan before making changes" },
] as const;
// the CLI reports Manual by its older name
export const modeOf = (mode: string | null) => MODES.find((m) => m.mode === (mode === "default" ? "manual" : mode)) ?? null;
// the offered model a run's model id stands for
export const modelOf = (s: Pick<RunState, "model" | "models">): ModelChoice | null => {
  // before its first turn a run hasn't said its model: it runs the provider's default
  const model = s.model ?? s.models?.find((m) => m.value === "default")?.resolved ?? null;
  return model ? findModel({ model, models: s.models }) : null;
};
const findModel = (s: Pick<RunState, "model" | "models">) =>
  s.models?.find((m) => m.value === s.model) ??
    // a resolved id names its model rather than the "default" alias pointing at it
    s.models?.find((m) => m.resolved === s.model && m.value !== "default") ??
    s.models?.find((m) => m.resolved === s.model) ?? null;

export type P = Record<string, unknown>;
const STATUSES: RunStatus[] = ["starting", "ready", "busy", "interrupting", "stopped", "failed"];

// The server's reducer, replayed on the client: what one event changes in the run's state.
export function applyEvent(s: RunState, kind: string, p: P): RunState {
  switch (kind) {
    case "run.state": {
      const status = STATUSES.includes(p.status as RunStatus) ? p.status as RunStatus : "starting";
      return { ...s, status, error: typeof p.error === "string" ? p.error : s.error };
    }
    case "run.info":
      return {
        ...s,
        sessionId: typeof p.sessionId === "string" ? p.sessionId : s.sessionId,
        model: typeof p.model === "string" ? p.model : s.model,
        mode: typeof p.mode === "string" ? p.mode : s.mode,
        effort: typeof p.effort === "string" ? p.effort : s.effort,
        models: Array.isArray(p.models) ? p.models as ModelChoice[] : s.models,
      };
    case "turn.started":
      return { ...s, turn: s.turn + 1, status: "busy", partial: "" };
    case "turn.finished":
      return { ...s, status: "ready", partial: "" };
    case "item.delta":
      return { ...s, partial: s.partial + (typeof p.text === "string" ? p.text : "") };
    case "item.completed":
      return { ...s, items: [...s.items, p as HistoryItem], partial: p.kind === "assistant" ? "" : s.partial };
    case "relay.state":
      return { ...s, relay: p.on === true, relayError: typeof p.error === "string" ? p.error : null };
    case "inbox.queued":
      return { ...s, queued: (s.queued ?? 0) + 1 };
    case "inbox.delivered":
      return { ...s, queued: Math.max(0, (s.queued ?? 0) - 1) };
    case "interaction.requested":
      return { ...s, interactions: [...s.interactions, p as Interaction] };
    case "interaction.resolved":
    case "interaction.cancelled":
      return { ...s, interactions: s.interactions.filter((i) => i.requestId !== p.requestId) };
    default:
      return s;
  }
}

