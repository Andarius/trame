import { assertEquals } from "@std/assert";
import {
  edgeGeometry,
  graphStyleOf,
  graphWideOf,
  graphWidthOf,
  parseGraph,
  type Rect,
  setGraphStyle,
  setGraphWide,
  setGraphWidth,
} from "./graph.ts";

const SRC = `
web[Web app|SPA · REST + SSE] -> api[API|gravier] : REST + SSE
cli[CLI] -> api : REST
api -> pg[PostgreSQL|queue · events] : NOTIFY
pg -> worker : LISTEN
worker -> llm[Model provider]

step Create: web>api, api>pg
  Alice submits the task.

  \`POST /tasks\` inserts it,
  then NOTIFY wakes a worker.
  > What the console shows.
step Stream: worker->llm, pg
`;

Deno.test("parseGraph: labels, edges, steps and column ranks", () => {
  const g = parseGraph(SRC)!;
  assertEquals(g.nodes.get("web"), {
    id: "web",
    title: "Web app",
    sub: "SPA · REST + SSE",
  });
  assertEquals(g.nodes.get("worker"), {
    id: "worker",
    title: "worker",
    sub: undefined,
  });
  assertEquals(g.edges[0], { from: "web", to: "api", label: "REST + SSE" });
  assertEquals(g.edges[4].label, undefined);
  // longest path: sources | api | pg | worker | llm
  assertEquals(g.columns.map((c) => c.map((n) => n.id)), [
    ["web", "cli"],
    ["api"],
    ["pg"],
    ["worker"],
    ["llm"],
  ]);
  // blank line = paragraph break (beat 1 reads as scenario + detail), `>` = side note
  assertEquals(
    g.steps[0].body,
    "Alice submits the task.\n\n`POST /tasks` inserts it, then NOTIFY wakes a worker.",
  );
  assertEquals(g.steps[0].note, "What the console shows.");
  assertEquals(g.steps[1], {
    title: "Stream",
    nodes: ["pg"],
    edges: ["worker>llm"],
  });
});

Deno.test("parseGraph: nothing to draw", () => {
  assertEquals(parseGraph("  \n// just a comment\n"), null);
});

const rect = (left: number, top: number): Rect => ({
  left,
  top,
  right: left + 100,
  bottom: top + 40,
  width: 100,
  height: 40,
});

Deno.test("edgeGeometry: converging edges fan out over the shared side", () => {
  const boxes: Record<string, Rect> = {
    web: rect(0, 0),
    cli: rect(0, 60),
    api: rect(200, 30),
  };
  const geo = edgeGeometry(
    { left: 0, top: 0 },
    (id) => boxes[id] ?? null,
    [{ from: "web", to: "api", label: "REST" }, { from: "cli", to: "api" }],
  );
  assertEquals(geo.map((e) => e.id), ["web>api", "cli>api"]);
  // both land on api's left side, at 1/3 and 2/3 of its height — not one point
  const y = geo.map((e) => Math.round(Number(e.d.match(/ ([\d.]+)$/)![1])));
  assertEquals(y, [43, 57]);
  assertEquals(geo[0].anchor, "middle");
  assertEquals(geo[1].label, undefined);
});

Deno.test("edgeGeometry: a stacked pair connects bottom to top", () => {
  const boxes: Record<string, Rect> = { a: rect(0, 0), b: rect(0, 100) };
  const [e] = edgeGeometry(
    { left: 0, top: 0 },
    (id) => boxes[id] ?? null,
    [{ from: "a", to: "b", label: "down" }],
  );
  assertEquals(e.d, "M50 40 C 50 70, 50 70, 50 100");
  assertEquals(e.anchor, "start");
});

Deno.test("parseGraph: groups, tones, dashed edges and style", () => {
  const g = parseGraph(`
style neon
group dev[saas-dev|dev · stg]: apps, dumps
group ops[saas-ops]#bad: graf, ci
dumps[real prod dumps]#bad
apps -> graf[Grafana] : metrics + logs
ci[CI runners]#warn ..> pg[pg-ro replica] : option B #bad
dev -> ext : #123
`)!;
  assertEquals(g.style, "neon");
  assertEquals(g.groups.map((gp) => [gp.id, gp.tone, gp.members]), [
    ["dev", undefined, ["apps", "dumps"]],
    ["ops", "bad", ["graf", "ci"]],
  ]);
  // group ids are not nodes; an edge may still target one
  assertEquals(g.nodes.has("dev"), false);
  assertEquals(g.nodes.get("dumps")?.tone, "bad");
  assertEquals(g.nodes.get("ci")?.tone, "warn");
  assertEquals(g.edges[1], {
    from: "ci",
    to: "pg",
    label: "option B",
    dashed: true,
    tone: "bad",
  });
  // `#123` is an issue ref, not a tone
  assertEquals(g.edges[2], { from: "dev", to: "ext", label: "#123" });
  // one column per group, then the ungrouped nodes by rank
  assertEquals(g.columns.map((c) => c.map((n) => n.id)), [
    ["apps", "dumps"],
    ["graf", "ci"],
    ["pg", "ext"],
  ]);
  assertEquals(g.columnGroups.map((gp) => gp?.id), ["dev", "ops", undefined]);
});

for (
  const [name, fence, style, want] of [
    ["adds the line under the fence", "```graph\na -> b\n```", "sketch", "```graph\nstyle sketch\na -> b\n```"],
    ["replaces an existing one", "```graph\na -> b\nstyle neon\n```", "workshop", "```graph\nstyle workshop\na -> b\n```"],
    ["plain drops it", "```graph\nstyle neon\na -> b\n```", "plain", "```graph\na -> b\n```"],
  ] as const
) {
  Deno.test(`setGraphStyle: ${name}`, () => {
    const out = setGraphStyle(fence, style);
    assertEquals(out, want);
    assertEquals(graphStyleOf(out), style);
  });
}

Deno.test("setGraphWide: toggles the line and the parse reads it", () => {
  const fence = "```graph\nstyle neon\na -> b\n```";
  const on = setGraphWide(fence, true);
  assertEquals(on, "```graph\nwide\nstyle neon\na -> b\n```");
  assertEquals(graphWideOf(on), true);
  assertEquals(parseGraph("wide\na -> b")?.wide, true);
  assertEquals(setGraphWide(on, false), fence);
  assertEquals(graphWideOf(fence), false);
});

Deno.test("setGraphWidth: a width replaces wide, wide replaces a width", () => {
  const fence = "```graph\nwide\na -> b\n```";
  const sized = setGraphWidth(fence, 1100.4);
  assertEquals(sized, "```graph\nwidth 1100\na -> b\n```");
  assertEquals([graphWidthOf(sized), graphWideOf(sized)], [1100, false]);
  assertEquals(parseGraph("width 1100\na -> b")?.width, 1100);
  assertEquals(setGraphWide(sized, true), "```graph\nwide\na -> b\n```");
  assertEquals(setGraphWidth(sized, undefined), "```graph\na -> b\n```");
});
