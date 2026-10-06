import { assertEquals } from "@std/assert";
import { fmtDuration, summarizeAgents } from "./agent-summary.ts";

const at = (min: number) => new Date(Date.UTC(2026, 9, 6, 14, min)).toISOString();
const NOW = Date.parse(at(59));

Deno.test("summarizeAgents adds visits, keeps the top token count and sums cost", async (t) => {
  for (
    const [id, entries, live, expected] of [
      ["closed visit", [
        { at: at(0), kind: "presence", summary: "joined", agent: "claude", agent_name: "s3-sse-1" },
        { at: at(10), kind: "log", summary: "x", agent: "claude", agent_name: "s3-sse-1", model: "opus", tokens: 900, cost_usd: 0.25 },
        { at: at(30), kind: "presence", summary: "left · 30 min · 1.2k tok", agent: "claude", agent_name: "s3-sse-1", tokens: 1200 },
      ], [], { key: "s3-sse-1", model: "opus", tokens: 1200, cost: 0.25, ms: 30 * 60_000, state: null }],
      ["open visit, live: runs until now", [
        { at: at(29), kind: "presence", summary: "joined", agent: "codex", agent_name: "k3s-1" },
      ], [{ name: "k3s-1", harness: "codex", model: "gpt", tokens: 5, state: "waiting" as const }],
        { key: "k3s-1", model: "gpt", tokens: 5, cost: null, ms: 30 * 60_000, state: "waiting" }],
      ["open visit, not live: runs until its last entry", [
        { at: at(0), kind: "presence", summary: "joined", agent: "claude", agent_name: "a" },
        { at: at(12), kind: "log", summary: "x", agent: "claude", agent_name: "a" },
      ], [], { key: "a", model: null, tokens: null, cost: null, ms: 12 * 60_000, state: null }],
      ["human entries are not agents", [{ at: at(1), kind: "log", summary: "note" }], [], undefined],
      ["unnamed entries fold into the one named session of that agent", [
        { at: at(0), kind: "log", summary: "old", agent: "claude", tokens: 500, cost_usd: 0.1 },
        { at: at(5), kind: "log", summary: "new", agent: "claude", agent_name: "s3-sse-1", model: "opus" },
      ], [], { key: "s3-sse-1", model: "opus", tokens: 500, cost: 0.1, ms: 0, state: null }],
    ] as const
  ) {
    await t.step(id, () => {
      const [s] = summarizeAgents(entries as never, live as never, NOW);
      assertEquals(
        s && { key: s.key, model: s.model, tokens: s.tokens, cost: s.cost, ms: s.ms, state: s.state },
        expected,
      );
    });
  }
});

Deno.test("fmtDuration", async (t) => {
  for (const [ms, out] of [[38 * 60_000, "38 min"], [64 * 60_000, "1 h 04"], [0, "0 min"]] as const) {
    await t.step(out, () => assertEquals(fmtDuration(ms), out));
  }
});

Deno.test("unnamed entries stay apart when several sessions of that agent are named", () => {
  const out = summarizeAgents([
    { at: at(0), kind: "log", summary: "old", agent: "claude" },
    { at: at(1), kind: "log", summary: "a", agent: "claude", agent_name: "a" },
    { at: at(2), kind: "log", summary: "b", agent: "claude", agent_name: "b" },
  ], [], NOW);
  assertEquals(out.map((s) => s.key).sort(), ["a", "b", "claude"]);
});
