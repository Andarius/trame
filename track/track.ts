// Writer invoked by the trame-track skill.
// App-first: POST to the running Trame instance (found via the port file) — the server
// matches the card (agent session + story, else repo + branch), resolves client/story
// names, and writes the worklog event.
// Offline fallback: append to the outbox; the app drains it on next launch.
//
// Input: one JSON object, as argv[0] or on stdin. Shape:
//   { title, status?, client?, story?, repo_path?, branch?, next_step?, links?, pr_url?, summary? }
// Specs live on the session's spec page — write them with the page writer
// (track/page.ts) using { session_id } after tracking.
import { CLAUDE_MAP, OUTBOX } from "../app/config.ts";
import { appLink, resolveTarget, type Target, targetFetch } from "./target.ts";
import { parseSessionRef } from "../mcp/session_url.ts";
import { readTail, usageOf } from "./presence.ts";

type Input = {
  title: string;
  status?: string;
  client?: string;
  story?: string;
  tags?: string[];
  repo_path?: string;
  branch?: string;
  next_step?: string;
  links?: { page_id: string; block_id?: string; anchor?: string }[]; // backlink chips (plan/TODO pages)
  pr_url?: string;
  summary?: string;
  claude_id?: string;
  agent?: "claude" | "codex";
  agent_id?: string;
  card?: string; // an existing card to adopt: its id or a pasted Trame link
  agent_name?: string; // this session's own name; read from the transcript when absent
  model?: string; // exact model id writing this entry; stamped on the worklog line
  tokens?: number; // tokens spent on the work this entry reports
  cost_usd?: number;
};

// The session's own name (and model, unless given) from its Claude transcript, so the
// worklog line says which session wrote it. Best effort: no transcript, no stamp.
async function stampFromTranscript(inp: Input) {
  const id = inp.agent === "codex" ? null : (inp.agent_id ?? Deno.env.get("CLAUDE_CODE_SESSION_ID"));
  const home = Deno.env.get("HOME");
  if (!id || !home || (inp.agent_name && inp.model)) return;
  // per-backend launchers (glmclaude, pglmclaude, …) keep transcripts in their own config dir
  const root = `${Deno.env.get("CLAUDE_CONFIG_DIR") ?? `${home}/.claude`}/projects`;
  try {
    for await (const dir of Deno.readDir(root)) {
      const path = `${root}/${dir.name}/${id}.jsonl`;
      const tail = await readTail(path).catch(() => null);
      if (tail === null) continue;
      const u = usageOf(tail);
      inp.agent_name ??= u.name;
      inp.model ??= u.model;
      return;
    }
  } catch { /* no ~/.claude: nothing to stamp */ }
}

// a pasted Trame link names its card in the query string
function cardId(v: string): string {
  const ref = parseSessionRef(v);
  if (!ref || ref.kind !== "session") throw new Error(`card: not a card id or card link: ${v}`);
  return ref.id;
}

async function readInput(argv: string[]): Promise<Input> {
  const arg = argv[0];
  if (arg) return JSON.parse(arg);
  return JSON.parse(await new Response(Deno.stdin.readable).text());
}

// The Claude session UUID for this cwd, recorded by the UserPromptSubmit hook
// (track/claude-hook.ts). Fresh-only: the hook fires on the very prompt that runs
// trame-track, so anything older belongs to a previous session.
async function claudeIdFor(cwd: string): Promise<string | undefined> {
  try {
    const map = JSON.parse(await Deno.readTextFile(CLAUDE_MAP)) as Record<
      string,
      { id: string; at: string }
    >;
    const e = map[cwd];
    if (e && Date.now() - Date.parse(e.at) < 3600_000) return e.id;
  } catch { /* hook not installed / no map yet */ }
  return undefined;
}

export async function main(
  argv: string[] = Deno.args,
  opts: { json?: boolean } = {},
) {
  const inp = await readInput(argv);
  if (inp.card) inp.card = cardId(inp.card);
  await stampFromTranscript(inp);
  // Codex and Claude Code both export the current session UUID to every shell call,
  // subagents and worktrees included. The hook's cwd map is the fallback for older
  // Claude Code builds; it is keyed by the prompt's cwd, not the tracked repo_path.
  const codexId = Deno.env.get("CODEX_THREAD_ID");
  if (!inp.agent_id && codexId) {
    inp.agent = "codex";
    inp.agent_id = codexId;
  } else if (!inp.agent_id) {
    inp.claude_id ??= Deno.env.get("CLAUDE_CODE_SESSION_ID") ||
      await claudeIdFor(Deno.cwd());
    if (inp.claude_id) {
      inp.agent = "claude";
      inp.agent_id = inp.claude_id;
    }
  }
  if (!inp.story?.trim()) {
    console.error(
      "warning: no story — the story is what groups this session's branches onto one card",
    );
  }
  let target: Target;
  let res: Response;
  try {
    target = await resolveTarget();
    res = await targetFetch(target, "/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(inp),
      signal: AbortSignal.timeout(4000),
    });
  } catch (e) {
    return await queue(inp, (e as Error).message, opts);
  }
  if (!res.ok) {
    const error = `HTTP ${res.status}: ${await res.text()}`;
    // a hub rejection is final, and a box without the app never drains the outbox
    if (target.hub) throw new Error(`the hub rejected the track — ${error}`);
    return await queue(inp, error, opts);
  }
  const { id, note, specs_page_id, story_note } = await res.json();
  if (opts.json) {
    console.log(JSON.stringify({ id, specs_page_id, note, story_note }));
    return;
  }
  console.log(
    `ok: session ${id} tracked in Trame (${
      inp.status ?? "active"
    } — ${inp.title})${appLink(target, `view=card&card=${id}`)}`,
  );
  if (specs_page_id) console.log(`specs page: ${specs_page_id}`);
  if (story_note) console.log(`story: ${story_note}`);
  if (note) console.log(`note: ${note}`);
}

async function queue(inp: Input, error: string, opts: { json?: boolean }) {
  const dir = OUTBOX.replace(/\/[^/]+$/, "");
  await Deno.mkdir(dir, { recursive: true }).catch(() => {});
  await Deno.writeTextFile(OUTBOX, JSON.stringify(inp) + "\n", {
    append: true,
  });
  if (opts.json) {
    console.log(JSON.stringify({ queued: true, error }));
    return;
  }
  console.log(
    `Trame app not reachable (${error}) — queued to outbox, applied on next app launch`,
  );
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`error: ${(e as Error).message}`);
    Deno.exit(1);
  });
}
