// Claude Code UserPromptSubmit hook: record which Claude session is live in each cwd.
// Slash commands can't see their own session id, so this sidecar map is how
// /trame:track (track.ts) learns the Claude UUID to attach to the card.
//
// Register in ~/.claude/settings.json (UserPromptSubmit → deno run -A this file).
// Input (stdin): hook JSON with { session_id, transcript_path, cwd }.
// Output: none; always exits 0 — a hook failure must never block the prompt.
import { CLAUDE_MAP } from "../app/config.ts";

type Entry = { id: string; transcript?: string; at: string };

const MAX_AGE_MS = 30 * 24 * 3600_000; // prune dead cwds so the map stays small

// Concurrent sessions fire this hook in parallel, and the whole map is rewritten each
// time — tmp+rename alone would still let the last writer drop the other's cwd. Spin on
// an O_EXCL lock, then give up and write anyway rather than lose the entry (a stale lock
// from a killed hook must not wedge every later prompt).
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = `${CLAUDE_MAP}.lock`;
  for (let i = 0; i < 50; i++) {
    try {
      (await Deno.open(lock, { createNew: true, write: true })).close();
      try {
        return await fn();
      } finally {
        await Deno.remove(lock).catch(() => {});
      }
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  return await fn();
}

try {
  const inp = JSON.parse(await new Response(Deno.stdin.readable).text()) as {
    session_id?: string;
    transcript_path?: string;
    cwd?: string;
  };
  if (inp.session_id && inp.cwd) {
    await Deno.mkdir(CLAUDE_MAP.replace(/\/[^/]+$/, ""), { recursive: true }).catch(() => {});
    await withLock(async () => {
      let map: Record<string, Entry> = {};
      try {
        map = JSON.parse(await Deno.readTextFile(CLAUDE_MAP));
      } catch { /* first run / corrupt file — start fresh */ }
      const now = Date.now();
      for (const [k, v] of Object.entries(map)) {
        if (now - Date.parse(v.at) > MAX_AGE_MS) delete map[k];
      }
      map[inp.cwd!] = { id: inp.session_id!, transcript: inp.transcript_path, at: new Date(now).toISOString() };
      const tmp = `${CLAUDE_MAP}.${crypto.randomUUID().slice(0, 8)}.tmp`;
      await Deno.writeTextFile(tmp, JSON.stringify(map, null, 2) + "\n");
      await Deno.rename(tmp, CLAUDE_MAP);
    });
  }
} catch { /* never block the prompt */ }
