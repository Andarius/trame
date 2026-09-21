import { assertEquals } from "@std/assert";
import { edgeGeometry, parseGraph, type Rect } from "./graph.ts";

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
