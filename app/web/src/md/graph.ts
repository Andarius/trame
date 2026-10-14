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
//
// Groups, tones and styles (optional):
//
//   style sketch                      // plain (default) | workshop | sketch | neon
//   group ops[saas-ops|platform]#bad: sec, ci
//   ci[CI runners]#warn ..> pg : option B #bad   // ..> is dashed

export type Tone = "bad" | "warn" | "good";
export const GRAPH_STYLES = ["plain", "workshop", "sketch", "neon"] as const;
export type GraphStyle = (typeof GRAPH_STYLES)[number];
export type GNode = { id: string; title: string; sub?: string; tone?: Tone };
export type GEdge = {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
  tone?: Tone;
};
export type GGroup = GNode & { members: string[] };
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
  // the group a column draws, parallel to `columns` (undefined: ungrouped ranks)
  columnGroups: (GGroup | undefined)[];
  groups: GGroup[];
  style: GraphStyle;
  wide: boolean; // a `wide` line: the block spans the page, not the text column
  width?: number; // a `width <px>` line: dragged wider than the text column
};

const EDGE = /^([A-Za-z0-9_.-]+(?:\[[^\]]*\])?(?:#\w+)?)\s*(->|\.\.>)\s*(.+)$/;
const NODE = /^([A-Za-z0-9_.-]+)(?:\[([^\]]*)\])?(?:#(\w+))?\s*(?::\s*(.*))?$/;
const STEP = /^step\s+([^:]+):\s*(.*)$/i;
const GROUP =
  /^group\s+([A-Za-z0-9_.-]+)(?:\[([^\]]*)\])?(?:#(\w+))?\s*:\s*(.*)$/i;
const STYLE = /^style\s+(plain|workshop|sketch|neon)\s*$/i;
const WIDE = /^wide$/i;
const WIDTH = /^width\s+(\d+)$/i;
const TONES = new Set(["bad", "warn", "good"]);
const toneOf = (t?: string): Tone | undefined =>
  t && TONES.has(t.toLowerCase()) ? (t.toLowerCase() as Tone) : undefined;
// a trailing `#bad` on an edge tones it; `#123` stays text
const TAIL_TONE = /\s*#(bad|warn|good)\s*$/i;

export function parseGraph(src: string): Graph | null {
  const nodes = new Map<string, GNode>();
  const edges: GEdge[] = [];
  const steps: GStep[] = [];
  const groups: GGroup[] = [];
  let style: GraphStyle = "plain";
  let wide = false;
  let width: number | undefined;
  // declares or updates a node, and returns its id plus the trailing edge label
  const take = (spec: string): [string, string | undefined] | null => {
    const m = spec.trim().match(NODE);
    if (!m) return null;
    const [, id, label, tone, edgeLabel] = m;
    const [title, sub] = (label ?? "").split("|");
    const prev = nodes.get(id);
    const t = toneOf(tone) ?? prev?.tone;
    nodes.set(id, {
      id,
      title: title?.trim() || prev?.title || id,
      sub: sub?.trim() || prev?.sub,
      ...(t ? { tone: t } : {}),
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
    if (WIDE.test(line)) {
      wide = true;
      continue;
    }
    const wd = line.match(WIDTH);
    if (wd) {
      width = Number(wd[1]);
      continue;
    }
    const sty = line.match(STYLE);
    if (sty) {
      style = sty[1].toLowerCase() as GraphStyle;
      continue;
    }
    const gr = line.match(GROUP);
    if (gr) {
      const [, id, label, tone, list] = gr;
      const [title, sub] = (label ?? "").split("|");
      const t = toneOf(tone);
      groups.push({
        id,
        title: title?.trim() || id,
        sub: sub?.trim() || undefined,
        ...(t ? { tone: t } : {}),
        members: list.split(",").map((x) => x.trim()).filter(Boolean),
      });
      continue;
    }
    const e = line.match(EDGE);
    if (e) {
      const tail = e[3].match(TAIL_TONE);
      const from = take(e[1]),
        to = take(tail ? e[3].slice(0, tail.index) : e[3]);
      if (from && to) {
        const tone = toneOf(tail?.[1]);
        edges.push({
          from: from[0],
          to: to[0],
          label: to[1],
          ...(e[2] === "..>" ? { dashed: true } : {}),
          ...(tone ? { tone } : {}),
        });
      }
      continue;
    }
    take(line);
  }
  // an edge may target a whole group: that id is the group, not a node
  for (const gp of groups) {
    nodes.delete(gp.id);
    for (const m of gp.members) {
      if (!nodes.has(m)) nodes.set(m, { id: m, title: m });
    }
  }
  if (!nodes.size) return null;
  // groups own a column each, in declaration order; the rest keep their ranks after
  const seen = new Set(groups.flatMap((gp) => gp.members));
  const rest = new Map([...nodes].filter(([id]) => !seen.has(id)));
  const ranked = rest.size
    ? columnsOf(rest, edges.filter((e) => rest.has(e.from) && rest.has(e.to)))
    : [];
  return {
    nodes,
    edges,
    steps,
    columns: [
      ...groups.map((gp) => gp.members.map((m) => nodes.get(m)!)),
      ...ranked,
    ],
    columnGroups: [...groups, ...ranked.map(() => undefined)],
    groups,
    style,
    wide,
    ...(width ? { width } : {}),
  };
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
  dashed?: boolean;
  tone?: Tone;
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
      ...(e.dashed ? { dashed: true } : {}),
      ...(e.tone ? { tone: e.tone } : {}),
    });
  });
  return out;
}

