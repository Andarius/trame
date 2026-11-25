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
  // what the provider's view offers; Codex has no permission modes to switch
  capabilities?: { modes: boolean };
  cwd: string;
  sessionId: string;
  model: string | null;
  mode: string | null;
  turn: number;
  items: HistoryItem[];
  droppedItems: number;
  partial: string;
  error: string | null;
  interactions: Interaction[];
};
export type RunSummary = { id: string; cwd: string; epoch: string; status: RunStatus; sessionId: string; provider?: Provider };
export type Reply = { accepted: boolean; reason?: string };
export const MODES = [
  { mode: "default", label: "Ask" },
  { mode: "acceptEdits", label: "Accept edits" },
  { mode: "plan", label: "Plan" },
] as const;

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
      };
    case "turn.started":
      return { ...s, turn: s.turn + 1, status: "busy", partial: "" };
    case "turn.finished":
      return { ...s, status: "ready", partial: "" };
    case "item.delta":
      return { ...s, partial: s.partial + (typeof p.text === "string" ? p.text : "") };
    case "item.completed":
      return { ...s, items: [...s.items, p as HistoryItem], partial: p.kind === "assistant" ? "" : s.partial };
    case "interaction.requested":
      return { ...s, interactions: [...s.interactions, p as Interaction] };
    case "interaction.resolved":
    case "interaction.cancelled":
      return { ...s, interactions: s.interactions.filter((i) => i.requestId !== p.requestId) };
    default:
      return s;
  }
}

