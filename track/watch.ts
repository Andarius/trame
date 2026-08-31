// Comment watcher: answers human replies on agent threads by running each thread's
// agent (the model that authored it).
//
// Polls the running Trame app for human replies sitting on a comment thread an agent
// started, marks each seen, runs the matching CLI to compose an answer, posts it, and
// marks it "answered". One item at a time. Survives app restarts (re-reads the port each
// pass) and its own crashes (the app re-surfaces a stuck "answering…" after --stale).
//
// SECURITY: thread text is attacker-controllable on a shared page and is fed to a
// tool-capable CLI, so a malicious comment can attempt prompt injection. The CLI runs
// read-only; still, do not point --cwd at a repo holding secrets on shared/multi-user
// pages — a crafted reply could coax the agent into leaking file contents into an answer.
//
//   deno run -A track/watch.ts [--agents codex,claude,glm] [--force-agent <id>]
//                              [--page ID,ID] [--model ID] [--interval 5]
//                              [--stale 600] [--once] [--dry-run] [--cwd DIR]
//
// --agents restricts which agents this run answers (default: all it can run). codex and
// claude are built in; any other model id (glm, gemini, …) needs its own runner command:
// TRAME_WATCH_<AGENT>_CMD, e.g. TRAME_WATCH_GLM_CMD — a command where an `{}` arg is
// replaced by the prompt (no `{}` → prompt on stdin). TRAME_WATCH_TIMEOUT (secs) caps a
// run (default 300).
import { PORT_FILE } from "../app/config.ts";
import { agentIdentity, type AgentKind } from "../app/agent-comments.ts";

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
  agents: Set<AgentKind> | null; // null = any agent that has a runnable command
  pages: Set<string> | null; // null = every page
  model?: string; // forwarded to the built-in codex/claude runners
  forceAgent?: AgentKind;
  interval: number;
  stale: number;
  once: boolean;
  dryRun: boolean;
  cwd?: string;
};

