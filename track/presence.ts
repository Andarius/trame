// `tramecli presence` — a harness reports what its agent is doing on a session card.
// Input: one JSON object, as argv[0] or on stdin (contract in PRESENCE_HELP).
// `--hook claude|codex`: stdin is a Claude Code / Codex hook event instead.
// deno-lint-ignore no-import-prefix -- single std helper, not worth an import-map entry
import { TextLineStream } from "jsr:@std/streams@^1/text-line-stream";
import { CLAUDE_MAP } from "../app/config.ts";
import { apiRequest, resolveTarget } from "./target.ts";
import { installPresenceHooks } from "./setup.ts";

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
    case "SessionEnd":
      return "idle";
    default:
      return null;
  }
}

// Model + token use from the tail of the transcript (Claude JSONL or Codex rollout).
export function usageOf(tail: string): { model?: string; tokens?: number; context_max?: number; name?: string } {
  const out: { model?: string; tokens?: number; context_max?: number; name?: string } = {};
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
    // the session's name as the user set it (/rename), e.g. "asso-fix-2"
    if (r.type === "agent-name" && typeof r.agentName === "string") out.name ??= r.agentName;
    if (r.type === "custom-title" && typeof r.customTitle === "string") out.name ??= r.customTitle;
    if (out.model && out.tokens !== undefined && out.name) break;
  }
  return out;
}

export async function readTail(path: string, bytes = 256 * 1024): Promise<string> {
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

// Which backend serves this Claude Code: ANTHROPIC_BASE_URL (the env, else the active
// config's settings.json); unset means Anthropic itself.
export function providerFromBase(base: string | null | undefined): string {
  if (!base) return "Anthropic";
  let host: string;
  try {
    host = new URL(base).host;
  } catch {
    return "Anthropic";
  }
  // another backend is named by its host; Trame keeps no list of them
  return /(^|\.)anthropic\.com$/.test(host) ? "Anthropic" : host;
}

async function claudeProvider(): Promise<string> {
  let base = Deno.env.get("ANTHROPIC_BASE_URL");
  const dir = Deno.env.get("CLAUDE_CONFIG_DIR");
  if (!base && dir) {
    try {
      base = JSON.parse(await Deno.readTextFile(`${dir}/settings.json`)).env?.ANTHROPIC_BASE_URL;
    } catch { /* no settings: Anthropic */ }
  }
  return providerFromBase(base);
}

const THROTTLE_MS = 20_000; // repeated "working" pushes; state changes always go out

type HookState = { state?: string; at?: number; name?: string | null };
const stateFile = (sid: string) => CLAUDE_MAP.replace(/[^/]+$/, `presence-${sid}.json`);

async function readState(sid: string): Promise<HookState> {
  try {
    return JSON.parse(await Deno.readTextFile(stateFile(sid)));
  } catch {
    return {}; // first push
  }
}

// The last name a whole transcript gives its session; read once per session, then cached.
async function nameIn(path: string): Promise<string | null> {
  let name: string | null = null;
  const f = await Deno.open(path, { read: true });
  for await (const line of f.readable.pipeThrough(new TextDecoderStream()).pipeThrough(new TextLineStream())) {
    if (!line.includes('"agent-name"') && !line.includes('"custom-title"')) continue;
    name = usageOf(line).name ?? name;
  }
  return name;
}

async function fromHook(harness: "claude" | "codex") {
  const e = JSON.parse(await new Response(Deno.stdin.readable).text()) as HookEvent;
  const state = stateOf(e);
  if (!state || !e.session_id) return;
  const last = await readState(e.session_id);
  const ending = e.hook_event_name === "SessionEnd";
  if (!ending && last.state === state && Date.now() - (last.at ?? 0) < THROTTLE_MS) return;
  const usage = e.transcript_path ? usageOf(await readTail(e.transcript_path).catch(() => "")) : {};
  // a rename lands at the end (the tail); the original name may sit far above it
  const name = usage.name ?? last.name ??
    (e.transcript_path && last.name === undefined ? await nameIn(e.transcript_path).catch(() => null) : null);
  // the state only throttles a live session: drop it when the session ends
  await (ending
    ? Deno.remove(stateFile(e.session_id))
    : Deno.writeTextFile(stateFile(e.session_id), JSON.stringify({ state, at: Date.now(), name })))
    .catch(() => {});
  await post({
    session_id: e.session_id, // the server maps the harness's uuid to its card
    state,
    harness: harness === "claude" ? "claude-code" : "codex",
    provider: harness === "claude" ? await claudeProvider() : "OpenAI",
    name,
    model: e.model ?? usage.model,
    tokens: usage.tokens,
    context_max: usage.context_max,
    step: stepOf(e) ?? (e.hook_event_name === "UserPromptSubmit" ? "reading the prompt" : undefined),
    question: state === "waiting" ? e.message : undefined,
    // the session is over: the card's journal gets its "left" pill
    ended: e.hook_event_name === "SessionEnd" || undefined,
  });
}

export async function main(argv: string[] = Deno.args) {
  // launchers run this before `claude`: puts back hooks a regenerated config lost; silent
  if (argv.includes("--install-hooks")) {
    const home = Deno.env.get("HOME");
    if (home) await installPresenceHooks(home).catch(() => {});
    return;
  }
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
