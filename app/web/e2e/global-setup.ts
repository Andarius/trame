import { mkdir, rm, utimes, writeFile } from "node:fs/promises";

// Claude Code transcript fixtures for import.spec.ts (TRACKER_CLAUDE_DIR points here).
// alpha/uuid1: full metadata, TWO ai-title lines to prove last-wins; alpha/uuid2: bare +
// backdated 20 days for the window filter; subagents/ and -tmp-* must never be scanned.
async function writeClaudeFixtures(root: string) {
  const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;
  const alpha = `${root}/-repo-alpha`;
  await mkdir(`${alpha}/subagents`, { recursive: true });
  await mkdir(`${root}/-tmp-scratch`, { recursive: true });
  await writeFile(
    `${alpha}/11111111-1111-4111-8111-111111111111.jsonl`,
    line({ cwd: "/repo/alpha", gitBranch: "feat/import", timestamp: new Date(Date.now() - 3_600_000).toISOString() }) +
      line({ type: "ai-title", aiTitle: "First title" }) +
      line({ type: "last-prompt", lastPrompt: "do the thing" }) +
      line({ type: "ai-title", aiTitle: "Ship the import feature" }),
  );
  const old = `${alpha}/22222222-2222-4222-8222-222222222222.jsonl`;
  await writeFile(old, line({ cwd: "/repo/alpha" }));
  const backdated = new Date(Date.now() - 20 * 86_400_000);
  await utimes(old, backdated, backdated);
  await writeFile(`${alpha}/subagents/33333333-3333-4333-8333-333333333333.jsonl`, line({ cwd: "/repo/alpha" }));
  await writeFile(`${root}/-tmp-scratch/44444444-4444-4444-8444-444444444444.jsonl`, line({ cwd: "/tmp/scratch" }));
}

// Fresh sandbox for every run — the webServer creates a clean PGlite dir inside it.
// NOTE: Playwright starts the webServer BEFORE this runs, but PGlite init is lazy
// (first db() call), so wiping here is safe as long as no request happened yet —
// which is why the webServer readiness check polls the PORT only, never an API url.
export default async function globalSetup() {
  await rm("/tmp/trame-e2e", { recursive: true, force: true });
  await writeClaudeFixtures("/tmp/trame-e2e/claude-projects");
  // warm up PGlite now (first init can take >10s on cold CI runners): the server is
  // already listening, this first request builds the fresh data dir before any test.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch("http://127.0.0.1:8790/api/board");
      if (res.ok) {
        await res.body?.cancel();
        return;
      }
    } catch { /* server not accepting yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("backend never became ready");
}
