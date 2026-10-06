// Who worked on a card, from its journal (joined/left pills, attributed entries) and live presence.

export type JournalEntry = {
  at: string;
  kind: string;
  summary: string | null;
  agent?: string | null;
  agent_name?: string | null;
  model?: string | null;
  tokens?: number | null;
  cost_usd?: number | null;
};
export type LiveReport = {
  name: string | null;
  harness: string;
  model: string | null;
  tokens: number | null;
  state: "working" | "waiting" | null; // null = recently seen, not live
};
export type AgentSummary = {
  key: string; // the session's name, else its agent id
  agent: string; // harness / agent id, for the logo
  model: string | null;
  tokens: number | null;
  cost: number | null;
  ms: number; // time on the card across visits
  state: "working" | "waiting" | null;
};

// harness ids and journal agent ids name the same thing differently
const agentOf = (s: string) => (s === "claude-code" ? "claude" : s);

export function summarizeAgents(entries: JournalEntry[], live: LiveReport[], now = Date.now()): AgentSummary[] {
  const by = new Map<string, AgentSummary & { open: number | null; last: number; named: boolean }>();
  const get = (key: string, agent: string, named: boolean) => {
    let s = by.get(key);
    if (!s) {
      s = { key, agent, model: null, tokens: null, cost: null, ms: 0, state: null, open: null, last: 0, named };
      by.set(key, s);
    }
    return s;
  };
  const sorted = [...entries].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const e of sorted) {
    const key = e.agent_name ?? e.agent;
    if (!key) continue; // a human's entry
    const s = get(key, agentOf(e.agent ?? key), !!e.agent_name);
    const at = Date.parse(e.at);
    s.last = Math.max(s.last, at);
    if (e.model) s.model = e.model;
    if (e.tokens != null) s.tokens = Math.max(s.tokens ?? 0, e.tokens);
    if (e.cost_usd != null) s.cost = (s.cost ?? 0) + e.cost_usd;
    if (e.kind === "presence" && e.summary?.startsWith("joined")) s.open ??= at;
    if (e.kind === "presence" && e.summary?.startsWith("left") && s.open !== null) {
      s.ms += at - s.open;
      s.open = null;
    }
  }
  for (const r of live) {
    const s = get(r.name ?? agentOf(r.harness), agentOf(r.harness), !!r.name);
    s.state = r.state ?? s.state;
    if (r.model) s.model = r.model;
    if (r.tokens != null) s.tokens = Math.max(s.tokens ?? 0, r.tokens);
  }
  const all = [...by.values()].map(({ open, last, ...s }) => ({
    ...s,
    // a visit still open runs until now while live, else until its last entry
    ms: s.ms + (open === null ? 0 : (s.state ? now : last) - open),
  }));
  // entries written before sessions had names belong to the one named session of that
  // agent, when there is exactly one; with several it is ambiguous, so they stay apart
  const out: AgentSummary[] = [];
  for (const s of all.filter((x) => x.named)) out.push(strip(s));
  for (const u of all.filter((x) => !x.named)) {
    const same = out.filter((x) => x.agent === u.agent);
    if (same.length !== 1) {
      out.push(strip(u));
      continue;
    }
    const n = same[0];
    n.model ??= u.model;
    n.tokens = u.tokens == null ? n.tokens : Math.max(n.tokens ?? 0, u.tokens);
    n.cost = u.cost == null ? n.cost : (n.cost ?? 0) + u.cost;
    n.ms += u.ms;
    n.state ??= u.state;
  }
  return out;
}

function strip({ named: _named, ...s }: AgentSummary & { named: boolean }): AgentSummary {
  return s;
}

export function fmtDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}`;
}
