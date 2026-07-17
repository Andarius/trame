// DESCRIPTION: seed a Trame instance with the synthetic demo dataset used for the README
// screenshots (docs/*.png). Fictional projects only — never point this at a real instance.
// USAGE: TRAME_URL=http://127.0.0.1:8799 deno run -A scripts/demo-seed.ts
// EXAMPLES: just demo   (spins up an isolated instance, seeds it, and serves it)
const base = Deno.env.get("TRAME_URL") ?? "http://127.0.0.1:8799";

const api = async (path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json();
};

const PROJECT_COLOR: Record<string, string> = {
  "Acme Web": "#7a9ee7",
  "Marketing Site": "#e3c567",
  "Mobile App": "#7bd88f",
};

// title, client, story, status, branch, next step
const SESSIONS: [string, string, string, string, string, string?][] = [
  ["site — Launch landing page", "Marketing Site", "Q3 Launch", "active", "main", "finalize hero copy with design"],
  ["web — Checkout redesign", "Acme Web", "Checkout flow", "active", "main", "wire up the Stripe payment intent"],
  ["site — SEO audit fixes", "Marketing Site", "Q3 Launch", "paused", "chore/seo"],
  ["mobile — Push notifications", "Mobile App", "Notifications", "paused", "feat/push"],
  ["web — Dark mode pass", "Acme Web", "Theming", "paused", "feat/dark-mode"],
  ["web — Fix cart race condition", "Acme Web", "Checkout flow", "blocked", "fix/cart-race", "waiting on API PR #42"],
  ["mobile — Onboarding flow", "Mobile App", "Onboarding", "done", "main"],
];

const board0 = await api("/api/board");
if (board0.sessions.length) {
  console.error("instance already has sessions — refusing to seed over it");
  Deno.exit(1);
}

// With DEMO_CLAUDE_DIR set (and the app's TRACKER_CLAUDE_DIR pointing at it), plant a
// transcript so the Checkout card is genuinely resumable — the drawer screenshot would
// otherwise read "No transcript on this device". The app only checks the file exists.
const AGENT_ID = "9f1c7c8e-3b2a-4d5e-8a1f-2c6b0d4e7a13";
const claudeDir = Deno.env.get("DEMO_CLAUDE_DIR");
if (claudeDir) {
  const dir = `${claudeDir}/-Users-demo-code-acme-web`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/${AGENT_ID}.jsonl`,
    JSON.stringify({ type: "user", cwd: "/Users/demo/code/acme-web" }) + "\n",
  );
}

for (const [title, client, objective, status, branch, next_step] of SESSIONS) {
  const checkout = title.includes("Checkout redesign");
  await api("/api/sessions", {
    title,
    client,
    objective,
    status,
    branch,
    next_step,
    repo_path: `/Users/demo/code/${client.toLowerCase().replace(/ /g, "-")}`,
    pr_url: checkout ? "https://github.com/acme/web/pull/128" : undefined,
    agent_id: checkout && claudeDir ? AGENT_ID : undefined,
    no_event: true,
  });
}

// project chips are colored per client
const pages = await api("/api/pages") as { id: string; title: string; kind: string }[];
for (const p of pages.filter((x) => x.kind === "project" && PROJECT_COLOR[x.title])) {
  await api(`/api/pages/${p.id}`, { color: PROJECT_COLOR[p.title] });
}

const { id: pageId } = await api("/api/pages", { title: "Release plan — v0.5", kind: "page" });
await api(`/api/pages/${pageId}`, {
  content: [
    { type: "heading", text: "Goals for v0.5", id: "b1" },
    {
      type: "text",
      text: "Ship offline-first sync polish and the new reporting view. Keep the local-first guarantee: everything works with no hub.",
      id: "b2",
    },
    { type: "heading", text: "Checklist", id: "b3" },
    { type: "todo", text: "Conflict banner when a pull overwrites a local edit", done: true, id: "b4" },
    { type: "todo", text: "Per-project weekly digest in Explore", done: false, id: "b5" },
    { type: "todo", text: "Keyboard nav for the board (j/k, x to move)", done: false, id: "b6" },
    { type: "heading", text: "Open questions", id: "b7" },
    {
      type: "text",
      text: "Do we surface the hub connection state in the title bar, or keep it in the sidebar footer only?",
      id: "b8",
    },
  ],
});

const { id: dbId } = await api("/api/udb", { name: "Release checklist" });
const { properties } = await api(`/api/udb/${dbId}`);
const titleId = (properties as { id: string; type: string }[]).find((p) => p.type === "title")!.id;

const opt = (name: string, color: string) => ({ id: name.toLowerCase().replace(/ /g, "-"), name, color });
const STATUS = [opt("Done", "#7bd88f"), opt("In progress", "#e3c567"), opt("Todo", "#8b93a3")];
const PRIO = [opt("High", "#e06c75"), opt("Med", "#e3c567"), opt("Low", "#7a9ee7")];
const { id: statusId } = await api(`/api/udb/${dbId}/props`, { name: "Status", type: "select", config: { options: STATUS } });
const { id: prioId } = await api(`/api/udb/${dbId}/props`, { name: "Priority", type: "select", config: { options: PRIO } });
const { id: ownerId } = await api(`/api/udb/${dbId}/props`, { name: "Owner", type: "text" });

const ROWS: [string, string, string, string][] = [
  ["Bump version to 0.4.1", "done", "high", "alex"],
  ["Cut GitHub release + tag", "in-progress", "high", "alex"],
  ["Update README screenshots", "in-progress", "med", "alex"],
  ["Test resume on the Mac", "todo", "med", "sam"],
  ["Verify color sync to hub", "done", "low", "sam"],
];
for (const [name, status, prio, owner] of ROWS) {
  await api(`/api/udb/${dbId}/rows`, {
    vals: { [titleId]: name, [statusId]: status, [prioId]: prio, [ownerId]: owner },
  });
}

console.log(`seeded ${base}: ${SESSIONS.length} sessions, 3 projects, 1 page, 1 database`);
