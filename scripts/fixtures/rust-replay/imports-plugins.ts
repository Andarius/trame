// DESCRIPTION: Replay import and plugin HTTP contracts on isolated TS/Rust twins.
// USAGE: Import replayImportPlugins into scripts/rust-pages-diff.ts.
// deno-lint-ignore no-explicit-any
type Request = (method: string, path: string, body?: unknown) => Promise<any>;

export async function replayImportPlugins(request: Request): Promise<void> {
  const post = (path: string, body: unknown = {}) => request("POST", path, body);
  await request("GET", "/api/import/claude");
  await request("GET", "/api/import/claude?days=0");
  await request("GET", "/api/import/claude?days=90");
  await post("/api/import/claude", { items: [] });
  const id = "88888888-8888-4888-8888-000000000031";
  const invalid = "invalid-id";
  const item = { source: "codex", claudeId: id, title: "Imported replay session",
    repoPath: "/work/replay", branch: "main", client: "internal",
    project: "replay", status: "paused", lastActive: "2026-07-01T00:00:00.000Z" };
  await post("/api/import/claude", { items: [{ ...item, claudeId: invalid }, item] });
  await request("GET", `/api/sessions/${id}`);
  await post("/api/import/claude", { items: [item] });
  await post("/api/import/claude/ignore", { source: "codex", claudeId: id, ignored: true });
  await post("/api/import/claude/ignore", { source: "codex", claudeId: id, ignored: false });
  await request("GET", "/api/plugins");
  await request("GET", "/api/plugins/missing/settings");
  for (const path of ["/state", "/settings", "/test", "/auth-status", "/login", "/refresh", "/approve", "/cancel", "/ignore", "/changelog", "/enable"]) {
    await request("GET", `/api/plugins/deployments${path}`);
  }
}

// Call only when both twins use the same isolated deployments fixture.
export async function replayDeploymentsFixture(request: Request): Promise<void> {
  const base = "/api/plugins/deployments";
  const post = (path: string, body: unknown = {}) => request("POST", `${base}${path}`, body);
  await request("GET", "/api/plugins");
  await request("GET", `${base}/state`);
  await request("GET", `${base}/settings`);
  await post("/test", { forge: "github", githubToken: "fixture-only" });
  await post("/settings", { githubRepos: ["acme/webapp"], gitlabProjects: ["acme/api"],
    ships: { "acme/webapp": { pattern: "#(\\d+)\\b", environments: ["production"], backport: true } },
    pollIdleSeconds: 5, gitlabBaseUrl: "https://gl.example.com", gitlabToken: "fixture-pat" });
  await request("GET", `${base}/settings`);
  await post("/settings", { gitlabBaseUrl: "https://attacker.example.com" });
  await post("/enable", { enabled: true });
  const state = await post("/refresh");
  await request("GET", "/api/plugins");
  await request("GET", `${base}/state`);
  const items = state.items as { url: string; environment: string; action: unknown; cancel?: unknown }[];
  const first = items[0];
  await post("/changelog", { url: first.url, environment: first.environment });
  await post("/changelog", { url: "https://fixture.invalid/missing", environment: "none" });
  await post("/ignore", { url: "", environment: "" });
  await post("/ignore", { url: first.url, environment: first.environment, ignored: true });
  await post("/refresh");
  await post("/ignore", { url: first.url, environment: first.environment, ignored: false });
  await post("/approve", { url: first.url, environment: first.environment, action: first.action });
  await post("/refresh");
  const next = items.find((item) => item.cancel !== undefined);
  if (next) await post("/cancel", { url: next.url, environment: next.environment, action: next.cancel });
  await post("/enable", { enabled: false });
  await request("GET", `${base}/state`);
  await request("GET", "/api/plugins");
}
