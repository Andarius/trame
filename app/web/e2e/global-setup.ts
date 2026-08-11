import { mkdir, rm, utimes, writeFile } from "node:fs/promises";

// Claude Code transcript fixtures for import.spec.ts (TRACKER_CLAUDE_DIR points here).
// alpha/uuid1: full metadata, TWO ai-title lines to prove last-wins; alpha/uuid2: no
// ai-title (titled from the first user prompt) + backdated 20 days for the window
// filter; uuid5 is an empty aborted launch; subagents/ and -tmp-* must never be scanned.
async function writeClaudeFixtures(root: string) {
  const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;
  const alpha = `${root}/-repo-alpha`;
  await mkdir(`${alpha}/subagents`, { recursive: true });
  await mkdir(`${root}/-tmp-scratch`, { recursive: true });
  await writeFile(
    `${alpha}/11111111-1111-4111-8111-111111111111.jsonl`,
    line({ cwd: "/repo/alpha", gitBranch: "feat/import", timestamp: new Date(Date.now() - 3_600_000).toISOString() }) +
      line({ type: "user", message: { role: "user", content: "build the import" } }) +
      line({ type: "ai-title", aiTitle: "First title" }) +
      line({ type: "last-prompt", lastPrompt: "do the thing" }) +
      line({ type: "ai-title", aiTitle: "Ship the import feature" }),
  );
  const old = `${alpha}/22222222-2222-4222-8222-222222222222.jsonl`;
  await writeFile(
    old,
    line({ cwd: "/repo/alpha" }) +
      line({ type: "user", message: { role: "user", content: "fix the flaky retry test" } }),
  );
  const backdated = new Date(Date.now() - 20 * 86_400_000);
  await utimes(old, backdated, backdated);
  // aborted launch: no user/assistant line at all — must never be listed
  await writeFile(`${alpha}/55555555-5555-4555-8555-555555555555.jsonl`, line({ cwd: "/repo/alpha" }));
  await writeFile(`${alpha}/subagents/33333333-3333-4333-8333-333333333333.jsonl`, line({ cwd: "/repo/alpha" }));
  await writeFile(`${root}/-tmp-scratch/44444444-4444-4444-8444-444444444444.jsonl`, line({ cwd: "/tmp/scratch" }));
}

// A backdated primary Codex rollout plus a subagent rollout. Keeping both outside
// the UI's 30-day presets lets the existing Claude window tests stay focused.
async function writeCodexFixtures(root: string) {
  const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;
  const day = `${root}/2026/05/20`;
  await mkdir(day, { recursive: true });
  const old = new Date(Date.now() - 40 * 86_400_000);
  const id = "66666666-6666-4666-8666-666666666666";
  const subId = "77777777-7777-4777-8777-777777777777";
  const meta = (sessionId: string, subagent = false) => ({
    timestamp: old.toISOString(),
    type: "session_meta",
    payload: {
      id: sessionId,
      cwd: "/repo/codex-project",
      git: { branch: "feat/codex-import" },
      thread_source: subagent ? "subagent" : "user",
      parent_thread_id: subagent ? id : null,
      source: subagent ? { subagent: { other: "test" } } : "cli",
    },
  });
  const user = {
    timestamp: old.toISOString(),
    type: "event_msg",
    payload: { type: "user_message", message: "parse Codex rollout sessions", text_elements: [] },
  };
  const primary = `${day}/rollout-2026-05-20T10-00-00-${id}.jsonl`;
  const sub = `${day}/rollout-2026-05-20T10-01-00-${subId}.jsonl`;
  await writeFile(primary, line(meta(id)) + line(user));
  await writeFile(sub, line(meta(subId, true)) + line(user));
  await utimes(primary, old, old);
  await utimes(sub, old, old);
}

// Fresh sandbox for every run — the webServer creates a clean PGlite dir inside it.
// NOTE: Playwright starts the webServer BEFORE this runs, but PGlite init is lazy
// (first db() call), so wiping here is safe as long as no request happened yet —
// which is why the webServer readiness check polls the PORT only, never an API url.
export default async function globalSetup() {
  const dir = process.env.TRAME_E2E_DIR ?? "/tmp/trame-e2e";
  const port = process.env.TRAME_E2E_PORT ?? "8790";
  await rm(dir, { recursive: true, force: true });
  await writeClaudeFixtures(`${dir}/claude-projects`);
  await writeCodexFixtures(`${dir}/codex-sessions`);
  // warm up PGlite now (first init can take >10s on cold CI runners): the server is
  // already listening, this first request builds the fresh data dir before any test.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/board`);
      if (res.ok) {
        await res.body?.cancel();
        return;
      }
    } catch { /* server not accepting yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("backend never became ready");
}
