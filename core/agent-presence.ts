import type { Ctx } from "./ctx.ts";
import { addEvent, setSessionStatus } from "./sessions.ts";

// What each agent session is doing right now, pushed by its harness (any harness:
// Claude Code hooks, Codex hooks, spatchou, `tramecli presence`). In-memory and
// device-local like presence.ts: the UI derives live/stale from `at` + its settings.

export type AgentState = "working" | "waiting" | "idle";

export type AgentPresence = {
  session_id: string;
  state: AgentState;
  harness: string;
  name: string | null; // the session's own name (e.g. "asso-fix-2"), when the harness has one
  icon: string | null; // the agent's own icon (emoji or image URL) when Trame has none
  provider: string | null;
  model: string | null;
  tokens: number | null;
  context_max: number | null;
  step: string | null;
  question: string | null;
  page_id: string | null; // the todo it works on right now (links are history)
  block_id: string | null;
  since: number; // ms epoch the current state started
  at: number; // ms epoch of the last push (heartbeat)
};

// beyond the largest stale setting (240 min) nobody shows it anymore
const DROP_MS = 4 * 60 * 60_000;
const entries = new Map<string, AgentPresence>();

const str = (v: unknown, max: number) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;

export class AgentPresenceError extends Error {}

// Validates one push and stores it; `since` survives pushes that keep the same state.
export function touchAgentPresence(
  sessionId: string,
  raw: Record<string, unknown>,
  now = Date.now(),
): AgentPresence {
  const state = raw.state;
  if (state !== "working" && state !== "waiting" && state !== "idle") {
    throw new AgentPresenceError("state must be working, waiting or idle");
  }
  const harness = str(raw.harness, 40);
  if (!harness) throw new AgentPresenceError("harness is required");
  const prev = entries.get(sessionId);
  const p: AgentPresence = {
    session_id: sessionId,
    state,
    harness,
    name: str(raw.name, 60),
    icon: str(raw.icon, 2048),
    provider: str(raw.provider, 40),
    model: str(raw.model, 80),
    tokens: num(raw.tokens),
    context_max: num(raw.context_max),
    step: str(raw.step, 200),
    question: state === "waiting" ? str(raw.question, 300) : null,
    // a push without a target keeps the previous one
    page_id: str(raw.page_id, 64) ?? prev?.page_id ?? null,
    block_id: str(raw.block_id, 64) ?? prev?.block_id ?? null,
    since: prev && prev.state === state ? prev.since : now,
    at: now,
  };
  entries.set(sessionId, p);
  return p;
}

export function listAgentPresence(now = Date.now()): AgentPresence[] {
  const out: AgentPresence[] = [];
  for (const [id, p] of entries) {
    if (now - p.at > DROP_MS) entries.delete(id);
    else out.push(p);
  }
  return out;
}

const MINUTE = 60_000;
const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// Joined / left pills in the card's journal, so who worked on it survives restarts.
// One "joined" per visit (no second one until a "left"); "left" when the session ends.
export async function journalPresence(ctx: Ctx, cardId: string, p: AgentPresence, ended: boolean): Promise<void> {
  if (!p.name && !p.harness) return;
  const last = (await ctx.q.query(
    `select summary, at from session_events
      where session_id=$1 and kind='presence' and agent_name is not distinct from $2 and not deleted
      order by at desc, id desc limit 1`,
    [cardId, p.name],
  )).rows[0] as { summary: string; at: string | Date } | undefined;
  const open = !!last?.summary.startsWith("joined");
  const agent = p.harness === "claude-code" ? "claude" : p.harness;
  const usage = { agent_name: p.name, model: p.model, tokens: p.tokens };
  if (!ended && p.state !== "idle" && !open) {
    await addEvent(ctx, cardId, "joined", "presence", agent, usage);
    // an agent picking a card up makes it active, unless it is done (a terminal column)
    const card = (await ctx.q.query(
      `select s.status, coalesce(t.terminal, false) as terminal
         from sessions s left join statuses t on t.key = s.status and not t.deleted
        where s.id=$1 and not s.deleted`,
      [cardId],
    )).rows[0] as { status: string; terminal: boolean } | undefined;
    if (card && !card.terminal && card.status !== "active") await setSessionStatus(ctx, cardId, "active");
  } else if (ended && open) {
    const mins = Math.max(1, Math.round((Date.now() - new Date(last!.at).getTime()) / MINUTE));
    const tok = p.tokens != null ? ` · ${fmtK(p.tokens)} tok` : "";
    await addEvent(ctx, cardId, `left · ${mins} min${tok}`, "presence", agent, usage);
  }
}

export type AgentLink = { page_id: string; block_id: string | null; anchor: string; page_title: string };
export type LiveAgent = AgentPresence & { session_title: string; links: AgentLink[] };

// Every known agent with its session title and the todos/pages it is linked to.
export async function listLiveAgents(ctx: Ctx): Promise<LiveAgent[]> {
  const list = listAgentPresence();
  if (!list.length) return [];
  const rows = (await ctx.q.query(
    `select s.id, s.title, l.page_id, l.block_id, l.anchor, p.title as page_title
       from sessions s
       left join session_links l on l.session_id = s.id and not l.deleted
       left join pages p on p.id = l.page_id and not p.deleted
      where s.id = any($1::uuid[]) and not s.deleted`,
    [list.map((p) => p.session_id)],
  )).rows as {
    id: string;
    title: string;
    page_id: string | null;
    block_id: string | null;
    anchor: string | null;
    page_title: string | null;
  }[];
  const bySession = new Map<string, { title: string; links: AgentLink[] }>();
  for (const r of rows) {
    const s = bySession.get(r.id) ?? { title: r.title, links: [] };
    if (r.page_id && r.page_title !== null) {
      s.links.push({ page_id: r.page_id, block_id: r.block_id, anchor: r.anchor ?? "", page_title: r.page_title });
    }
    bySession.set(r.id, s);
  }
  // a deleted/unknown session drops out
  return list.flatMap((p) => {
    const s = bySession.get(p.session_id);
    return s ? [{ ...p, session_title: s.title, links: s.links }] : [];
  });
}
