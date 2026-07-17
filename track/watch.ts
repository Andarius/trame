// Comment watcher: drives codex/claude to answer human replies on agent threads.
//
// Polls the running Trame app for human replies sitting on a comment thread an agent
// started, marks each seen, runs the matching CLI to compose an answer, posts it, and
// clears the status. One item at a time. Survives app restarts (re-reads the port each
// pass) and its own crashes (the app re-surfaces a stuck "answering…" after --stale).
//
//   deno run -A track/watch.ts [--agents codex,claude] [--force-agent codex|claude]
//                              [--interval 5] [--stale 600] [--once] [--dry-run]
//                              [--cwd DIR]
//
// The agent CLIs are env-overridable (tests / custom wrappers): TRAME_WATCH_CODEX_CMD,
// TRAME_WATCH_CLAUDE_CMD — a space-split command where an `{}` arg is replaced by the
// prompt; with no `{}` the prompt is piped on stdin. TRAME_WATCH_TIMEOUT (secs) caps a
// run (default 300).
import { PORT_FILE } from "../app/config.ts";
import type { AgentKind } from "../app/agent-comments.ts";

const AGENT_AUTHOR_ID = "00000000-0000-4000-8000-0000000000aa";

type Comment = {
  id: string;
  author: string;
  author_id: string | null;
  body: string;
  updated_at: string;
};
type InboxItem = {
  comment: Comment;
  page: { id: string; title: string };
  block: { id: string; text: string };
  thread: Comment[];
  agent: AgentKind;
};

type Flags = {
  agents: Set<AgentKind>;
  forceAgent?: AgentKind;
  interval: number;
  stale: number;
  once: boolean;
  dryRun: boolean;
  cwd?: string;
};

function parseFlags(argv: string[]): Flags {
  const f: Flags = {
    agents: new Set<AgentKind>(["codex", "claude"]),
    interval: 5,
    stale: 600,
    once: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === "--agents") {
      f.agents = new Set(
        val().split(",").map((s) => s.trim()).filter((s): s is AgentKind =>
          s === "codex" || s === "claude"
        ),
      );
    } else if (a === "--force-agent") {
      const v = val();
      if (v !== "codex" && v !== "claude") {
        throw new Error('--force-agent must be "codex" or "claude"');
      }
      f.forceAgent = v;
    } else if (a === "--interval") f.interval = Number(val());
    else if (a === "--stale") f.stale = Number(val());
    else if (a === "--once") f.once = true;
    else if (a === "--dry-run") f.dryRun = true;
    else if (a === "--cwd") f.cwd = val();
    else throw new Error(`unknown flag: ${a}`);
  }
  return f;
}

function readBase(): string | null {
  try {
    const port = JSON.parse(Deno.readTextFileSync(PORT_FILE)).port;
    return `http://127.0.0.1:${port}`;
  } catch {
    return null;
  }
}

async function api(
  base: string,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`${path} → HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

const setStatus = (
  base: string,
  id: string,
  status: "seen" | "answering" | "failed" | "clear",
  agent?: string,
) =>
  api(base, `/api/comments/${id}/agent-status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status, agent }),
  });

// The prompt handed to the agent CLI. Exported for tests — pure, no I/O.
export function buildPrompt(item: InboxItem): string {
  const who = item.agent === "codex" ? "Codex" : "Claude";
  const thread = item.thread.map((c) => {
    const mine = c.author_id === AGENT_AUTHOR_ID;
    return `[${c.author}${mine ? " (you)" : ""}] ${c.body}`;
  }).join("\n");
  return [
    `You are ${who}. You left a review comment on the Trame page "${item.page.title}".`,
    `A human replied; write your answer as the next comment in the thread.`,
    ``,
    `Block under discussion:`,
    `> ${item.block.text}`,
    ``,
    `Thread (oldest first):`,
    thread,
    ``,
    `Answer the last human message. Be concise (a few sentences), plain text for a`,
    `small comment box. Output ONLY the comment body — no preamble, no markdown headings.`,
  ].join("\n");
}

// program + args for an agent, with a `{}` placeholder for the prompt. When no env
// override and no `{}`, the prompt is passed on stdin.
function agentCommand(
  agent: AgentKind,
  prompt: string,
): { cmd: string; args: string[]; stdin: string | null } {
  const override = Deno.env.get(
    agent === "codex" ? "TRAME_WATCH_CODEX_CMD" : "TRAME_WATCH_CLAUDE_CMD",
  );
  if (override) {
    const parts = override.split(/\s+/).filter(Boolean);
    const hasSlot = parts.includes("{}");
    const args = parts.slice(1).map((p) => (p === "{}" ? prompt : p));
    return { cmd: parts[0], args, stdin: hasSlot ? null : prompt };
  }
  if (agent === "codex") {
    return {
      cmd: "codex",
      args: ["exec", "--sandbox", "read-only", prompt],
      stdin: null,
    };
  }
  // --output-format json so we can report model + token usage; runAgent parses it
  return {
    cmd: "claude",
    args: ["-p", prompt, "--output-format", "json"],
    stdin: null,
  };
}

