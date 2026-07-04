import { rm } from "node:fs/promises";

// Fresh sandbox for every run — the webServer creates a clean PGlite dir inside it.
// NOTE: Playwright starts the webServer BEFORE this runs, but PGlite init is lazy
// (first db() call), so wiping here is safe as long as no request happened yet —
// which is why the webServer readiness check polls the PORT only, never an API url.
export default async function globalSetup() {
  await rm("/tmp/trame-e2e", { recursive: true, force: true });
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
