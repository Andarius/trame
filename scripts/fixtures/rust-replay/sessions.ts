// DESCRIPTION: Replay the sessions API against two isolated, deterministic local databases.
// USAGE: import replaySessions into the copied-database differential runner.

type Request = (method: string, path: string, body?: unknown) => Promise<any>;

export async function replaySessions(request: Request): Promise<void> {
  const get = (path: string) => request("GET", path);
  const post = (path: string, body: unknown = {}) => request("POST", path, body);
  const project = await post("/api/pages", { title: "Rust replay project", kind: "project" });
  const page = await post("/api/pages", { title: "Rust replay plan", parent_id: project.id });
  const story = await post("/api/stories", { title: "Rust replay story", client: "Rust replay project" });
  const id = "77777777-7777-4777-8777-000000000301";
  const harness = "77777777-7777-4777-8777-000000000302";

  await get("/api/board");
  await get("/api/board?deleted=1");
  await get("/api/search?q=replay");
  await get("/api/search?q=%25%5C_");
  await get("/api/due");
  await get("/api/stories/similar?q=Rust%20replay%20story&client=Rust%20replay%20project");
  await post(`/api/stories/${story.id}`, { brief: "A short brief" });
  await post("/api/tags", { label: "  " });
  const tag = await post("/api/tags", { label: "Team: DévOps" });
  await post("/api/tags", { label: "Team: DévOps" });
  await get("/api/tags");
  await post(`/api/tags/${tag.id}`, { label: "Platform" });

  await post("/api/sessions", { title: "invalid tags", tags: [""] });
  await post("/api/sessions", { card: "bad" });
  await post("/api/sessions", { card: "77777777-7777-4777-8777-000000000399" });
  await post("/api/sessions", {
    id, title: "Rust replay card", status: "active", client_id: project.id, page_id: story.id,
    repo_path: "/tmp/rust-replay", branch: "feat/replay", summary: "Started replay", agent: "codex",
    agent_id: harness, tags: ["Team: DévOps", "team-devops"],
    links: [{ page_id: page.id, anchor: "Rust replay plan" }],
  });
  await get(`/api/sessions/${id}`);
  await get(`/api/sessions/${harness}?events=2`);
  await get("/api/sessions/77777777-7777-4777-8777-000000000399");
  await post("/api/sessions", { id, status: "paused", pr_url: null });
  await post(`/api/sessions/${id}/events`, { summary: "manual note", agent: "codex", model: "gpt", tokens: 120 });
  await get(`/api/sessions/${id}/events`);
  await post(`/api/sessions/${id}/links`, { page_id: page.id, anchor: "another" });
  const links = await get(`/api/sessions/${id}/links`);
  await post(`/api/links/${links[0].id}/delete`);
  await get(`/api/sessions/${id}/links`);
  await post(`/api/sessions/${id}/specs-page`);
  await post(`/api/sessions/${id}/status`, { status: "done" });
  await get("/api/board");
  await post(`/api/sessions/${id}/status`, { status: "active" });

  const status = await post("/api/statuses", { label: "Rust Review", color: "#abcdef" });
  await post(`/api/statuses/${status.id}`, { label: "Rust Ready", terminal: true });
  await post(`/api/statuses/${status.id}/move`, { dir: -1 });
  await post(`/api/statuses/${status.id}/move`, { dir: 1 });
  await post(`/api/statuses/${status.id}/delete`);
  await post(`/api/tags/${tag.id}/delete`);

  await post(`/api/sessions/${id}/presence`, { state: "busy", harness: "codex" });
  await post(`/api/sessions/${id}/presence`, { state: "working" });
  await post(`/api/sessions/${id}/presence`, { state: "working", harness: "codex", name: "replay" });
  await get("/api/agent-presence");
  await post("/api/presence", { page_id: page.id });
  await get(`/api/presence?page=${page.id}`);
  await post(`/api/sessions/${id}/presence`, { state: "idle", harness: "codex", ended: true });
  await post(`/api/sessions/${id}/delete`);
  await get("/api/board?deleted=1");
  await post(`/api/sessions/${id}/restore`);
  await get(`/api/sessions/${id}`);
}
