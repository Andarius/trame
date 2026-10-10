import { useEffect, useMemo, useRef, useState } from "react";
import { drag } from "d3-drag";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { select } from "d3-selection";
import { zoom, zoomIdentity, zoomTransform, type ZoomTransform } from "d3-zoom";
import type { BoardData } from "../api.ts";
import { matchesSessionFilter, pagesById, StatusDot, statusStyle, timeAgo } from "../ui/ui";
import { buildGraph, type GraphNode } from "./graph-model.ts";

type Node = GraphNode & SimulationNodeDatum;
type Link = SimulationLinkDatum<Node> & { source: Node; target: Node };
type Box = [number, number, number, number];

const RADIUS = { project: 14, repo: 6, card: 3.5 } as const;
const FONT = { project: 13, repo: 11, card: 9.5 } as const;
const RANK = { project: 0, repo: 1, card: 2 } as const;
const CARD_LABELS_AT = 1.5; // zoom level from which card titles compete for space
const LINE = "var(--color-chipline)";
const HOT = "var(--color-copper)";

const fill = (n: GraphNode) =>
  n.kind === "project"
    ? n.color ?? "var(--color-ink-soft)"
    : n.kind === "repo"
    ? "var(--color-chart-7)"
    : statusStyle(n.status).color;
const short = (s: string, max = 34) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const overlaps = (a: Box, b: Box) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
const hitsDot = (b: Box, n: Node) => {
  const dx = n.x! - Math.max(b[0], Math.min(n.x!, b[2])), dy = n.y! - Math.max(b[1], Math.min(n.y!, b[3]));
  return dx * dx + dy * dy < RADIUS[n.kind] ** 2;
};

// positions survive board refreshes, so a new card doesn't reshuffle the whole graph
const placed = new Map<string, { x: number; y: number }>();

const PEEK_W = 320;

