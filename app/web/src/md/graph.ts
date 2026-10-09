// `graph` fences: nodes laid out in ranked columns with curved SVG edges, plus
// optional `step` lines that light up one beat of a lifecycle. Pure — md.tsx
// renders it, this file only parses and computes geometry.
//
//   web[Web app|SPA · REST] -> api[API] : REST + SSE
//   api -> pg[PostgreSQL|queue · events] : NOTIFY
//   step Create: web>api, api>pg
//     Alice submits the task.
//
//     The API inserts it and NOTIFYs a worker.
//     > What the console shows while it happens.

export type GNode = { id: string; title: string; sub?: string };
export type GEdge = { from: string; to: string; label?: string };
export type GStep = {
  title: string;
  nodes: string[];
  edges: string[];
  body?: string; // the beat's prose; paragraphs are separated by a blank line
  note?: string; // `> …` lines — the side panel of the beat card
};
export type Graph = {
  nodes: Map<string, GNode>;
  edges: GEdge[];
  steps: GStep[];
  columns: GNode[][];
};

const EDGE = /^([A-Za-z0-9_.-]+(?:\[[^\]]*\])?)\s*->\s*(.+)$/;
const NODE = /^([A-Za-z0-9_.-]+)(?:\[([^\]]*)\])?\s*(?::\s*(.*))?$/;
const STEP = /^step\s+([^:]+):\s*(.*)$/i;

export function parseGraph(src: string): Graph | null {
  const nodes = new Map<string, GNode>();
  const edges: GEdge[] = [];
  const steps: GStep[] = [];
  // declares or updates a node, and returns its id plus the trailing edge label
  const take = (spec: string): [string, string | undefined] | null => {
    const m = spec.trim().match(NODE);
    if (!m) return null;
    const [, id, label, edgeLabel] = m;
    const [title, sub] = (label ?? "").split("|");
    const prev = nodes.get(id);
    nodes.set(id, {
      id,
      title: title?.trim() || prev?.title || id,
      sub: sub?.trim() || prev?.sub,
    });
    return [id, edgeLabel?.trim() || undefined];
  };
  let beat: GStep | null = null; // the step whose indented prose we are reading
  let para = false; // a blank line inside that prose starts a new paragraph
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("//")) continue;
    if (!line) {
      para = Boolean(beat);
      continue;
    }
    const st = line.match(STEP);
    if (st) {
      const toks = st[2].split(",").map((t) => t.trim()).filter(Boolean);
      beat = {
        title: st[1].trim(),
        nodes: toks.filter((t) => !t.includes(">")),
        edges: toks.filter((t) => t.includes(">")).map((t) =>
          t.replace(/\s*-?>\s*/, ">")
        ),
      };
      steps.push(beat);
      para = false;
      continue;
    }
    // indented lines under a step are its prose — `> …` goes to the side panel
    if (beat && /^\s+\S/.test(raw) && !EDGE.test(line)) {
      if (line.startsWith(">")) {
        const note = line.slice(1).trim();
        beat.note = beat.note ? `${beat.note} ${note}` : note;
      } else {
        beat.body = beat.body
          ? `${beat.body}${para ? "\n\n" : " "}${line}`
          : line;
      }
      para = false;
      continue;
    }
    para = false;
    beat = null;
    const e = line.match(EDGE);
    if (e) {
      const from = take(e[1]), to = take(e[2]);
      if (from && to) edges.push({ from: from[0], to: to[0], label: to[1] });
      continue;
    }
    take(line);
  }
  if (!nodes.size) return null;
  return { nodes, edges, steps, columns: columnsOf(nodes, edges) };
}

// Longest-path layering: a node sits one column right of its furthest source.
// ponytail: passes capped at the node count so a cycle still terminates (it just
// unrolls into columns); swap in a proper SCC condensation if cycles matter.
function columnsOf(nodes: Map<string, GNode>, edges: GEdge[]): GNode[][] {
  const rank = new Map([...nodes.keys()].map((id) => [id, 0]));
  for (let pass = 0; pass < nodes.size; pass++) {
    let moved = false;
    for (const e of edges) {
      const next = (rank.get(e.from) ?? 0) + 1;
      if (rank.has(e.to) && (rank.get(e.to) ?? 0) < next) {
        rank.set(e.to, next);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const cols: (GNode[] | undefined)[] = [];
  for (const n of nodes.values()) {
    const r = rank.get(n.id) ?? 0;
    (cols[r] ??= []).push(n);
  }
  return cols.filter((c): c is GNode[] => !!c);
}

export type Rect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};
export type EdgeGeo = {
  key: string; // unique per edge (repeats allowed in the source)
  id: string; // "from>to", matched against a step
  d: string;
  label?: string;
  lx: number;
  ly: number;
  anchor: "middle" | "start";
};

type Side = "r" | "l" | "b" | "t";
const OPPOSITE: Record<Side, Side> = { r: "l", l: "r", b: "t", t: "b" };

// Bezier between the facing sides of two boxes, in container coordinates.
// Edges sharing a side fan out over it instead of stacking on one point.
export function edgeGeometry(
  box: { left: number; top: number },
  rectOf: (id: string) => Rect | null,
  edges: GEdge[],
): EdgeGeo[] {
  const counts = new Map<string, number>(), used = new Map<string, number>();
  const plan = edges.map((e) => {
    const a = rectOf(e.from), b = rectOf(e.to);
    if (!a || !b) return null;
    const horiz = b.left >= a.right || a.left >= b.right;
    const sa: Side = horiz
      ? (b.left >= a.right ? "r" : "l")
      : (b.top >= a.bottom ? "b" : "t");
    const kf = e.from + sa, kt = e.to + OPPOSITE[sa];
    counts.set(kf, (counts.get(kf) ?? 0) + 1);
    counts.set(kt, (counts.get(kt) ?? 0) + 1);
    return { a, b, horiz, sa, sb: OPPOSITE[sa], kf, kt };
  });
  const port = (r: Rect, side: Side, key: string): [number, number] => {
    const n = (used.get(key) ?? 0) + 1;
    used.set(key, n);
    const f = n / ((counts.get(key) ?? 1) + 1);
    if (side === "r") {
      return [r.right - box.left, r.top - box.top + r.height * f];
    }
    if (side === "l") {
      return [r.left - box.left, r.top - box.top + r.height * f];
    }
    if (side === "b") {
      return [r.left - box.left + r.width * f, r.bottom - box.top];
    }
    return [r.left - box.left + r.width * f, r.top - box.top];
  };
  const out: EdgeGeo[] = [];
  edges.forEach((e, i) => {
    const p = plan[i];
    if (!p) return;
    const [x1, y1] = port(p.a, p.sa, p.kf), [x2, y2] = port(p.b, p.sb, p.kt);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    out.push({
      key: `${e.from}>${e.to}#${i}`,
      id: `${e.from}>${e.to}`,
      d: p.horiz
        ? `M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`
        : `M${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`,
      label: e.label,
      lx: p.horiz ? mx : mx + 7,
      ly: p.horiz ? my - 6 : my + 4,
      anchor: p.horiz ? "middle" : "start",
    });
  });
  return out;
}
