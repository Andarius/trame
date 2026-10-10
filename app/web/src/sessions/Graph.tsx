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
import { zoom, zoomIdentity, type ZoomTransform } from "d3-zoom";
import type { BoardData } from "../api.ts";
import {
  matchesSessionFilter,
  pagesById,
  statusStyle,
  timeAgo,
} from "../ui/ui";
import { buildGraph, type GraphNode } from "./graph-model.ts";

type Node = GraphNode & SimulationNodeDatum;
type Link = SimulationLinkDatum<Node> & { source: Node; target: Node };

const RADIUS = { project: 12, repo: 6, card: 3.5 } as const;
const CARD_LABELS_AT = 2.2; // zoom level from which every card shows its title
const FONT = { project: 13, repo: 11, card: 9.5 } as const;
const LINE = "var(--color-chipline)";
const HOT = "var(--color-copper)";

const fill = (n: GraphNode) =>
  n.kind === "project"
    ? n.color ?? "var(--color-ink-soft)"
    : n.kind === "repo"
    ? "var(--color-chart-7)"
    : statusStyle(n.status).color;
const short = (
  s: string,
  max = 34,
) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// positions survive board refreshes, so a new card doesn't reshuffle the whole graph
const placed = new Map<string, { x: number; y: number }>();

export default function Graph(
  { board, storyFilter, noSpecs, onOpen, onOpenFull }: {
    board: BoardData;
    storyFilter: string[];
    noSpecs: boolean;
    onOpen: (id: string) => void;
    onOpenFull: (id: string) => void;
  },
) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [tip, setTip] = useState<
    { node: GraphNode; x: number; y: number } | null
  >(null);
  const open = useRef({ onOpen, onOpenFull });
  open.current = { onOpen, onOpenFull };

  const graph = useMemo(() => {
    const byId = pagesById(board.pages);
    const sessions = board.sessions
      .filter((s) =>
        !storyFilter.length ||
        storyFilter.some((f) => matchesSessionFilter(s, f, byId))
      )
      .filter((s) =>
        !noSpecs || !s.specs_page_id || !byId.has(s.specs_page_id)
      );
    return buildGraph(board, sessions);
  }, [board, storyFilter, noSpecs]);
  // rebuild the simulation only when the shape changes, not on every board poll
  const shape = JSON.stringify([
    graph.nodes.map((
      n,
    ) => [
      n.id,
      n.label,
      n.kind === "card" ? n.status : n.kind === "project" ? n.color : "",
    ]),
    graph.links.map((l) => `${l.source}>${l.target}`),
  ]);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const nodes: Node[] = graph.nodes.map((n) => ({
      ...n,
      ...placed.get(n.id),
    }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links: Link[] = graph.links.map((l) => ({
      source: byId.get(l.source)!,
      target: byId.get(l.target)!,
    }));
    const fresh = nodes.some((n) => n.x === undefined);
    const near = new Map(nodes.map((n) => [n, new Set([n])]));
    for (const l of links) {
      near.get(l.source)!.add(l.target);
      near.get(l.target)!.add(l.source);
    }

    const svg = select(el);
    svg.selectAll("*").remove();
    const world = svg.append("g");
    const link = world.append("g").selectAll("line").data(links).join("line")
      .attr("stroke", LINE)
      .attr("stroke-width", (d) => (d.source.kind === "project" ? 1.3 : 0.8))
      .attr("vector-effect", "non-scaling-stroke");
    const node = world.append("g").selectAll<SVGCircleElement, Node>("circle")
      .data(nodes).join("circle")
      .attr("r", (d) => RADIUS[d.kind])
      .attr("fill", fill)
      .attr("stroke", "var(--color-canvas)")
      .attr("stroke-width", (d) => (d.kind === "card" ? 1 : 2))
      .style("cursor", (d) => (d.kind === "card" ? "pointer" : "grab"));
    const label = world.append("g").attr("pointer-events", "none").selectAll(
      "text",
    ).data(nodes).join("text")
      .attr("text-anchor", "middle")
      .attr("font-weight", (d) => (d.kind === "project" ? 600 : 400))
      .attr(
        "fill",
        (
          d,
        ) => (d.kind === "repo"
          ? "var(--color-chart-7)"
          : "var(--color-ink-soft)"),
      )
      .attr("paint-order", "stroke")
      .attr("stroke", "var(--color-canvas)")
      .attr("stroke-width", 3)
      .text((
        d,
      ) => (d.kind === "repo"
        ? `#${d.label}`
        : d.kind === "card"
        ? short(d.label, 28)
        : d.label)
      );

    let k = 1;
    let hovered: Node | null = null;
    // labels grow slower than the zoom, so zooming in spreads them apart
    const resize = () => {
      const f = 1 / Math.sqrt(k);
      label.attr("font-size", (d) => FONT[d.kind] * f).attr(
        "dy",
        (d) => RADIUS[d.kind] + FONT[d.kind] * f,
      )
        .attr("stroke-width", 3 * f);
    };
    const paint = () => {
      const lit = hovered ? near.get(hovered)! : null;
      node.attr("opacity", (d) => (!lit || lit.has(d) ? 1 : 0.15));
      link
        .attr(
          "stroke",
          (
            d,
          ) => (hovered && (d.source === hovered || d.target === hovered)
            ? HOT
            : LINE),
        )
        .attr(
          "opacity",
          (
            d,
          ) => (!hovered || d.source === hovered || d.target === hovered
            ? 1
            : 0.08),
        );
      label.attr(
        "opacity",
        (d) =>
          lit
            ? (lit.has(d) ? 1 : d.kind === "card" ? 0 : 0.15)
            : d.kind === "card" && k < CARD_LABELS_AT
            ? 0
            : 1,
      );
    };

    const zoomer = zoom<SVGSVGElement, unknown>().scaleExtent([0.3, 5]).on(
      "zoom",
      (e: { transform: ZoomTransform }) => {
        world.attr("transform", e.transform.toString());
        const crossed =
          (e.transform.k >= CARD_LABELS_AT) !== (k >= CARD_LABELS_AT);
        k = e.transform.k;
        resize();
        if (crossed) paint();
      },
    );
    svg.call(zoomer).on("dblclick.zoom", null);

    const sim = forceSimulation(nodes)
      .force(
        "link",
        forceLink<Node, Link>(links)
          .distance((
            l,
          ) => (l.source.kind === "project"
            ? (l.target.kind === "repo" ? 90 : 40)
            : 32)
          )
          .strength((
            l,
          ) => (l.source.kind === "project" && l.target.kind === "repo"
            ? 0.5
            : 0.9)
          ),
      )
      .force(
        "charge",
        forceManyBody<Node>().strength((
          d,
        ) => (d.kind === "project" ? -420 : d.kind === "repo" ? -140 : -36)),
      )
      .force("x", forceX(0).strength(0.04))
      .force("y", forceY(0).strength(0.06))
      .force(
        "collide",
        forceCollide<Node>((
          d,
        ) => (d.kind === "project" ? 44 : RADIUS[d.kind] + 3)),
      )
      .stop();
    const draw = () => {
      link.attr("x1", (d) => d.source.x!).attr("y1", (d) => d.source.y!)
        .attr("x2", (d) => d.target.x!).attr("y2", (d) => d.target.y!);
      node.attr("cx", (d) => d.x!).attr("cy", (d) => d.y!);
      label.attr("x", (d) => d.x!).attr("y", (d) => d.y!);
      for (const n of nodes) placed.set(n.id, { x: n.x!, y: n.y! });
    };
    // settle off-screen first so the graph opens laid out, then frame it
    if (!fresh) sim.alpha(0.15);
    const settle = matchMedia("(prefers-reduced-motion: reduce)").matches
      ? 300
      : fresh
      ? 160
      : 0;
    for (let i = 0; i < settle; i++) sim.tick();
    draw();
    paint();
    if (fresh && nodes.length) {
      const xs = nodes.map((n) => n.x!), ys = nodes.map((n) => n.y!);
      const [x0, x1, y0, y1] = [
        Math.min(...xs),
        Math.max(...xs),
        Math.min(...ys),
        Math.max(...ys),
      ];
      const s = Math.min(
        1.4,
        0.9 * Math.min(width / (x1 - x0 + 80), height / (y1 - y0 + 80)),
      );
      svg.call(
        zoomer.transform,
        zoomIdentity.translate(width / 2, height / 2).scale(s).translate(
          -(x0 + x1) / 2,
          -(y0 + y1) / 2,
        ),
      );
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
      .on(
        "click",
        (_e: MouseEvent, d) =>
          d.kind === "card" && open.current.onOpen(d.sessionId),
      )
      .on(
        "dblclick",
        (_e: MouseEvent, d) =>
          d.kind === "card" && open.current.onOpenFull(d.sessionId),
      );
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
    return () => {
      sim.stop();
      setTip(null);
    };
  }, [shape]); // `shape` stands in for `graph`

  const n = tip?.node;
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-canvas">
      <svg
        ref={svgRef}
        className="block h-full w-full touch-none"
        role="img"
        aria-label="Graph of projects, repos and open cards"
      />
      {!graph.nodes.length && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-ink-muted">
          No open cards match these filters.
        </div>
      )}
      <div className="pointer-events-none absolute bottom-3 left-4 flex gap-4 text-[11px] text-ink-muted">
        <span>Projects link to their repos, cards hang off their repo.</span>
        <span>Scroll to zoom, drag to move, click a card to open it.</span>
      </div>
      {n && (
        <div
          className="pointer-events-none absolute z-10 max-w-[280px] rounded-md border border-overlay-border bg-panel-modal px-2.5 py-1.5 text-xs text-ink shadow-lg"
          style={{ left: tip.x + 14, top: tip.y + 14 }}
        >
          <div className="font-medium">
            {n.kind === "repo" ? `#${n.label}` : n.label}
          </div>
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
