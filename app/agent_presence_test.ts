import { describe, expect, test } from "bun:test";
import { AgentPresenceError, listAgentPresence, touchAgentPresence } from "../core/agent-presence.ts";

describe("touchAgentPresence rejects pushes the UI cannot render", () => {
  for (
    const [id, raw] of [
      ["unknown state", { state: "busy", harness: "codex" }],
      ["missing state", { harness: "codex" }],
      ["missing harness", { state: "working" }],
      ["blank harness", { state: "working", harness: "  " }],
    ] as const
  ) {
    test(id, () => {
      expect(() => touchAgentPresence(`s-${id}`, raw)).toThrow(AgentPresenceError);
    });
  }
});

describe("touchAgentPresence keeps `since` only while the state holds", () => {
  for (
    const [id, next, since] of [
      ["same state keeps the start", "working", 1_000],
      ["new state restarts the clock", "waiting", 5_000],
    ] as const
  ) {
    test(id, () => {
      touchAgentPresence(`since-${id}`, { state: "working", harness: "codex" }, 1_000);
      const p = touchAgentPresence(`since-${id}`, { state: next, harness: "codex" }, 5_000);
      expect([p.since, p.at]).toStrictEqual([since, 5_000]);
    });
  }
});

test("touchAgentPresence cleans free-form fields", () => {
  const p = touchAgentPresence("clean", {
    state: "working",
    harness: " spatchou ",
    tokens: -3,
    question: "only shown while waiting",
    step: "x".repeat(500),
  });
  expect([p.harness, p.tokens, p.question, p.step?.length]).toStrictEqual(["spatchou", null, null, 200]);
});

test("presence entries expire after 4h without a push", () => {
  touchAgentPresence("old", { state: "idle", harness: "codex" }, 0);
  const ids = listAgentPresence(4 * 60 * 60_000 + 1).map((p) => p.session_id);
  expect(ids.includes("old")).toStrictEqual(false);
});
