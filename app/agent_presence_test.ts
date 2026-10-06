import { assertEquals, assertThrows } from "@std/assert";
import { AgentPresenceError, listAgentPresence, touchAgentPresence } from "../core/agent-presence.ts";
import { normalizeAgentPresence } from "./files.ts";
import { providerFromBase, stateOf, usageOf } from "../track/presence.ts";
import { withPresenceHooks } from "../track/setup.ts";

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

Deno.test("hook events map to presence states", async (t) => {
  for (
    const [event, state] of [
      ["UserPromptSubmit", "working"],
      ["PreToolUse", "working"],
      ["Notification", "waiting"],
      ["Stop", "idle"],
      ["SessionEnd", "idle"],
      ["PostToolUse", null],
      ["SubagentStop", null],
    ] as const
  ) {
    await t.step(event, () => assertEquals(stateOf({ hook_event_name: event }), state));
  }
});

Deno.test("usageOf reads model and tokens from both transcript formats", async (t) => {
  const claude = [
    '{"type":"assistant","message":{"model":"claude-opus-5-5","usage":{"input_tokens":10,' +
    '"cache_creation_input_tokens":200,"cache_read_input_tokens":40000,"output_tokens":300}}}',
    '{"type":"user","message":{"content":"next"}}',
  ].join("\n");
  const codex = [
    '{"type":"turn_context","payload":{"model":"gpt-5.5-codex"}}',
    '{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":131904},' +
    '"total_token_usage":{"total_tokens":900000},"model_context_window":272000}}}',
  ].join("\n");
  for (
    const [id, tail, expected] of [
      ["claude jsonl", claude, { model: "claude-opus-5-5", tokens: 40510 }],
      ["codex rollout", codex, { model: "gpt-5.5-codex", tokens: 131904, context_max: 272000 }],
      ["cut first line + junk", `"usage":{"inp\n${claude}`, { model: "claude-opus-5-5", tokens: 40510 }],
      ["no usage yet", '{"type":"user"}', {}],
      ["named session", `{"type":"agent-name","agentName":"asso-fix-2"}\n${claude}`, {
        model: "claude-opus-5-5",
        tokens: 40510,
        name: "asso-fix-2",
      }],
    ] as const
  ) {
    await t.step(id, () => assertEquals(usageOf(tail), expected));
  }
});

Deno.test("setup --presence adds its hooks once and keeps the others", async (t) => {
  const mine = (f: ReturnType<typeof withPresenceHooks>) =>
    JSON.stringify(f).split("tramecli presence --hook claude").length - 1;
  for (
    const [id, start] of [
      ["empty settings", {}],
      ["existing hooks", { hooks: { Stop: [{ hooks: [{ type: "command", command: "choub notify" }] }] }, model: "x" }],
    ] as const
  ) {
    await t.step(id, () => {
      const once = withPresenceHooks(structuredClone(start) as Parameters<typeof withPresenceHooks>[0], "claude");
      const twice = withPresenceHooks(once, "claude");
      assertEquals([mine(once), mine(twice)], [5, 5]);
      assertEquals(JSON.stringify(twice).includes("choub notify"), id === "existing hooks");
    });
  }
});

Deno.test("providerFromBase names the backend behind Claude Code", async (t) => {
  for (
    const [base, want] of [
      [undefined, "Anthropic"],
      ["https://api.anthropic.com", "Anthropic"],
      ["https://api.z.ai/api/anthropic", "api.z.ai"],
      ["http://localhost:4000", "localhost:4000"],
      ["not a url", "Anthropic"],
    ] as const
  ) {
    await t.step(String(base), () => assertEquals(providerFromBase(base), want));
  }
});
