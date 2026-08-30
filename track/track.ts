// Writer invoked by the /trame:track slash command.
// App-first: POST to the running Trame instance (found via the port file) — the server
// handles upsert-by-repo+branch, client/objective name resolution, and the worklog event.
// Offline fallback: append to the outbox; the app drains it on next launch.
//
// Input: one JSON object, as argv[0] or on stdin. Shape:
//   { title, status?, client?, objective?, repo_path?, branch?, next_step?, links?, pr_url?, summary? }
// Specs live on the session's spec page — write them with the page writer
// (track/page.ts) using { session_id } after tracking.
import { CLAUDE_MAP, OUTBOX, PORT_FILE } from "../app/config.ts";

type Input = {
  title: string;
  status?: string;
  client?: string;
  objective?: string;
  repo_path?: string;
  branch?: string;
  next_step?: string;
  links?: { page_id: string; block_id?: string; anchor?: string }[]; // backlink chips (plan/TODO pages)
  pr_url?: string;
  summary?: string;
  claude_id?: string;
  agent?: "claude" | "codex";
  agent_id?: string;
};

async function readInput(): Promise<Input> {
  const arg = Deno.args[0];
  if (arg) return JSON.parse(arg);
  return JSON.parse(await new Response(Deno.stdin.readable).text());
}

// The Claude session UUID for this cwd, recorded by the UserPromptSubmit hook
// (track/claude-hook.ts). Fresh-only: the hook fires on the very prompt that runs
// /trame:track, so anything older belongs to a previous session.
async function claudeIdFor(cwd: string): Promise<string | undefined> {
  try {
    const map = JSON.parse(await Deno.readTextFile(CLAUDE_MAP)) as
      Record<string, { id: string; at: string }>;
    const e = map[cwd];
    if (e && Date.now() - Date.parse(e.at) < 3600_000) return e.id;
  } catch { /* hook not installed / no map yet */ }
  return undefined;
}

async function main() {
  const inp = await readInput();
  // Codex exposes the current resumable thread UUID directly. Claude needs the
  // UserPromptSubmit sidecar hook because slash commands do not receive its id.
  const codexId = Deno.env.get("CODEX_THREAD_ID");
  if (!inp.agent_id && codexId) {
    inp.agent = "codex";
    inp.agent_id = codexId;
  } else if (!inp.agent_id) {
    inp.claude_id ??= await claudeIdFor(inp.repo_path ?? Deno.cwd());
    if (inp.claude_id) {
      inp.agent = "claude";
      inp.agent_id = inp.claude_id;
    }
  }
  try {
    const { port } = JSON.parse(await Deno.readTextFile(PORT_FILE));
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(inp),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const { id, note, specs_page_id } = await res.json();
    console.log(`ok: session ${id} tracked in Trame (${inp.status ?? "active"} — ${inp.title})`);
    if (specs_page_id) console.log(`specs page: ${specs_page_id}`);
    if (note) console.log(`note: ${note}`);
  } catch (e) {
    const dir = OUTBOX.replace(/\/[^/]+$/, "");
    await Deno.mkdir(dir, { recursive: true }).catch(() => {});
    await Deno.writeTextFile(OUTBOX, JSON.stringify(inp) + "\n", { append: true });
    console.log(
      `Trame app not reachable (${(e as Error).message}) — queued to outbox, applied on next app launch`,
    );
  }
}

main();
