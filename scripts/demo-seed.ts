// DESCRIPTION: seed a Trame instance with the synthetic demo dataset used for the README
// screenshots (docs/*.png) and the in-app demo workspace. Fictional projects only — never
// point this at a real instance. With DEMO_RECORD set, also write the calls as a demo bundle
// the app replays (UUIDs keyed by JSON pointer, dates shifted from recorded_on).
// USAGE: TRAME_URL=http://127.0.0.1:8799 [DEMO_RECORD=demo.json] bun scripts/demo-seed.ts
// EXAMPLES: just demo   (spins up an isolated instance, seeds it, and serves it)
//           just demo-bundle   (records .scratch/demo-bundle/demo.json)
import { mkdir, writeFile } from "node:fs/promises";
const base = process.env.TRAME_URL ?? "http://127.0.0.1:8799";
const record = process.env.DEMO_RECORD;
// bump with the app's DEMO_FORMAT when the bundle shape or a replayed route changes
const DEMO_FORMAT = 1;

type Op = { method: "GET" | "POST"; path: string; body?: unknown; ids: Record<string, string> };
const ops: Op[] = [];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuids = (value: unknown, pointer = "", out: Record<string, string> = {}) => {
  if (typeof value === "string" && UUID.test(value)) out[pointer] = value;
  else if (Array.isArray(value)) value.forEach((v, i) => uuids(v, `${pointer}/${i}`, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) uuids(v, `${pointer}/${k.replaceAll("~", "~0").replaceAll("/", "~1")}`, out);
  }
  return out;
};

const api = async (path: string, body?: unknown) => {
  const method = body === undefined ? "GET" : "POST";
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  const json = await res.json();
  if (record) ops.push({ method, path, body, ids: uuids(json) });
  return json;
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

const svg = (body: string) => `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body}</svg>`)}`;
const PROJECT_LOGO: Record<string, string> = {
  "Acme Web": svg('<rect width="24" height="24" rx="6" fill="#7a9ee7"/><path d="M7 17 12 6l5 11M9.2 13h5.6" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'),
  "Marketing Site": svg('<rect width="24" height="24" rx="12" fill="#e3c567"/><circle cx="12" cy="12" r="4" fill="#fff"/><path d="M12 3.5v2.5M12 18v2.5M3.5 12H6M18 12h2.5M6 6l1.8 1.8M16.2 16.2 18 18M6 18l1.8-1.8M16.2 7.8 18 6" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>'),
  "Mobile App": svg('<rect width="24" height="24" rx="6" fill="#7bd88f"/><rect x="8" y="4.5" width="8" height="15" rx="2" fill="none" stroke="#fff" stroke-width="2"/><circle cx="12" cy="16.5" r="1" fill="#fff"/>'),
};
// lucide-style column glyphs, muted so they read in both themes
const glyph = (body: string) => svg(`<g fill="none" stroke="#8b93a3" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</g>`);
const ICON = {
  target: glyph('<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>'),
  check: glyph('<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'),
  timer: glyph('<path d="M10 2h4M12 14l3-3"/><circle cx="12" cy="14" r="8"/>'),
  hash: glyph('<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>'),
  money: glyph('<rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/>'),
  bot: glyph('<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/>'),
  layers: glyph('<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>'),
  pulse: glyph('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'),
  calendar: glyph('<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'),
};
const avatar = (color: string, letter: string) =>
  svg(`<rect width="24" height="24" rx="6" fill="${color}"/><text x="12" y="16.5" font-family="sans-serif" font-size="12" font-weight="700" text-anchor="middle" fill="#fff">${letter}</text>`);

const board0 = await api("/api/board");
if (board0.sessions.length) {
  console.error("instance already has sessions — refusing to seed over it");
  process.exit(1);
}

// With DEMO_CLAUDE_DIR set (and the app's TRACKER_CLAUDE_DIR pointing at it), plant a
// transcript so the Checkout card is genuinely resumable — the drawer screenshot would
// otherwise read "No transcript on this device". The app only checks the file exists.
const AGENT_ID = "9f1c7c8e-3b2a-4d5e-8a1f-2c6b0d4e7a13";
const claudeDir = process.env.DEMO_CLAUDE_DIR;
if (claudeDir) {
  const dir = `${claudeDir}/-Users-demo-code-acme-web`;
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/${AGENT_ID}.jsonl`, JSON.stringify({ type: "user", cwd: "/Users/demo/code/acme-web" }) + "\n");
}

const sessionIds: Record<string, string> = {};
for (const [title, client, story, status, branch, next_step] of SESSIONS) {
  const checkout = title.includes("Checkout redesign");
  const created = await api("/api/sessions", {
    title,
    client,
    story,
    status,
    branch,
    next_step,
    repo_path: `/Users/demo/code/${client.toLowerCase().replace(/ /g, "-")}`,
    pr_url: checkout ? "https://github.com/acme/web/pull/128" : undefined,
    agent_id: checkout && claudeDir ? AGENT_ID : undefined,
    no_event: true,
  });
  sessionIds[title] = created.id ?? created;
}

