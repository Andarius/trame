import { expect, test } from "bun:test";
import { applyEvent, type RunState } from "./agent-run-state";

const empty: RunState = {
  status: "ready",
  cwd: "/w/acme",
  sessionId: "s",
  model: null,
  mode: "default",
  turn: 0,
  items: [],
  droppedItems: 0,
  partial: "",
  error: null,
  interactions: [],
};

test("applyEvent replays a turn the way the server reduces it", () => {
  const events: [string, Record<string, unknown>][] = [
    ["turn.started", {}],
    ["item.completed", { kind: "user", text: "fix it", truncated: false }],
    ["item.delta", { text: "Look" }],
    ["item.delta", { text: "ing" }],
    ["interaction.requested", { requestId: "r1", kind: "permission", tool: "Write", input: {} }],
    ["interaction.requested", { requestId: "r2", kind: "question", tool: "AskUserQuestion", input: {} }],
    ["interaction.resolved", { requestId: "r1", decision: "allow" }],
    ["run.info", { mode: "plan", model: "opus" }],
    ["item.completed", { kind: "assistant", text: "Looking done", truncated: false }],
    ["turn.finished", { outcome: "success" }],
    ["run.state", { status: "failed", error: "boom" }],
  ];
  const states = events.reduce<RunState[]>((acc, [k, p]) => [...acc, applyEvent(acc.at(-1)!, k, p)], [empty]);
  expect(states[4].partial).toBe("Looking");
  expect(states[4].status).toBe("busy");
  expect(states[7].interactions.map((i) => i.requestId)).toEqual(["r2"]);
  const last = states.at(-1)!;
  expect([last.status, last.error, last.mode, last.model, last.turn, last.partial]).toEqual(["failed", "boom", "plan", "opus", 1, ""]);
  expect(last.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
  expect(applyEvent(empty, "run.state", { status: "nonsense" }).status).toBe("starting");
});

test("modelOf names the model a run uses, the CLI default before its first turn", async () => {
  const { modelOf } = await import("./agent-run-state");
  const models = [
    { value: "default", resolved: "claude-opus-5-5", label: "Default (recommended)" },
    { value: "opus", resolved: "claude-opus-5-5", label: "Opus 5.5" },
    { value: "sonnet", resolved: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  ];
  expect([null, "claude-opus-5-5", "sonnet", "claude-sonnet-5-5", "unknown"].map((model) => modelOf({ model, models })?.label ?? null))
    .toEqual(["Opus 5.5", "Opus 5.5", "Sonnet 5.5", "Sonnet 5.5", null]);
});
