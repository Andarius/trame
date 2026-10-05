import { assertEquals, assertThrows } from "@std/assert";
import { AgentPresenceError, listAgentPresence, touchAgentPresence } from "../core/agent-presence.ts";
import { normalizeAgentPresence } from "./files.ts";

Deno.test("touchAgentPresence rejects pushes the UI cannot render", async (t) => {
  for (
    const [id, raw] of [
      ["unknown state", { state: "busy", harness: "codex" }],
      ["missing state", { harness: "codex" }],
      ["missing harness", { state: "working" }],
      ["blank harness", { state: "working", harness: "  " }],
    ] as const
  ) {
    await t.step(id, () => {
      assertThrows(() => touchAgentPresence(`s-${id}`, raw), AgentPresenceError);
    });
  }
});

Deno.test("touchAgentPresence keeps `since` only while the state holds", async (t) => {
  for (
    const [id, next, since] of [
      ["same state keeps the start", "working", 1_000],
      ["new state restarts the clock", "waiting", 5_000],
    ] as const
  ) {
    await t.step(id, () => {
      touchAgentPresence(`since-${id}`, { state: "working", harness: "codex" }, 1_000);
      const p = touchAgentPresence(`since-${id}`, { state: next, harness: "codex" }, 5_000);
      assertEquals([p.since, p.at], [since, 5_000]);
    });
  }
});

Deno.test("touchAgentPresence cleans free-form fields", () => {
  const p = touchAgentPresence("clean", {
    state: "working",
    harness: " spatchou ",
    tokens: -3,
    question: "only shown while waiting",
    step: "x".repeat(500),
  });
  assertEquals(
    [p.harness, p.tokens, p.question, p.step?.length],
    ["spatchou", null, null, 200],
  );
});

Deno.test("presence entries expire after 4h without a push", () => {
  touchAgentPresence("old", { state: "idle", harness: "codex" }, 0);
  const ids = listAgentPresence(4 * 60 * 60_000 + 1).map((p) => p.session_id);
  assertEquals(ids.includes("old"), false);
});

Deno.test("normalizeAgentPresence fills defaults and clamps", async (t) => {
  for (
    const [id, raw, expected] of [
      ["nothing stored", undefined, { marker: "ring", activity: "always", liveMinutes: 2, staleMinutes: 30 }],
      ["unknown enums fall back", { marker: "dots", activity: "sometimes" }, {
        marker: "ring",
        activity: "always",
        liveMinutes: 2,
        staleMinutes: 30,
      }],
      ["out of range", { marker: "rail", liveMinutes: 99, staleMinutes: 1 }, {
        marker: "rail",
        activity: "always",
        liveMinutes: 30,
        staleMinutes: 30,
      }],
      ["stale never before live", { liveMinutes: 20, staleMinutes: 10 }, {
        marker: "ring",
        activity: "always",
        liveMinutes: 20,
        staleMinutes: 20,
      }],
      ["hand-edited strings", { activity: "hover", liveMinutes: "5", staleMinutes: "60" }, {
        marker: "ring",
        activity: "hover",
        liveMinutes: 5,
        staleMinutes: 60,
      }],
    ] as const
  ) {
    await t.step(id, () => {
      const n = normalizeAgentPresence(raw);
      assertEquals(
        { marker: n.marker, activity: n.activity, liveMinutes: n.liveMinutes, staleMinutes: n.staleMinutes },
        expected,
      );
    });
  }
});

Deno.test("normalizeAgentPresence keeps unchecked boxes, drops unknown keys", () => {
  const n = normalizeAgentPresence({ fields: { tokens: false, extra: true }, tint: false, evil: 1 });
  assertEquals(n.fields, { harness: true, provider: true, model: true, tokens: false, step: true });
  assertEquals([n.tint, "evil" in n], [false, false]);
});