// project chips are colored per client
const pages = await api("/api/pages") as { id: string; title: string; kind: string }[];
for (const p of pages.filter((x) => x.kind === "project" && PROJECT_COLOR[x.title])) {
  await api(`/api/pages/${p.id}`, { color: PROJECT_COLOR[p.title], icon: PROJECT_LOGO[p.title] });
}

// due-dated todos on card specs, relative to today so the demo never looks stale
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const DUE: [string, [string, number, boolean?][]][] = [
  ["web — Checkout redesign", [["Wire up the Stripe payment intent", 2], ["Handle 3-D Secure redirect", 5], ["Design review with Sam", -3, true]]],
  ["web — Fix cart race condition", [["Reproduce with two tabs open", -1]]],
  ["site — Launch landing page", [["Finalize hero copy", 0], ["Ship OG image", 3]]],
  ["mobile — Push notifications", [["APNs key rotation", 8]]],
];
for (const [title, todos] of DUE) {
  const { page_id } = await api(`/api/sessions/${sessionIds[title]}/specs-page`, {});
  await api(`/api/pages/${page_id}`, {
    content: todos.map(([text, offset, done], i) => ({
      type: "todo",
      text: `${text} {{trame:due=${day(offset)}}}`,
      done: !!done,
      id: `d${i}`,
    })),
  });
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

// eval runs ↔ models, shaped like a real benchmark tracker: rings, rollups, charts
const { id: evalsPage } = await api("/api/pages", { title: "Agent evals", kind: "page", icon: ICON.target });
await api(`/api/pages/${evalsPage}`, {
  content: [
    { type: "text", text: "Nightly eval runs of the checkout and support agents. Charts are live views over the database below.", id: "e1" },
  ],
});

const { id: modelsDb } = await api("/api/udb", { name: "Models" });
await api(`/api/udb/${modelsDb}`, { icon: ICON.bot });
const modelsTitle = ((await api(`/api/udb/${modelsDb}`)).properties as { id: string; type: string }[]).find((p) => p.type === "title")!.id;
const mprop = async (name: string, type: string, config: Record<string, unknown>) =>
  (await api(`/api/udb/${modelsDb}/props`, { name, type, config })).id as string;
const mIn = await mprop("Input $/1M", "number", { format: "dollar", precision: 2, icon: ICON.money });
const mOut = await mprop("Output $/1M", "number", { format: "dollar", precision: 2, icon: ICON.money });
const mCtx = await mprop("Context", "number", { unit: "k", precision: 0, icon: ICON.layers });
const MODELS: [string, string, number, number, number][] = [
  ["Atlas Large", "#b590e7", 3, 15, 200],
  ["Atlas Small", "#7a9ee7", 0.8, 4, 200],
  ["Nimbus Pro", "#c98a63", 1.25, 10, 1000],
  ["Nimbus Flash", "#e3c567", 0.15, 0.6, 1000],
  ["Kestrel 8B", "#7bd88f", 0.05, 0.08, 128],
];
const modelIds: Record<string, string> = {};
for (const [name, color, input, output, ctx] of MODELS) {
  modelIds[name] = (await api(`/api/udb/${modelsDb}/rows`, {
    icon: avatar(color, name[0]),
    vals: { [modelsTitle]: name, [mIn]: input, [mOut]: output, [mCtx]: ctx },
  })).id;
}

const { id: runsDb } = await api("/api/udb", { name: "Eval runs" });
await api(`/api/udb/${runsDb}`, { icon: ICON.pulse, page_id: evalsPage });
const runsTitle = ((await api(`/api/udb/${runsDb}`)).properties as { id: string; type: string }[]).find((p) => p.type === "title")!.id;
const rprop = async (name: string, type: string, config: Record<string, unknown>) =>
  (await api(`/api/udb/${runsDb}/props`, { name, type, config })).id as string;
const SUITES = [opt("Checkout", "#7a9ee7"), opt("Search", "#b590e7"), opt("Support", "#c98a63")];
const OUTCOMES = [opt("Passed", "#7bd88f"), opt("Flaky", "#e3c567"), opt("Regressed", "#e06c75")];
const rScore = await rprop("Score", "number", { max: 10, precision: 1, show_as: "ring", show_value: true, color: "#7bd88f", icon: ICON.target });
const rPass = await rprop("Pass rate", "number", {
  format: "percent", max: 100, precision: 0, show_as: "ring", show_value: true, icon: ICON.check,
  color_mode: "rules", rules: [{ lt: 70, color: "#e06c75" }, { lt: 90, color: "#e3c567" }, { color: "#7bd88f" }],
});
const rLatency = await rprop("Latency", "number", { unit: "s", precision: 1, color_mode: "scale", good: "low", color_apply: "text", icon: ICON.timer });
const rTokens = await rprop("Tokens / run", "number", { precision: 0, icon: ICON.hash });
const rCost = await rprop("Run cost", "number", { format: "dollar", precision: 4, icon: ICON.money });
const rModel = await rprop("Model", "relation", { target_db: modelsDb, reverse_name: "Runs", icon: ICON.bot });
const rSuite = await rprop("Suite", "select", { options: SUITES, icon: ICON.layers });
const rOutcome = await rprop("Outcome", "select", { options: OUTCOMES, icon: ICON.pulse });
const rDate = await rprop("Date", "date", { icon: ICON.calendar });
await rprop("Input $/1M", "rollup", { relation_prop: rModel, agg: "avg", target_prop: mIn, format: "dollar", precision: 2, icon: ICON.money });

const modelsRunsProp = ((await api(`/api/udb/${modelsDb}`)).properties as { id: string; name: string }[]).find((p) => p.name === "Runs")!.id;
await mprop("# Runs", "rollup", { relation_prop: modelsRunsProp, agg: "count", icon: ICON.hash });
await mprop("Avg score", "rollup", { relation_prop: modelsRunsProp, agg: "avg", target_prop: rScore, max: 10, precision: 1, show_as: "ring", show_value: true, color: "#7bd88f", icon: ICON.target });
const mSpend = await mprop("Total spend", "rollup", { relation_prop: modelsRunsProp, agg: "sum", target_prop: rCost, format: "dollar", precision: 3, icon: ICON.money });

// deterministic pseudo-random so screenshots are stable run to run
let seed = 7;
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const QUALITY: Record<string, number> = { "Atlas Large": 8.9, "Atlas Small": 7.6, "Nimbus Pro": 8.4, "Nimbus Flash": 7.1, "Kestrel 8B": 5.9 };
const SPEED: Record<string, number> = { "Atlas Large": 6.5, "Atlas Small": 2.8, "Nimbus Pro": 4.9, "Nimbus Flash": 1.4, "Kestrel 8B": 0.9 };
let runN = 0;
for (let offset = -20; offset <= 0; offset += 2) {
  for (const [model, , input, output] of MODELS) {
    if (rand() < 0.35) continue;
    const suite = SUITES[Math.floor(rand() * SUITES.length)];
    const score = Math.min(10, Math.max(3, QUALITY[model] + (offset + 20) * 0.03 + (rand() - 0.5) * 1.6));
    const pass = Math.round(Math.min(100, score * 10 + (rand() - 0.5) * 12));
    const tokens = Math.round(3000 + rand() * 9000);
    const outcome = pass >= 90 ? "passed" : pass >= 70 ? "flaky" : "regressed";
    const { id: run } = await api(`/api/udb/${runsDb}/rows`, {
      vals: {
        [runsTitle]: `#${String(++runN).padStart(3, "0")} · ${suite.name.toLowerCase()} · ${model}`,
        [rScore]: Math.round(score * 10) / 10,
        [rPass]: pass,
        [rLatency]: Math.round(SPEED[model] * (0.8 + rand() * 0.5) * 10) / 10,
        [rTokens]: tokens,
        [rCost]: Math.round(((tokens * 0.8 * input + tokens * 0.2 * output) / 1e6) * 1e4) / 1e4,
        [rSuite]: suite.id,
        [rOutcome]: outcome,
        [rDate]: { start: day(offset) },
      },
    });
    await api("/api/udb/links", { prop_id: rModel, from_row: run, to_row: modelIds[model] });
  }
}

const tab = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, config: { sorts: [], filters: [], ...extra } });
await api(`/api/udb/${runsDb}`, {
  views: {
    active: "trend",
    tabs: [
      tab("table", "All runs", { sorts: [{ propId: rDate, dir: -1 }] }),
      tab("trend", "Score trend", { chart: { kind: "line", x: rDate, series: [{ propId: rScore, agg: "avg" }] } }),
      tab("models", "By model", { chart: { kind: "bar", x: rModel, labels: true, series: [{ propId: rScore, agg: "avg" }, { propId: rLatency, agg: "avg", color: "#c98a63" }] } }),
      tab("outcomes", "Outcomes", { chart: { kind: "pie", donut: true, labels: true, x: rOutcome, series: [{ propId: null, agg: "count" }] } }),
      tab("suites", "Per suite", { summary: true, groupBy: rSuite }),
    ],
  },
});
await api(`/api/udb/${modelsDb}`, {
  views: {
    active: "table",
    tabs: [
      tab("table", "Models"),
      tab("spend", "Spend", { chart: { kind: "bar", x: null, labels: true, series: [{ propId: mSpend, agg: "sum" }] } }),
    ],
  },
});

if (record) {
  const recorded_on = new Date().toISOString().slice(0, 10);
  await writeFile(record, JSON.stringify({ format: DEMO_FORMAT, recorded_on, ops }));
  console.log(`recorded ${ops.length} calls → ${record}`);
}

console.log(`seeded ${base}: ${SESSIONS.length} sessions, 3 projects, 2 pages, 3 databases, ${runN} eval runs`);