export default function Graph(
  { board, storyFilter, noSpecs, openId, onOpen, onOpenFull, onClose }: {
    board: BoardData;
    storyFilter: string[];
    noSpecs: boolean;
    openId: string | null; // the card shown in the drawer
    onOpen: (id: string) => void;
    onOpenFull: (id: string) => void;
    onClose: () => void;
  },
) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [tip, setTip] = useState<{ node: GraphNode; x: number; y: number } | null>(null);
  const [peek, setPeek] = useState<string | null>(null); // repo or project listed in the peek panel
  const open = useRef({ onOpen, onOpenFull, onClose });
  open.current = { onOpen, onOpenFull, onClose };
  const focusRef = useRef<((id: string | null, dx: number) => void) | null>(null);

  const graph = useMemo(() => {
    const byId = pagesById(board.pages);
    const sessions = board.sessions
      .filter((s) => !storyFilter.length || storyFilter.some((f) => matchesSessionFilter(s, f, byId)))
      .filter((s) => !noSpecs || !s.specs_page_id || !byId.has(s.specs_page_id));
    return buildGraph(board, sessions);
  }, [board, storyFilter, noSpecs]);
  // rebuild the simulation only when the shape changes, not on every board poll
  const shape = JSON.stringify([
    graph.nodes.map((n) => [n.id, n.label, n.kind === "card" ? n.status : n.kind === "project" ? n.color : ""]),
    graph.links.map((l) => `${l.source}>${l.target}`),
  ]);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const nodes: Node[] = graph.nodes.map((n) => ({ ...n, ...placed.get(n.id) }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links: Link[] = graph.links.map((l) => ({ source: byId.get(l.source)!, target: byId.get(l.target)! }));
    const fresh = nodes.some((n) => n.x === undefined);
    const near = new Map(nodes.map((n) => [n, new Set([n])]));
    const parent = new Map<Node, Node>();
    for (const l of links) {
      near.get(l.source)!.add(l.target);
      near.get(l.target)!.add(l.source);
      if (l.target.kind === "card") parent.set(l.target, l.source);
    }
    // label priority when space runs out: projects, repos, then the most recently touched cards
    const ranked = [...nodes].sort((a, b) =>
      RANK[a.kind] - RANK[b.kind] ||
      (a.kind === "card" && b.kind === "card" ? b.touched.localeCompare(a.touched) : 0)
    );

    const svg = select(el);
    svg.selectAll("*").remove();
    const world = svg.append("g");
    const link = world.append("g").selectAll("line").data(links).join("line")
      .attr("stroke", LINE)
      .attr("stroke-width", (d) => (d.source.kind === "project" ? 1.3 : 0.8))
      .attr("vector-effect", "non-scaling-stroke");
    const halo = world.append("circle").attr("fill", "none").attr("stroke", HOT).attr("stroke-width", 2)
      .attr("vector-effect", "non-scaling-stroke").attr("pointer-events", "none").attr("opacity", 0);
    const node = world.append("g").selectAll<SVGCircleElement, Node>("circle").data(nodes).join("circle")
      .attr("r", (d) => RADIUS[d.kind])
      .attr("fill", fill)
      .attr("stroke", (d) => (d.kind === "project" && d.icon ? d.color ?? "var(--color-ink-soft)" : "var(--color-canvas)"))
      .attr("stroke-width", (d) => (d.kind === "card" ? 1 : 2))
      .attr("fill-opacity", (d) => (d.kind === "project" && d.icon ? 0.18 : 1))
      .style("cursor", (d) => (d.kind === "card" ? "pointer" : "grab"));
    // project logos sit inside their dot, ringed in the project colour
    const logos = nodes.filter((d): d is Node & { kind: "project"; icon: string } => d.kind === "project" && !!d.icon);
    svg.append("defs").append("clipPath").attr("id", "graph-dot").attr("clipPathUnits", "objectBoundingBox")
      .append("circle").attr("cx", 0.5).attr("cy", 0.5).attr("r", 0.5);
    const logo = world.append("g").attr("pointer-events", "none").selectAll("image")
      .data(logos.filter((d) => /^(https?:|data:)/.test(d.icon))).join("image")
      .attr("href", (d) => d.icon)
      .attr("width", RADIUS.project * 2 - 4)
      .attr("height", RADIUS.project * 2 - 4)
      .attr("preserveAspectRatio", "xMidYMid slice")
      .attr("clip-path", "url(#graph-dot)");
    const glyph = world.append("g").attr("pointer-events", "none").selectAll("text")
      .data(logos.filter((d) => !/^(https?:|data:)/.test(d.icon))).join("text")
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "central")
      .attr("font-size", RADIUS.project)
      .text((d) => d.icon);
    const label = world.append("g").attr("pointer-events", "none").selectAll<SVGTextElement, Node>("text")
      .data(nodes).join("text")
      .attr("font-size", (d) => FONT[d.kind])
      .attr("font-weight", (d) => (d.kind === "project" ? 600 : 400))
      .attr("fill", (d) => (d.kind === "repo" ? "var(--color-chart-7)" : "var(--color-ink-soft)"))
      .attr("paint-order", "stroke")
      .attr("stroke", "var(--color-canvas)")
      .text((d) => (d.kind === "repo" ? `#${d.label}` : d.kind === "card" ? short(d.label, 28) : d.label));
    // text widths at base size; zooming only rescales them
    const textW = new Map<Node, number>();
    label.each(function (d) {
      textW.set(d, this.getComputedTextLength());
    });

    let k = 1;
    let hovered: Node | null = null;
    let selected: Node | null = null;
    let offset = 0;
    // a card lights up with its repo's other cards; a repo or project with everything under it
    const selection = (n: Node) => {
      const set = new Set(near.get(n)!);
      for (const d of near.get(parent.get(n) ?? n)!) set.add(d);
      if (n.kind === "project") for (const d of near.get(n)!) for (const x of near.get(d)!) if (x.kind === "card") set.add(x);
      return set;
    };
    let chosen: Set<Node> | null = null;
    const litSet = () => (hovered ? near.get(hovered)! : chosen);
    const shown = new Map<Node, number>();
    // Places every label (cards on the side facing away from their repo), then keeps a label only
    // when it overlaps no kept label and no dot of its rank or above: busy fans thin out instead of piling up.
    const layoutLabels = () => {
      const f = 1 / Math.sqrt(k); // labels grow slower than the zoom, so zooming in spreads them
      const lit = litSet();
      const kept: Box[] = [];
      const boxes = new Map<Node, { box: Box; x: number; y: number; anchor: string }>();
      for (const d of nodes) {
        const size = FONT[d.kind] * f, w = textW.get(d)! * f, r = RADIUS[d.kind];
        const p = parent.get(d);
        if (d.kind === "card" && p) {
          const right = d.x! >= p.x!;
          const x = right ? d.x! + r + 3 * f : d.x! - r - 3 * f;
          const y = d.y! + size * 0.35;
          boxes.set(d, {
            box: [right ? x : x - w, y - size * 0.8, right ? x + w : x, y + size * 0.2],
            x,
            y,
            anchor: right ? "start" : "end",
          });
        } else {
          const y = d.y! + r + size;
          boxes.set(d, { box: [d.x! - w / 2, y - size * 0.8, d.x! + w / 2, y + size * 0.2], x: d.x!, y, anchor: "middle" });
        }
      }
      shown.clear();
      const order = lit ? [...ranked].sort((a, b) => +lit.has(b) - +lit.has(a)) : ranked;
      for (const d of order) {
        const want = lit
          ? (lit.has(d) ? 1 : d.kind === "card" ? 0 : 0.15)
          : d.kind === "card" && k < CARD_LABELS_AT
          ? 0
          : 1;
        if (!want) continue;
        const { box } = boxes.get(d)!;
        if (kept.some((o) => overlaps(box, o)) || nodes.some((n) => n !== d && RANK[n.kind] <= RANK[d.kind] && hitsDot(box, n))) continue;
        kept.push(box);
        shown.set(d, want);
      }
      label
        .attr("x", (d) => boxes.get(d)!.x)
        .attr("y", (d) => boxes.get(d)!.y)
        .attr("text-anchor", (d) => boxes.get(d)!.anchor)
        .attr("font-size", (d) => FONT[d.kind] * f)
        .attr("stroke-width", 3 * f)
        .attr("opacity", (d) => shown.get(d) ?? 0);
    };
    const paint = () => {
      const lit = litSet();
      const touches = (d: Link) => d.source === hovered || d.target === hovered;
      node.attr("opacity", (d) => (!lit || lit.has(d) ? 1 : 0.15));
      logo.attr("opacity", (d) => (!lit || lit.has(d) ? 1 : 0.15));
      glyph.attr("opacity", (d) => (!lit || lit.has(d) ? 1 : 0.15));
      link
        .attr("stroke", (d) => (hovered && touches(d) ? HOT : LINE))
        .attr("opacity", (d) =>
          hovered ? (touches(d) ? 1 : 0.08) : !lit || (lit.has(d.source) && lit.has(d.target)) ? 1 : 0.08
        );
      halo.attr("opacity", selected ? 1 : 0).attr("r", selected ? RADIUS[selected.kind] + 4 : 0);
      layoutLabels();
    };

    const zoomer = zoom<SVGSVGElement, unknown>().scaleExtent([0.3, 5]).on("zoom", (e: { transform: ZoomTransform }) => {
      world.attr("transform", e.transform.toString());
      k = e.transform.k;
      layoutLabels();
    });
    svg.call(zoomer).on("dblclick.zoom", null);

    const sim = forceSimulation(nodes)
      .force(
        "link",
        forceLink<Node, Link>(links)
          .distance((l) => (l.source.kind === "project" ? (l.target.kind === "repo" ? 90 : 40) : 32))
          .strength((l) => (l.source.kind === "project" && l.target.kind === "repo" ? 0.5 : 0.9)),
      )
      .force("charge", forceManyBody<Node>().strength((d) => (d.kind === "project" ? -420 : d.kind === "repo" ? -140 : -36)))
      .force("x", forceX(0).strength(0.04))
      .force("y", forceY(0).strength(0.06))
      .force("collide", forceCollide<Node>((d) => (d.kind === "project" ? 44 : RADIUS[d.kind] + 3)))
      .stop();
    const draw = () => {
      link.attr("x1", (d) => d.source.x!).attr("y1", (d) => d.source.y!)
        .attr("x2", (d) => d.target.x!).attr("y2", (d) => d.target.y!);
      node.attr("cx", (d) => d.x!).attr("cy", (d) => d.y!);
      logo.attr("x", (d) => d.x! - RADIUS.project + 2).attr("y", (d) => d.y! - RADIUS.project + 2);
      glyph.attr("x", (d) => d.x!).attr("y", (d) => d.y!);
      if (selected) halo.attr("cx", selected.x!).attr("cy", selected.y!);
      layoutLabels();
      for (const n of nodes) placed.set(n.id, { x: n.x!, y: n.y! });
    };
    // settle off-screen first so the graph opens laid out, then frame it
    if (!fresh) sim.alpha(0.15);
    const settle = matchMedia("(prefers-reduced-motion: reduce)").matches ? 300 : fresh ? 160 : 0;
    for (let i = 0; i < settle; i++) sim.tick();
    draw();
    paint();
    if (fresh && nodes.length) {
      const xs = nodes.map((n) => n.x!), ys = nodes.map((n) => n.y!);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      const s = Math.min(1.4, 0.9 * Math.min(width / (x1 - x0 + 80), height / (y1 - y0 + 80)));
      svg.call(zoomer.transform, zoomIdentity.translate(width / 2, height / 2).scale(s).translate(-(x0 + x1) / 2, -(y0 + y1) / 2));
    } else {
      svg.call(zoomer.transform, zoomIdentity.translate(width / 2, height / 2));
    }
    sim.on("tick", draw);
    if (settle < 300) sim.restart();

    node
      .on("mouseenter", (e: MouseEvent, d) => {
        hovered = d;
        paint();
        const box = el.getBoundingClientRect();
        setTip({ node: d, x: e.clientX - box.left, y: e.clientY - box.top });
      })
      .on("mouseleave", () => {
        hovered = null;
        paint();
        setTip(null);
      })
      .on("click", (_e: MouseEvent, d) => (d.kind === "card" ? open.current.onOpen(d.sessionId) : setPeek(d.id)))
      .on("dblclick", (_e: MouseEvent, d) => d.kind === "card" && open.current.onOpenFull(d.sessionId));
    node.call(
      drag<SVGCircleElement, Node>()
        .on("start", (e, d) => {
          if (!e.active) sim.alphaTarget(0.25).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on("drag", (e, d) => {
          d.fx = e.x;
          d.fy = e.y;
        })
        .on("end", (e, d) => {
          if (!e.active) sim.alphaTarget(0);
          d.fx = d.fy = null;
        }),
    );
    svg.on("click", (e: MouseEvent) => {
      if (e.target !== el) return;
      setPeek(null);
      open.current.onClose();
    });

    // glide so the selection sits in the middle of what the drawer and peek panel leave visible
    let glide = 0;
    const flyTo = (n: Node, ms = 500) => {
      cancelAnimationFrame(glide);
      const { width, height } = el.getBoundingClientRect();
      const from = zoomTransform(el);
      const to = { k: Math.max(from.k, n.kind === "card" ? 1.6 : 1.2), x: 0, y: 0 };
      to.x = width / 2 + offset - n.x! * to.k;
      to.y = height / 2 - n.y! * to.k;
      const start = performance.now();
      const step = (now: number) => {
        const t = matchMedia("(prefers-reduced-motion: reduce)").matches ? 1 : Math.min(1, (now - start) / ms);
        const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
        const lerp = (a: number, b: number) => a + (b - a) * e;
        svg.call(zoomer.transform, zoomIdentity.translate(lerp(from.x, to.x), lerp(from.y, to.y)).scale(lerp(from.k, to.k)));
        if (t < 1) glide = requestAnimationFrame(step);
      };
      glide = requestAnimationFrame(step);
    };
    focusRef.current = (id, dx) => {
      selected = id ? byId.get(id) ?? null : null;
      chosen = selected && selection(selected);
      offset = dx;
      if (selected) halo.attr("cx", selected.x!).attr("cy", selected.y!);
      paint();
      if (selected) flyTo(selected);
    };
    // the drawer opening narrows the graph: keep the selection in view
    let lastW = width;
    const ro = new ResizeObserver(() => {
      const w = el.getBoundingClientRect().width;
      if (w !== lastW && selected) flyTo(selected, 250);
      lastW = w;
    });
    ro.observe(el);
    return () => {
      sim.stop();
      cancelAnimationFrame(glide);
      ro.disconnect();
      focusRef.current = null;
      setTip(null);
    };
  }, [shape]); // `shape` stands in for `graph`

  const focus = openId ? `card:${openId}` : peek;
  useEffect(() => focusRef.current?.(focus, peek ? -PEEK_W / 2 : 0), [focus, peek, shape]);
  useEffect(() => {
    if (!peek || openId) return; // the drawer handles its own Escape first
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPeek(null);
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [peek, openId]);

  const peeked = peek ? graph.nodes.find((x) => x.id === peek) : undefined;
  const below = (id: string): GraphNode[] =>
    graph.links.filter((l) => l.source === id).flatMap((l) => {
      const t = graph.nodes.find((x) => x.id === l.target)!;
      return t.kind === "card" ? [t] : below(t.id);
    });
  const peekCards = peeked
    ? below(peeked.id).flatMap((c) => (c.kind === "card" ? [c] : [])).sort((a, b) => b.touched.localeCompare(a.touched))
    : [];
  const peekProjects = peeked?.kind === "repo"
    ? graph.links.filter((l) => l.target === peeked.id).map((l) => graph.nodes.find((x) => x.id === l.source)!.label)
    : [];

  const n = tip?.node;
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-canvas">
      <svg ref={svgRef} className="block h-full w-full touch-none" role="img" aria-label="Graph of projects, repos and open cards" />
      {!graph.nodes.length && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-ink-muted">
          No open cards match these filters.
        </div>
      )}
      {!peeked && (
        <div className="pointer-events-none absolute bottom-3 left-4 flex gap-4 text-[11px] text-ink-muted">
          <span>Projects link to their repos, cards hang off their repo.</span>
          <span>Scroll to zoom, drag to move. Click a card to open it, a repo or project to list its cards.</span>
        </div>
      )}
      {peeked && peeked.kind !== "card" && (
        <aside
          className="absolute bottom-0 right-0 top-0 flex flex-col gap-3 overflow-y-auto border-l border-line bg-sidebar px-4 py-4 shadow-[-16px_0_40px_rgba(0,0,0,0.35)]"
          style={{ width: PEEK_W }}
          aria-label={`Cards in ${peeked.label}`}
        >
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className={`truncate text-[15px] font-semibold ${peeked.kind === "repo" ? "text-chart-7" : "text-ink"}`}>
                {peeked.kind === "repo" ? `#${peeked.label}` : peeked.label}
              </div>
              <div className="text-xs text-ink-muted">
                {peekCards.length} open card{peekCards.length === 1 ? "" : "s"}
                {peekProjects.length > 0 && ` · in ${peekProjects.join(", ")}`}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setPeek(null)}
              aria-label="Close"
              className="rounded-md px-1.5 text-base leading-none text-ink-muted hover:bg-hover hover:text-ink"
            >
              ×
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {board.statuses.filter((st) => !st.terminal).map((st) => {
              const count = peekCards.filter((c) => c.kind === "card" && c.status === st.key).length;
              return count > 0 && (
                <span key={st.key} className="flex items-center gap-1.5 rounded-full border border-chipline px-2 py-px text-[11px] text-ink-soft">
                  <StatusDot status={st.key} size={7} />
                  {count} {st.label.toLowerCase()}
                </span>
              );
            })}
          </div>
          <div className="flex flex-col">
            {peekCards.map((c) =>
              c.kind === "card" && (
                <button
                  type="button"
                  key={c.id}
                  onClick={() => onOpen(c.sessionId)}
                  onDoubleClick={() => onOpenFull(c.sessionId)}
                  className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] ${
                    c.sessionId === openId ? "bg-active-row text-ink" : "text-ink-soft hover:bg-hover hover:text-ink"
                  }`}
                >
                  <StatusDot status={c.status} size={7} />
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  <span className="shrink-0 text-[11px] text-ink-faint">{timeAgo(c.touched)}</span>
                </button>
              )
            )}
          </div>
        </aside>
      )}
      {n && (
        <div
          className="pointer-events-none absolute z-10 max-w-[280px] rounded-md border border-overlay-border bg-panel-modal px-2.5 py-1.5 text-xs text-ink shadow-lg"
          style={{ left: tip.x + 14, top: tip.y + 14 }}
        >
          <div className="font-medium">{n.kind === "repo" ? `#${n.label}` : n.label}</div>
          <div className="text-ink-muted">
            {n.kind === "card"
              ? `${statusStyle(n.status).label} · ${timeAgo(n.touched)}`
              : `${n.cards} open card${n.cards === 1 ? "" : "s"}`}
          </div>
        </div>
      )}
    </div>
  );
}
