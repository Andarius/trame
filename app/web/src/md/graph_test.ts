import { expect, test } from "bun:test";
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

test("parseGraph: labels, edges, steps and column ranks", () => {
  const g = parseGraph(SRC)!;
  expect(g.nodes.get("web")).toStrictEqual({
    id: "web",
    title: "Web app",
    sub: "SPA · REST + SSE",
  });
  expect(g.nodes.get("worker")).toStrictEqual({
    id: "worker",
    title: "worker",
    sub: undefined,
  });
  expect(g.edges[0]).toStrictEqual({ from: "web", to: "api", label: "REST + SSE" });
  expect(g.edges[4].label).toStrictEqual(undefined);
  // longest path: sources | api | pg | worker | llm
  expect(g.columns.map((c) => c.map((n) => n.id))).toStrictEqual([
    ["web", "cli"],
    ["api"],
    ["pg"],
    ["worker"],
    ["llm"],
  ]);
  // blank line = paragraph break (beat 1 reads as scenario + detail), `>` = side note
  expect(g.steps[0].body).toStrictEqual("Alice submits the task.\n\n`POST /tasks` inserts it, then NOTIFY wakes a worker.");
  expect(g.steps[0].note).toStrictEqual("What the console shows.");
  expect(g.steps[1]).toStrictEqual({
    title: "Stream",
    nodes: ["pg"],
    edges: ["worker>llm"],
  });
});

test("parseGraph: nothing to draw", () => {
  expect(parseGraph("  \n// just a comment\n")).toStrictEqual(null);
});

const rect = (left: number, top: number): Rect => ({
  left,
  top,
  right: left + 100,
  bottom: top + 40,
  width: 100,
  height: 40,
});

test("edgeGeometry: converging edges fan out over the shared side", () => {
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
  expect(geo.map((e) => e.id)).toStrictEqual(["web>api", "cli>api"]);
  // both land on api's left side, at 1/3 and 2/3 of its height — not one point
  const y = geo.map((e) => Math.round(Number(e.d.match(/ ([\d.]+)$/)![1])));
  expect(y).toStrictEqual([43, 57]);
  expect(geo[0].anchor).toStrictEqual("middle");
  expect(geo[1].label).toStrictEqual(undefined);
});

test("edgeGeometry: a stacked pair connects bottom to top", () => {
  const boxes: Record<string, Rect> = { a: rect(0, 0), b: rect(0, 100) };
  const [e] = edgeGeometry(
    { left: 0, top: 0 },
    (id) => boxes[id] ?? null,
    [{ from: "a", to: "b", label: "down" }],
  );
  expect(e.d).toStrictEqual("M50 40 C 50 70, 50 70, 50 100");
  expect(e.anchor).toStrictEqual("start");
});

test("parseGraph: groups, tones, dashed edges and style", () => {
  const g = parseGraph(`
style neon
group dev[saas-dev|dev · stg]: apps, dumps
group ops[saas-ops]#bad: graf, ci
dumps[real prod dumps]#bad
apps -> graf[Grafana] : metrics + logs
ci[CI runners]#warn ..> pg[pg-ro replica] : option B #bad
dev -> ext : #123
`)!;
  expect(g.style).toStrictEqual("neon");
  expect(g.groups.map((gp) => [gp.id, gp.tone, gp.members])).toStrictEqual([
    ["dev", undefined, ["apps", "dumps"]],
    ["ops", "bad", ["graf", "ci"]],
  ]);
  // group ids are not nodes; an edge may still target one
  expect(g.nodes.has("dev")).toStrictEqual(false);
  expect(g.nodes.get("dumps")?.tone).toStrictEqual("bad");
  expect(g.nodes.get("ci")?.tone).toStrictEqual("warn");
  expect(g.edges[1]).toStrictEqual({
    from: "ci",
    to: "pg",
    label: "option B",
    dashed: true,
    tone: "bad",
  });
  // `#123` is an issue ref, not a tone
  expect(g.edges[2]).toStrictEqual({ from: "dev", to: "ext", label: "#123" });
  // one column per group, then the ungrouped nodes by rank
  expect(g.columns.map((c) => c.map((n) => n.id))).toStrictEqual([
    ["apps", "dumps"],
    ["graf", "ci"],
    ["pg", "ext"],
  ]);
  expect(g.columnGroups.map((gp) => gp?.id)).toStrictEqual(["dev", "ops", undefined]);
});

for (
  const [name, fence, style, want] of [
    ["adds the line under the fence", "```graph\na -> b\n```", "sketch", "```graph\nstyle sketch\na -> b\n```"],
    ["replaces an existing one", "```graph\na -> b\nstyle neon\n```", "workshop", "```graph\nstyle workshop\na -> b\n```"],
    ["plain drops it", "```graph\nstyle neon\na -> b\n```", "plain", "```graph\na -> b\n```"],
  ] as const
) {
  test(`setGraphStyle: ${name}`, () => {
    const out = setGraphStyle(fence, style);
    expect(out).toStrictEqual(want);
    expect(graphStyleOf(out)).toStrictEqual(style);
  });
}

test("setGraphWide: toggles the line and the parse reads it", () => {
  const fence = "```graph\nstyle neon\na -> b\n```";
  const on = setGraphWide(fence, true);
  expect(on).toStrictEqual("```graph\nwide\nstyle neon\na -> b\n```");
  expect(graphWideOf(on)).toStrictEqual(true);
  expect(parseGraph("wide\na -> b")?.wide).toStrictEqual(true);
  expect(setGraphWide(on, false)).toStrictEqual(fence);
  expect(graphWideOf(fence)).toStrictEqual(false);
});

test("setGraphWidth: a width replaces wide, wide replaces a width", () => {
  const fence = "```graph\nwide\na -> b\n```";
  const sized = setGraphWidth(fence, 1100.4);
  expect(sized).toStrictEqual("```graph\nwidth 1100\na -> b\n```");
  expect([graphWidthOf(sized), graphWideOf(sized)]).toStrictEqual([1100, false]);
  expect(parseGraph("width 1100\na -> b")?.width).toStrictEqual(1100);
  expect(setGraphWide(sized, true)).toStrictEqual("```graph\nwide\na -> b\n```");
  expect(setGraphWidth(sized, undefined)).toStrictEqual("```graph\na -> b\n```");
});