// only a known name, so an edge like `style -> x` is never taken for one
const STYLE_LINE = /^[ \t]*style[ \t]+(?:plain|workshop|sketch|neon)[ \t]*(?:\n|$)/im;

// The `style` of a whole ```graph fence block, for the toolbar picker.
export function graphStyleOf(fence: string): GraphStyle {
  const m = fence.match(/^[ \t]*style[ \t]+(\w+)[ \t]*$/im);
  const v = m?.[1].toLowerCase();
  return (GRAPH_STYLES as readonly string[]).includes(v ?? "") ? v as GraphStyle : "plain";
}

// Rewrites (or drops, for plain) the `style` line of a ```graph fence block.
export function setGraphStyle(fence: string, style: GraphStyle): string {
  const bare = fence.replace(STYLE_LINE, "");
  if (style === "plain") return bare;
  return bare.replace(/^(\s*```[^\n]*\n)/, `$1style ${style}\n`);
}

const WIDE_LINE = /^[ \t]*wide[ \t]*(?:\n|$)/im;

// Whether a ```graph fence block has a `wide` line, for the toolbar toggle.
export const graphWideOf = (fence: string): boolean => WIDE_LINE.test(fence);

// Adds or drops the `wide` line of a ```graph fence block.
export function setGraphWide(fence: string, on: boolean): string {
  const bare = fence.replace(WIDE_LINE, "").replace(WIDTH_LINE, "");
  return on ? bare.replace(/^(\s*```[^\n]*\n)/, "$1wide\n") : bare;
}

const WIDTH_LINE = /^[ \t]*width[ \t]+\d+[ \t]*(?:\n|$)/im;

// The dragged width of a ```graph fence block, if any.
export function graphWidthOf(fence: string): number | undefined {
  const m = fence.match(/^[ \t]*width[ \t]+(\d+)[ \t]*$/im);
  return m ? Number(m[1]) : undefined;
}

// Sets (or, with undefined, drops) the `width` line; a width replaces `wide`.
export function setGraphWidth(fence: string, px: number | undefined): string {
  const bare = fence.replace(WIDTH_LINE, "").replace(WIDE_LINE, "");
  return px ? bare.replace(/^(\s*```[^\n]*\n)/, `$1width ${Math.round(px)}\n`) : bare;
}
