// Writer invoked by the /project:track slash command.
// App-first: POST to the running Trame instance (found via the port file) — the server
// handles upsert-by-repo+branch, client/objective name resolution, and the worklog event.
// Offline fallback: append to the outbox; the app drains it on next launch.
//
// Input: one JSON object, as argv[0] or on stdin. Shape:
//   { title, status?, client?, objective?, repo_path?, branch?, next_step?, pr_url?, summary? }
import { OUTBOX, PORT_FILE } from "../app/config.ts";

type Input = {
  title: string;
  status?: string;
  client?: string;
  objective?: string;
  repo_path?: string;
  branch?: string;
  next_step?: string;
  pr_url?: string;
  summary?: string;
};

async function readInput(): Promise<Input> {
  const arg = Deno.args[0];
  if (arg) return JSON.parse(arg);
  return JSON.parse(await new Response(Deno.stdin.readable).text());
}

async function main() {
  const inp = await readInput();
  try {
    const { port } = JSON.parse(await Deno.readTextFile(PORT_FILE));
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(inp),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const { id } = await res.json();
    console.log(`ok: session ${id} tracked in Trame (${inp.status ?? "active"} — ${inp.title})`);
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
