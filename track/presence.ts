// `tramecli presence` — a harness reports what its agent is doing on a session card.
// Input: one JSON object, as argv[0] or on stdin (contract in PRESENCE_HELP).
// `--hook claude|codex`: stdin is a Claude Code / Codex hook event instead.
import { CLAUDE_MAP } from "../app/config.ts";
import { apiRequest, resolveTarget } from "./target.ts";

type Push = Record<string, unknown> & { session_id?: string };

async function post(push: Push) {
  const { session_id, ...body } = push;
  if (typeof session_id !== "string" || !session_id) throw new Error("session_id is required");
  const target = await resolveTarget();
  await apiRequest(target, `/api/sessions/${session_id}/presence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export type HookEvent = {
  session_id?: string;
  hook_event_name?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  message?: string;
  model?: string;
};

// "Edit main.tf", "Bash just test" — the tool and the bit of input that says what it touches
function stepOf(e: HookEvent): string | null {
  if (!e.tool_name) return null;
  const i = e.tool_input ?? {};
  const target = [i.file_path, i.path, i.command, i.pattern, i.url, i.description]
    .find((v) => typeof v === "string" && v.trim()) as string | undefined;
  const short = target?.includes("/") && !target.includes(" ") ? target.split("/").slice(-2).join("/") : target;
  return [e.tool_name, short?.replace(/\s+/g, " ").slice(0, 80)].filter(Boolean).join(" ");
}

// The state a hook event means; null = not worth a push.
export function stateOf(e: HookEvent): "working" | "waiting" | "idle" | null {
  switch (e.hook_event_name) {
    case "UserPromptSubmit":
    case "PreToolUse":
      return "working";
    case "Notification":
      return "waiting";
    case "Stop":
      return "idle";
    default:
      return null;
  }
}

// Model + token use from the tail of the transcript (Claude JSONL or Codex rollout).
export function usageOf(tail: string): { model?: string; tokens?: number; context_max?: number } {
  const out: { model?: string; tokens?: number; context_max?: number } = {};
  for (const line of tail.split("\n").reverse()) {
    // deno-lint-ignore no-explicit-any -- two foreign JSONL formats, probed field by field
    let r: Record<string, any>;
    try {
      r = JSON.parse(line);
    } catch {
      continue; // the first line of a tail is usually cut
    }
    const m = r.message;
    if (r.type === "assistant" && m?.usage && out.tokens === undefined) {
      const u = m.usage;
      out.model ??= m.model;
      out.tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
    }
    const info = r.payload?.type === "token_count" ? r.payload.info : null;
    if (info && out.tokens === undefined) {
      out.tokens = info.last_token_usage?.input_tokens ?? info.total_token_usage?.total_tokens;
      out.context_max = info.model_context_window ?? undefined;
    }
    if (r.type === "turn_context" && r.payload?.model) out.model ??= r.payload.model;
    if (out.model && out.tokens !== undefined) break;
  }
  return out;
}

async function readTail(path: string, bytes = 256 * 1024): Promise<string> {
  const f = await Deno.open(path, { read: true });
  try {
    const { size } = await f.stat();
    await f.seek(Math.max(0, size - bytes), Deno.SeekMode.Start);
    const buf = new Uint8Array(Math.min(size, bytes));
    let n = 0;
    while (n < buf.length) {
      const r = await f.read(buf.subarray(n));
      if (r === null) break;
      n += r;
    }
    return new TextDecoder().decode(buf.subarray(0, n));
  } finally {
    f.close();
  }
}

const THROTTLE_MS = 20_000; // repeated "working" pushes; state changes always go out

async function throttled(sid: string, state: string): Promise<boolean> {
  const file = CLAUDE_MAP.replace(/[^/]+$/, `presence-${sid}.json`);
  let last: { state?: string; at?: number } = {};
  try {
    last = JSON.parse(await Deno.readTextFile(file));
  } catch { /* first push */ }
  if (last.state === state && Date.now() - (last.at ?? 0) < THROTTLE_MS) return true;
  await Deno.writeTextFile(file, JSON.stringify({ state, at: Date.now() })).catch(() => {});
  return false;
}

async function fromHook(harness: "claude" | "codex") {
  const e = JSON.parse(await new Response(Deno.stdin.readable).text()) as HookEvent;
  const state = stateOf(e);
  if (!state || !e.session_id || await throttled(e.session_id, state)) return;
  const usage = e.transcript_path ? usageOf(await readTail(e.transcript_path).catch(() => "")) : {};
  await post({
    session_id: e.session_id, // the server maps the harness's uuid to its card
    state,
    harness: harness === "claude" ? "claude-code" : "codex",
    provider: harness === "claude" ? "Anthropic" : "OpenAI",
    model: e.model ?? usage.model,
    tokens: usage.tokens,
    context_max: usage.context_max,
    step: stepOf(e) ?? (e.hook_event_name === "UserPromptSubmit" ? "reading the prompt" : undefined),
    question: state === "waiting" ? e.message : undefined,
  });
}

export async function main(argv: string[] = Deno.args) {
  const hook = argv.indexOf("--hook");
  if (hook >= 0) {
    const h = argv[hook + 1];
    if (h !== "claude" && h !== "codex") throw new Error("--hook takes claude or codex");
    // a hook must never block or fail the agent: no card, no app, bad input — all silent
    await fromHook(h).catch(() => {});
    return;
  }
  const raw = argv[0] || await new Response(Deno.stdin.readable).text();
  await post(JSON.parse(raw) as Push);
}