export type AgentMeta = {
  model?: string;
  in?: number;
  out?: number;
  ms: number;
};
type AgentResult = { body: string; meta: AgentMeta };

// Extract the answer + stats from a claude `--output-format json` blob; falls back to
// treating the whole output as the answer (codex text / custom wrappers).
function parseAgentOutput(
  agent: AgentKind,
  out: string,
  ms: number,
): AgentResult {
  try {
    const j = JSON.parse(out) as Record<string, unknown>;
    const result = j.result;
    if (typeof result === "string" && result.trim()) {
      const usage = (j.usage ?? {}) as Record<string, number>;
      const modelUsage = (j.modelUsage ?? {}) as Record<string, unknown>;
      const model = Object.keys(modelUsage)[0];
      const inTok = (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0);
      return {
        body: result.trim(),
        meta: {
          model,
          in: inTok || undefined,
          out: usage.output_tokens,
          ms: typeof j.duration_ms === "number" ? j.duration_ms : ms,
        },
      };
    }
  } catch {
    // not JSON — plain text output
  }
  return { body: out, meta: { model: agent, ms } };
}

async function runAgent(
  agent: AgentKind,
  prompt: string,
  cwd: string | undefined,
): Promise<AgentResult> {
  const { cmd, args, stdin } = agentCommand(agent, prompt);
  const timeoutMs = Number(Deno.env.get("TRAME_WATCH_TIMEOUT") ?? "300") * 1000;
  const started = Date.now();
  const proc = new Deno.Command(cmd, {
    args,
    cwd,
    stdin: stdin === null ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(timeoutMs),
  }).spawn();
  if (stdin !== null) {
    const w = proc.stdin.getWriter();
    await w.write(new TextEncoder().encode(stdin));
    await w.close();
  }
  const { code, stdout, stderr } = await proc.output();
  if (code !== 0) {
    throw new Error(
      `${cmd} exited ${code}: ${
        new TextDecoder().decode(stderr).trim().slice(0, 500)
      }`,
    );
  }
  const out = new TextDecoder().decode(stdout).trim();
  if (!out) throw new Error(`${cmd} produced no output`);
  const res = parseAgentOutput(agent, out, Date.now() - started);
  if (!res.body.trim()) throw new Error(`${cmd} produced no answer text`);
  return res;
}

async function handle(
  base: string,
  item: InboxItem,
  flags: Flags,
): Promise<void> {
  const agent = flags.forceAgent ?? item.agent;
  const { id } = item.comment;
  await setStatus(base, id, "seen", agent);
  const prompt = buildPrompt({ ...item, agent });
  if (flags.dryRun) {
    console.log(`[dry-run] would answer ${id} as ${agent}:\n${prompt}\n`);
    await setStatus(base, id, "clear");
    return;
  }

  await setStatus(base, id, "answering", agent);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { body, meta } = await runAgent(agent, prompt, flags.cwd);
      await api(base, "/api/comments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          page_id: item.page.id,
          block_id: item.block.id,
          anchor: item.block.text,
          body,
          agent,
          meta,
        }),
      });
      await setStatus(base, id, "clear");
      const t = meta.ms ? ` (${(meta.ms / 1000).toFixed(1)}s)` : "";
      console.log(`answered ${id} on "${item.page.title}" as ${agent}${t}`);
      return;
    } catch (e) {
      lastErr = e;
      console.error(
        `attempt ${attempt} for ${id} failed: ${(e as Error).message}`,
      );
    }
  }
  // give up: park it as failed so it won't loop; a human edit re-triggers it
  await setStatus(base, id, "failed", agent).catch(() => {});
  console.error(`gave up on ${id}: ${(lastErr as Error)?.message}`);
}

async function pass(flags: Flags): Promise<boolean> {
  const base = readBase();
  if (!base) {
    console.warn("Trame app not running (no port file) — waiting…");
    return false;
  }
  // presence heartbeat: show which agents are being watched, in every page's UI
  const watched = flags.forceAgent ? [flags.forceAgent] : [...flags.agents];
  for (const a of watched) {
    await api(base, "/api/presence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ watcher: a }),
    }).catch(() => {});
  }
  let inbox: InboxItem[];
  try {
    inbox = await api(
      base,
      `/api/comments/inbox?stale=${flags.stale}`,
    ) as InboxItem[];
  } catch (e) {
    console.warn(`inbox unreachable: ${(e as Error).message}`);
    return false;
  }
  const mine = inbox.filter((i) =>
    flags.agents.has(flags.forceAgent ?? i.agent)
  );
  for (const item of mine) await handle(base, item, flags);
  return true;
}

async function main() {
  const flags = parseFlags(Deno.args);
  if (flags.once) {
    await pass(flags);
    return;
  }
  console.log(
    `watching Trame comments (agents: ${
      [...flags.agents].join(",")
    }, every ${flags.interval}s)…`,
  );
  let backoff = flags.interval;
  for (;;) {
    const ok = await pass(flags);
    backoff = ok ? flags.interval : Math.min(backoff * 2, 60);
    await new Promise((r) => setTimeout(r, backoff * 1000));
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`error: ${(e as Error).message}`);
    Deno.exit(1);
  });
}