function parseFlags(argv: string[]): Flags {
  const f: Flags = {
    agents: null,
    pages: null,
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
        val().split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
      );
    } else if (a === "--page") {
      f.pages = new Set(
        val().split(",").map((s) => s.trim()).filter(Boolean),
      );
    } else if (a === "--model") {
      f.model = val().trim() || undefined;
    } else if (a === "--force-agent") {
      f.forceAgent = val().trim().toLowerCase();
      if (!f.forceAgent) throw new Error("--force-agent needs an agent id");
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
  status: "seen" | "answering" | "answered" | "failed",
  agent?: string,
) =>
  api(base, `/api/comments/${id}/agent-status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status, agent }),
  });

// The prompt handed to the agent CLI. Exported for tests — pure, no I/O.
export function buildPrompt(item: InboxItem): string {
  const who = agentIdentity(item.agent).name;
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

// Shell-like split honouring single/double quotes so command paths and args may hold
// spaces. Quotes are stripped; a bare `{}` token survives for placeholder substitution.
function tokenize(s: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let open = false; // true once a token has started (incl. empty quotes "")
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      const end = s.indexOf(ch, i + 1);
      const stop = end === -1 ? s.length : end;
      cur += s.slice(i + 1, stop);
      i = stop;
      open = true; // adjacent runs join: "a"b'c' → abc
    } else if (/\s/.test(ch)) {
      if (open || cur) tokens.push(cur);
      cur = "";
      open = false;
    } else {
      cur += ch;
    }
  }
  if (open || cur) tokens.push(cur);
  return tokens;
}

// Per-agent CLI override, e.g. TRAME_WATCH_GLM_CMD for agent "glm".
const overrideFor = (agent: AgentKind) =>
  Deno.env.get(`TRAME_WATCH_${agent.toUpperCase()}_CMD`);

// Can the watcher answer as this agent? codex/claude are built in; any other model
// needs its own TRAME_WATCH_<AGENT>_CMD (no standard CLI to guess).
export function hasCommand(agent: AgentKind): boolean {
  return agent === "codex" || agent === "claude" || Boolean(overrideFor(agent));
}

// program + args for an agent, with a `{}` placeholder for the prompt. When no env
// override and no `{}`, the prompt is passed on stdin. `model` applies only to the
// built-in runners — an override command bakes in its own model flag.
export function agentCommand(
  agent: AgentKind,
  prompt: string,
  model?: string,
): { cmd: string; args: string[]; stdin: string | null } {
  const override = overrideFor(agent);
  if (override) {
    const parts = tokenize(override).filter((p) => p.length > 0);
    const hasSlot = parts.includes("{}");
    const args = parts.slice(1).map((p) => (p === "{}" ? prompt : p));
    return { cmd: parts[0], args, stdin: hasSlot ? null : prompt };
  }
  if (agent === "codex") {
    return {
      cmd: "codex",
      // JSONL carries the final agent message and token usage. Keep the sandbox
      // explicit: comment text is untrusted and may attempt prompt injection.
      args: [
        "exec",
        "--json",
        "--sandbox",
        "read-only",
        ...(model ? ["--model", model] : []),
        prompt,
      ],
      stdin: null,
    };
  }
  if (agent === "claude") {
    // --output-format json so we can report model + token usage; runAgent parses it
    return {
      cmd: "claude",
      args: [
        "-p",
        prompt,
        "--output-format",
        "json",
        ...(model ? ["--model", model] : []),
      ],
      stdin: null,
    };
  }
  throw new Error(
    `no command for agent "${agent}" — set TRAME_WATCH_${agent.toUpperCase()}_CMD`,
  );
}

export type AgentMeta = {
  model?: string;
  in?: number;
  out?: number;
  ms: number;
};
export type AgentResult = { body: string; meta: AgentMeta };

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

function modelFromEvent(event: JsonObject): string | undefined {
  const item = asObject(event.item);
  const metadata = asObject(event.metadata);
  for (
    const candidate of [
      event.model,
      event.model_id,
      event.model_name,
      item?.model,
      metadata?.model,
    ]
  ) {
    const model = asNonEmptyString(candidate);
    if (model) return model;
  }
  return undefined;
}

function parseCodexJsonl(
  out: string,
  ms: number,
  fallbackModel?: string,
): AgentResult | null {
  let sawCodexEvent = false;
  let body: string | undefined;
  let model: string | undefined;
  let usage: JsonObject | undefined;

  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: JsonObject | undefined;
    try {
      event = asObject(JSON.parse(line));
    } catch {
      // Be tolerant of a wrapper writing a warning alongside the JSONL stream.
      continue;
    }
    if (!event) continue;
    const type = asNonEmptyString(event.type);
    const isCodexEvent = type === "thread.started" ||
      type === "turn.started" || type === "turn.completed" ||
      type === "turn.failed" || type === "error" ||
      Boolean(type?.startsWith("item."));
    if (!isCodexEvent) {
      continue;
    }
    sawCodexEvent = true;
    model = modelFromEvent(event) ?? model;

    if (type === "item.completed") {
      const item = asObject(event.item);
      if (item?.type === "agent_message") {
        body = asNonEmptyString(item.text) ?? body;
      }
    } else if (type === "turn.completed") {
      usage = asObject(event.usage) ?? usage;
    }
  }

  if (!sawCodexEvent) return null;
  return {
    // A recognized stream with no completed agent message is a failed answer,
    // not text to post verbatim. runAgent rejects the empty body below.
    body: body ?? "",
    meta: {
      model: model ?? fallbackModel ?? "codex",
      // Codex input_tokens already includes cached input; cached_input_tokens is
      // the cached subset, so adding both would double-count the prompt.
      in: asNumber(usage?.input_tokens),
      out: asNumber(usage?.output_tokens),
      ms,
    },
  };
}

export function parseCodexDoctorModel(out: string): string | undefined {
  try {
    const root = asObject(JSON.parse(out));
    const checks = asObject(root?.checks);
    const config = asObject(checks?.["config.load"]);
    const details = asObject(config?.details);
    return asNonEmptyString(details?.model);
  } catch {
    return undefined;
  }
}

const codexModelLookups = new Map<string, Promise<string | undefined>>();

// The documented exec JSONL contract does not currently include the selected model.
// Codex's redacted doctor report does, so resolve it once per working directory and
// degrade to the agent id when an older CLI has no doctor command.
function resolveCodexModel(
  cwd: string | undefined,
): Promise<string | undefined> {
  const key = cwd ?? Deno.cwd();
  const previous = codexModelLookups.get(key);
  if (previous) return previous;
  const lookup = (async () => {
    try {
      const result = await new Deno.Command("codex", {
        args: ["doctor", "--json", "--summary"],
        cwd,
        stdin: "null",
        stdout: "piped",
        stderr: "null",
        signal: AbortSignal.timeout(15_000),
      }).output();
      if (!result.success) return undefined;
      return parseCodexDoctorModel(new TextDecoder().decode(result.stdout));
    } catch {
      return undefined;
    }
  })();
  codexModelLookups.set(key, lookup);
  return lookup;
}

function modelFromArgs(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model" || args[i] === "-m") {
      return asNonEmptyString(args[i + 1]);
    }
    if (args[i].startsWith("--model=")) {
      return asNonEmptyString(args[i].slice("--model=".length));
    }
  }
  return undefined;
}

// Extract the answer + stats from Claude's single JSON object or Codex's JSONL event
// stream; custom wrappers may still return plain text.
export function parseAgentOutput(
  agent: AgentKind,
  out: string,
  ms: number,
  fallbackModel?: string,
): AgentResult {
  if (agent === "codex") {
    const parsed = parseCodexJsonl(out, ms, fallbackModel);
    if (parsed) return parsed;
  }
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
  return { body: out, meta: { model: fallbackModel ?? agent, ms } };
}

async function runAgent(
  agent: AgentKind,
  prompt: string,
  cwd: string | undefined,
  model?: string,
): Promise<AgentResult> {
  const { cmd, args, stdin } = agentCommand(agent, prompt, model);
  const explicitModel = modelFromArgs(args);
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
  const res = parseAgentOutput(
    agent,
    out,
    Date.now() - started,
    explicitModel,
  );
  if (!res.body.trim()) throw new Error(`${cmd} produced no answer text`);
  if (
    agent === "codex" && res.meta.model === "codex" &&
    cmd.split("/").at(-1) === "codex"
  ) {
    res.meta.model = await resolveCodexModel(cwd) ?? "codex";
  }
  return res;
}

// Re-read the reply's current body; null if it vanished or the fetch failed.
async function refetchBody(
  base: string,
  pageId: string,
  id: string,
): Promise<string | null> {
  try {
    const comments = await api(
      base,
      `/api/comments?page=${encodeURIComponent(pageId)}`,
    ) as Comment[];
    return comments.find((c) => c.id === id)?.body ?? null;
  } catch {
    return null;
  }
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
    return;
  }

  await setStatus(base, id, "answering", agent);

  // Retry generation only; the answer is POSTed at most once per successful run.
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let body: string, meta: AgentMeta;
    try {
      ({ body, meta } = await runAgent(agent, prompt, flags.cwd, flags.model));
    } catch (e) {
      lastErr = e;
      console.error(
        `attempt ${attempt} for ${id} failed: ${(e as Error).message}`,
      );
      continue;
    }

    // Stale-reply guard: if the human edited their comment while we generated, skip
    // posting and leave it for the next pass to answer the new text.
    const current = await refetchBody(base, item.page.id, id);
    if (current !== item.comment.body) {
      console.log(`skipped ${id}: reply changed during generation`);
      return;
    }

    // POST exactly once. A failure here retries generation+POST (never a double POST
    // for one generation); success then marks "answered", and a failing status call is
    // only logged so we don't re-POST.
    try {
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
    } catch (e) {
      lastErr = e;
      console.error(
        `attempt ${attempt} for ${id} failed: ${(e as Error).message}`,
      );
      continue;
    }
    await setStatus(base, id, "answered", agent).catch((e) =>
      console.error(`answered ${id} but status set failed: ${e.message}`)
    );
    const t = meta.ms ? ` (${(meta.ms / 1000).toFixed(1)}s)` : "";
    console.log(`answered ${id} on "${item.page.title}" as ${agent}${t}`);
    return;
  }
  // give up: park it as failed so it won't loop; a human edit re-triggers it
  await setStatus(base, id, "failed", agent).catch(() => {});
  console.error(`gave up on ${id}: ${(lastErr as Error)?.message}`);
}

// codex/claude plus every agent given its own TRAME_WATCH_<AGENT>_CMD.
function configuredAgents(): string[] {
  const out = new Set(["codex", "claude"]);
  for (const k of Object.keys(Deno.env.toObject())) {
    const m = k.match(/^TRAME_WATCH_(.+)_CMD$/);
    if (m) out.add(m[1].toLowerCase());
  }
  return [...out];
}

// Agents this run covers (for the presence heartbeat): the --agents set, else every
// configured agent; only those the watcher can actually run.
function watchedAgents(flags: Flags): string[] {
  if (flags.forceAgent) return [flags.forceAgent].filter(hasCommand);
  return (flags.agents ? [...flags.agents] : configuredAgents()).filter(
    hasCommand,
  );
}

type PageRow = { id: string; parent_id: string | null; title: string };

const warnedSelectors = new Set<string>();

// --page selectors → concrete page ids. A selector is a page id or an exact
// (case-insensitive) title, and a match includes its whole subtree — so a project
// name/id scopes the watcher to every page under it. Re-resolved each pass, so
// renames and new subpages are picked up while running.
export async function resolvePages(
  base: string,
  selectors: Set<string>,
): Promise<Set<string>> {
  const pages = await api(base, "/api/pages") as PageRow[];
  const out = new Set<string>();
  for (const sel of selectors) {
    const s = sel.toLowerCase();
    const hits = pages.filter(
      (p) => p.id === sel || p.title.trim().toLowerCase() === s,
    );
    if (!hits.length && !warnedSelectors.has(sel)) {
      console.warn(`--page "${sel}" matches no page (by id or title)`);
      warnedSelectors.add(sel);
    }
    for (const h of hits) out.add(h.id);
  }
  const children = new Map<string | null, PageRow[]>();
  for (const p of pages) {
    children.set(p.parent_id, [...(children.get(p.parent_id) ?? []), p]);
  }
  const stack = [...out];
  while (stack.length) {
    for (const c of children.get(stack.pop()!) ?? []) {
      if (!out.has(c.id)) {
        out.add(c.id);
        stack.push(c.id);
      }
    }
  }
  return out;
}

async function pass(flags: Flags): Promise<boolean> {
  const base = readBase();
  if (!base) {
    console.warn("Trame app not running (no port file) — waiting…");
    return false;
  }
  // resolve --page selectors (ids or titles) to the covered page-id set; an
  // unmatched-only scope resolves empty and fails closed (answers nothing)
  let pageIds: Set<string> | null = null;
  if (flags.pages) {
    try {
      pageIds = await resolvePages(base, flags.pages);
    } catch (e) {
      console.warn(`pages unreachable: ${(e as Error).message}`);
      return false;
    }
  }
  // presence heartbeat: which agents are watched — every page's UI, or only the
  // --page ones when scoped
  for (const a of watchedAgents(flags)) {
    await api(base, "/api/presence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        watcher: a,
        pages: pageIds ? [...pageIds] : undefined,
      }),
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
  const skipped = new Set<string>();
  const mine = inbox.filter((i) => {
    if (pageIds && !pageIds.has(i.page.id)) return false;
    const target = flags.forceAgent ?? i.agent;
    if (flags.agents && !flags.agents.has(target)) return false;
    if (!hasCommand(target)) {
      skipped.add(target);
      return false;
    }
    return true;
  });
  if (skipped.size) {
    console.warn(
      `no command for agent(s): ${
        [...skipped].join(", ")
      } — set TRAME_WATCH_<AGENT>_CMD`,
    );
  }
  for (const item of mine) await handle(base, item, flags);
  return true;
}

const USAGE = `Answers human replies on agent comment threads in Trame.

Usage: tramecli answer [options]

Options:
  --agents a,b       only answer these agents (default: all runnable)
  --page P,P         only these pages + their subtrees; P is a page/project id or
                     exact title (default: every page)
  --model ID         model for the built-in codex/claude runners (default: CLI's own)
  --force-agent ID   answer every thread as this agent
  --interval SECS    poll interval (default: 5)
  --stale SECS       re-surface stuck "answering…" after this long (default: 600)
  --once             single pass, then exit
  --dry-run          print prompts instead of running agents
  --cwd DIR          working directory for the agent CLI
  -h, --help         show this help

Custom agents need TRAME_WATCH_<AGENT>_CMD ({} = prompt, else stdin).
TRAME_WATCH_TIMEOUT caps a run in seconds (default: 300).`;

export async function main(argv: string[] = Deno.args) {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    return;
  }
  const flags = parseFlags(argv);
  if (flags.once) {
    await pass(flags);
    return;
  }
  console.log(
    `watching Trame comments (agents: ${
      watchedAgents(flags).join(",") || "none — set TRAME_WATCH_<AGENT>_CMD"
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
