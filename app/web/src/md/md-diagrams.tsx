// latin subsets only: the sketch look's handwriting, bundled so it works offline
import "@fontsource/caveat/latin-500.css";
import "@fontsource/caveat/latin-700.css";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CARD_COLORS, parseCards } from "./cards";
import { parseDecision } from "./decision";
import { DuePill } from "../ui/due";
import {
  type EdgeGeo,
  edgeGeometry,
  type GNode,
  type GraphStyle,
  parseGraph,
  type Tone,
} from "./graph";
import { PILL_COLORS, renderInline } from "./md-inline";

// ```mermaid fences render as diagrams. The lib (~1.5 MB) is dynamically imported so
// pages without diagrams never load it. The svg-string injection is the one exception
// to the no-innerHTML rule above — mermaid runs with securityLevel 'strict'.
let mermaidReady: Promise<typeof import("mermaid")["default"]> | null = null;
const getMermaid = () => {
  mermaidReady ??= import("mermaid").then(({ default: m }) => {
    m.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "dark",
      themeVariables: { fontFamily: "inherit", primaryColor: "#c98a63" },
    });
    return m;
  });
  return mermaidReady;
};
let mermaidSeq = 0;

export function MermaidBlock({ text }: { text: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    getMermaid()
      .then((m) => m.render(`mermaid-${mermaidSeq++}`, text))
      .then(({ svg }) => alive && setSvg(svg))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [text]);
  if (failed) { // bad syntax → show the source like any code block
    return (
      <pre className="my-1.5 overflow-x-auto rounded-md bg-panel p-2 font-mono text-[0.92em] leading-relaxed text-ink-soft">
        <code>{text}</code>
      </pre>
    );
  }
  return svg
    ? (
      <div
        className="my-1.5 overflow-x-auto [&_svg]:max-w-full"
        // oxlint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    )
    : (
      <div className="my-1.5">
        <span className="text-[11px] text-ink-muted">rendering diagram…</span>
      </div>
    );
}

// ```graph fences draw an architecture diagram: nodes in ranked columns (or one
// column per `group`), curved edges between them, and `step` lines that light up
// one beat at a time. See graph.ts for the dialect. No dependency, no innerHTML —
// plain SVG elements. `style` picks a look; tones colour nodes, groups and edges.
type Look = {
  frame: string; // the figure's surface
  font?: string;
  scale?: number; // the font's size relative to the page text (Caveat runs small)
  halo: string; // edge-label halo = the surface colour
  node: string;
  nodeTone: Record<Tone, string>;
  group: string;
  groupTone: Record<Tone, string>;
  sub: string;
  edge: string; // text-* class: currentColor of lines, arrows and labels
  edgeTone: Record<Tone, string>;
  width: number;
  rough?: boolean; // hand-drawn borders and lines (SVG turbulence)
  flow?: boolean; // animated dashes along every line
  glow?: boolean;
};
// tones never rely on colour alone
const MARK: Record<Tone, string> = { bad: "✕", warn: "!", good: "✓" };
const LOOKS: Record<GraphStyle, Look> = {
  plain: {
    frame: "border border-line bg-block",
    halo: "var(--color-block)",
    node: "rounded-lg border border-chipline bg-panel text-ink",
    nodeTone: {
      bad: "!border-blocked/70 text-blocked",
      warn: "!border-paused/70",
      good: "!border-active/70 border-dashed text-active",
    },
    group: "rounded-xl border border-line bg-panel/40",
    groupTone: {
      bad: "!border-blocked/60",
      warn: "!border-paused/60",
      good: "!border-active/60",
    },
    sub: "text-ink-muted",
    edge: "text-ink-muted",
    edgeTone: { bad: "text-blocked", warn: "text-paused", good: "text-active" },
    width: 1.6,
  },
  workshop: {
    frame: "border border-[#DDE2DC] bg-[#F2F4F1] text-[#1C2321]",
    halo: "#F2F4F1",
    node: "rounded-lg bg-[#F2F4F1] text-[#1C2321]",
    nodeTone: {
      bad: "!bg-[#F7E3DF] !text-[#B23A2E]",
      warn: "!bg-[#F5EAD3] !text-[#8A5A12]",
      good:
        "!bg-[#DCEAE4] !text-[#2F6F62] outline-[1.5px] outline-dashed outline-[#2F6F62]",
    },
    group: "rounded-xl border-[1.5px] border-[#8D958E] bg-white",
    groupTone: {
      bad: "!border-[#B23A2E]",
      warn: "!border-[#A8701A]",
      good: "!border-[#2F6F62]",
    },
    sub: "text-[#66716A]",
    edge: "text-[#7D857F]",
    edgeTone: {
      bad: "text-[#B23A2E]",
      warn: "text-[#A8701A]",
      good: "text-[#2F6F62]",
    },
    width: 1.8,
  },
  sketch: {
    frame: "bg-[#FBF6EA] text-[#2B2A27]",
    font:
      '"Caveat", "Patrick Hand", "Segoe Print", "Bradley Hand", "Comic Sans MS", cursive',
    halo: "#FBF6EA",
    scale: 1.3,
    node: "rounded-md text-[1.12em] leading-tight border-[#2B2A27]",
    nodeTone: {
      bad: "!text-[#C0392B] !border-[#C0392B] bg-[rgba(192,57,43,.08)]",
      warn: "!text-[#9A6B00] !border-[#C99A2E] bg-[rgba(240,190,60,.16)]",
      good: "!text-[#2E7D5B] !border-[#2E7D5B] !border-dashed",
    },
    group: "rounded-xl border-[#2B2A27]",
    groupTone: {
      bad: "!border-[#C0392B]",
      warn: "!border-[#C99A2E]",
      good: "!border-[#2E7D5B]",
    },
    sub: "opacity-70",
    edge: "text-[#2B2A27]",
    edgeTone: {
      bad: "text-[#C0392B]",
      warn: "text-[#9A6B00]",
      good: "text-[#2E7D5B]",
    },
    width: 2,
    rough: true,
  },
  neon: {
    frame: "bg-[#07090D] text-[#C8F7FF]",
    font: "ui-monospace, SFMono-Regular, Menlo, monospace",
    halo: "#07090D",
    node:
      "rounded border-l-2 border-[#1FE0FF] bg-[rgba(31,224,255,.06)] text-[#C8F7FF]",
    nodeTone: {
      bad: "!border-[#FF3B9A] !text-[#FF8CC4]",
      warn: "!border-[#FFE15A] !text-[#FFF0A0]",
      good: "!border-[#7CFF6B] !text-[#B9FFB0]",
    },
    group:
      "rounded-md border border-[#1FE0FF] shadow-[0_0_22px_rgba(31,224,255,.25),inset_0_0_18px_rgba(31,224,255,.08)]",
    groupTone: {
      bad:
        "!border-[#FF3B9A] !shadow-[0_0_22px_rgba(255,59,154,.35),inset_0_0_18px_rgba(255,59,154,.1)]",
      warn: "!border-[#FFE15A] !shadow-[0_0_22px_rgba(255,225,90,.3)]",
      good: "!border-[#7CFF6B] !shadow-[0_0_22px_rgba(124,255,107,.3)]",
    },
    sub: "opacity-60",
    edge: "text-[#1FE0FF]",
    edgeTone: {
      bad: "text-[#FF3B9A]",
      warn: "text-[#FFE15A]",
      good: "text-[#7CFF6B]",
    },
    width: 1.6,
    flow: true,
    glow: true,
  },
};

export function GraphBlock({ text }: { text: string }) {
  const g = useMemo(() => parseGraph(text), [text]);
  const box = useRef<HTMLDivElement | null>(null);
  const nodeEls = useRef(new Map<string, HTMLElement>());
  const [geo, setGeo] = useState<{ w: number; h: number; edges: EdgeGeo[] }>({
    w: 0,
    h: 0,
    edges: [],
  });
  // a lifecycle with prose opens on its first beat; a bare diagram opens whole
  const [step, setStep] = useState(() => g?.steps.some((x) => x.body) ? 0 : -1);
  const uid = useId().replace(/[^\w-]/g, "");
  useEffect(() => {
    const el = box.current;
    if (!el || !g) return;
    const draw = () => {
      const r = el.getBoundingClientRect();
      if (!r.width) return;
      setGeo({
        w: r.width,
        h: r.height,
        edges: edgeGeometry(
          r,
          (id) => nodeEls.current.get(id)?.getBoundingClientRect() ?? null,
          g.edges,
        ),
      });
    };
    // one observer for the frame and every node: wrapping text moves the ports
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    nodeEls.current.forEach((n) => ro.observe(n));
    document.fonts?.ready.then(draw).catch(() => {});
    return () => ro.disconnect();
  }, [g]);
  if (!g) { // nothing parsed → show the source like any code block
    return (
      <pre className="md-snippet-card my-1.5 overflow-x-auto rounded-md bg-panel p-2 font-mono text-[0.92em] leading-relaxed text-ink-soft">
        <code>{text}</code>
      </pre>
    );
  }
  const look = LOOKS[g.style];
  const beat = step >= 0 ? g.steps[step] : null;
  const litNodes = beat &&
    new Set([...beat.nodes, ...beat.edges.flatMap((k) => k.split(">"))]);
  const litEdges = beat && new Set(beat.edges);
  const paras = beat?.body?.split("\n\n") ?? [];
  const titleOf = (id: string) =>
    g.nodes.get(id)?.title ?? g.groups.find((gp) => gp.id === id)?.title;
  const label = g.edges
    .map((e) =>
      `${titleOf(e.from)} to ${titleOf(e.to)}${e.label ? ` (${e.label})` : ""}`
    )
    .join("; ");
  const ref = (id: string) => (el: HTMLElement | null) => {
    if (el) nodeEls.current.set(id, el);
    else nodeEls.current.delete(id);
  };
  const rough = look.rough ? { filter: `url(#gr-rough-${uid})` } : undefined;
  // sketch borders are drawn on an overlay so the turbulence never touches the text
  const Outline = ({ cls }: { cls: string }) =>
    look.rough
      ? (
        <span
          aria-hidden="true"
          style={rough}
          className={`pointer-events-none absolute inset-0 border-[1.8px] ${cls}`}
        />
      )
      : null;
  const dim = (id: string) => litNodes && !litNodes.has(id) ? "opacity-40" : "";
  const lit = (id: string) => litNodes?.has(id) ? "ring-2 ring-copper/50" : "";
  const nodeBox = (n: GNode, grouped: boolean) => {
    const tone = n.tone ? look.nodeTone[n.tone] : "";
    return (
      <div
        key={n.id}
        ref={ref(n.id)}
        className={`relative transition-opacity ${
          grouped
            ? "px-2.5 py-1.5 text-left"
            : "min-w-[116px] max-w-[200px] px-3 py-1.5 text-center font-medium"
        } text-[0.92em] ${look.node} ${tone} ${lit(n.id)} ${dim(n.id)}`}
      >
        <Outline cls={`rounded-md ${look.node} ${tone}`} />
        {n.tone && <span aria-hidden="true">{MARK[n.tone]}&nbsp;</span>}
        {n.title}
        {n.sub && (
          <span
            className={`mt-0.5 block text-[0.82em] font-normal leading-snug ${look.sub}`}
          >
            {n.sub}
          </span>
        )}
      </div>
    );
  };
  const markerColors: [string, string][] = [
    ["base", look.edge],
    ...(Object.entries(look.edgeTone) as [string, string][]),
    ["lit", "text-copper"],
  ];
  return (
    <figure
      // wider than its row scrolls; a `wide` line breaks the row out instead (editor-row)
      className={`md-snippet-card my-2 rounded-lg px-3 py-2 ${look.frame}`}
      style={look.font
        ? { fontFamily: look.font, fontSize: `${look.scale ?? 1}em` }
        : undefined}
    >
      <div className="overflow-x-auto py-1">
        <div
          ref={box}
          role="img"
          aria-label={label}
          // groups share the row's width (scrolling past their minimum);
          // ungrouped graphs size to content
          className={`relative isolate ${
            g.groups.length
              ? "grid w-full items-start gap-x-[88px] p-1"
              : "flex w-max items-stretch gap-x-20"
          }`}
          style={g.groups.length
            ? {
              gridTemplateColumns: `repeat(${g.columns.length}, minmax(170px, 1fr))`,
              minWidth: g.columns.length * 170 + (g.columns.length - 1) * 88 + 8,
            }
            : undefined}
        >
          {g.columns.map((col, ci) => {
            const gp = g.columnGroups[ci];
            if (!gp) {
              return (
                <div
                  key={ci}
                  className="z-10 flex flex-col justify-center gap-4"
                >
                  {col.map((n) => nodeBox(n, false))}
                </div>
              );
            }
            const tone = gp.tone ? look.groupTone[gp.tone] : "";
            return (
              <div
                key={ci}
                ref={ref(gp.id)}
                className={`relative z-10 flex min-w-0 flex-col gap-2 p-3 transition-opacity ${
                  look.rough ? "" : `${look.group} ${tone}`
                } ${lit(gp.id)} ${dim(gp.id)}`}
              >
                <Outline cls={`${look.group} ${tone}`} />
                <div className="font-semibold leading-tight">
                  {g.style === "neon" && (
                    <span className="text-[#7CFF6B]">$&nbsp;</span>
                  )}
                  {gp.title}
                  {gp.sub && (
                    <span
                      className={`block text-[0.8em] font-normal ${look.sub}`}
                    >
                      {gp.sub}
                    </span>
                  )}
                </div>
                {col.map((n) => nodeBox(n, true))}
              </div>
            );
          })}
          <svg
            // above the group cards, or their surface hides the arrowheads in the padding
            className="pointer-events-none absolute inset-0 z-20 h-full w-full overflow-visible"
            viewBox={`0 0 ${geo.w} ${geo.h}`}
            aria-hidden="true"
          >
            <defs>
              {look.rough && (
                <filter
                  // box outlines: relative to each element
                  id={`gr-rough-${uid}`}
                >
                  <feTurbulence
                    type="fractalNoise"
                    baseFrequency="0.035"
                    numOctaves={2}
                    seed={4}
                    result="n"
                  />
                  <feDisplacementMap in="SourceGraphic" in2="n" scale={3.2} />
                </filter>
              )}
              {look.rough && (
                <filter
                  id={`gr-rough-line-${uid}`}
                  // the whole drawing, not the path's box: a straight line has zero height
                  filterUnits="userSpaceOnUse"
                  x="0"
                  y="0"
                  width="100%"
                  height="100%"
                >
                  <feTurbulence
                    type="fractalNoise"
                    baseFrequency="0.035"
                    numOctaves={2}
                    seed={4}
                    result="n"
                  />
                  <feDisplacementMap in="SourceGraphic" in2="n" scale={3.2} />
                </filter>
              )}
              {look.glow && (
                <filter
                  id={`gr-glow-${uid}`}
                  filterUnits="userSpaceOnUse"
                  x="0"
                  y="0"
                  width="100%"
                  height="100%"
                >
                  <feGaussianBlur stdDeviation={2.4} result="b" />
                  <feMerge>
                    <feMergeNode in="b" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              )}
            </defs>
            {/* a marker takes currentColor from where it is declared, so one per colour */}
            {markerColors.map(([k, cls]) => (
              <g key={k} className={cls}>
                <marker
                  id={`gr-${uid}-${k}`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto"
                >
                  <path d="M0 0L10 5 0 10z" fill="currentColor" />
                </marker>
              </g>
            ))}
            {geo.edges.map((e) => {
              const on = litEdges?.has(e.id);
              const key = on ? "lit" : e.tone ?? "base";
              const color = on
                ? "text-copper"
                : e.tone
                ? look.edgeTone[e.tone]
                : look.edge;
              return (
                <g
                  key={e.key}
                  className={`${color} ${litEdges && !on ? "opacity-25" : ""}`}
                >
                  <path
                    d={e.d}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={look.width}
                    strokeDasharray={e.dashed || look.flow ? "6 5" : undefined}
                    className={look.flow ? "graph-flow" : undefined}
                    // on the line only: a filtered label would wobble or blur
                    style={look.glow
                      ? { filter: `url(#gr-glow-${uid})` }
                      : look.rough
                      ? { filter: `url(#gr-rough-line-${uid})` }
                      : undefined}
                    markerEnd={`url(#gr-${uid}-${key})`}
                  />
                  {e.label && (
                    <text
                      x={e.lx}
                      y={e.ly}
                      textAnchor={e.anchor}
                      fontSize={11 * (look.scale ?? 1)}
                      // halo: the label sits on top of its own line
                      style={{
                        fill: "currentColor",
                        paintOrder: "stroke",
                        stroke: look.halo,
                        strokeWidth: 4,
                      }}
                    >
                      {e.label}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      </div>
      {g.steps.length > 0 && (
        <ol className="mt-1 flex list-none flex-wrap gap-1.5 p-0">
          {g.steps.map((s, i) => (
            <li key={i}>
              <button
                type="button"
                aria-current={i === step ? "step" : undefined}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation(); // don't select/edit the block behind
                  setStep(i === step ? -1 : i);
                }}
                className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[0.86em] transition-colors ${
                  i === step
                    ? "border-copper bg-copper/10 text-ink"
                    : "border-chipline text-ink-soft hover:text-ink"
                }`}
              >
                <b className="font-mono text-[0.85em] font-bold text-copper">
                  {i + 1}
                </b>
                {s.title}
              </button>
            </li>
          ))}
        </ol>
      )}
      {beat && (beat.body || beat.note) && (
        <div className="mt-2 grid gap-5 rounded-xl border border-line bg-panel p-4 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div className="min-w-0">
            <h3 className="text-[1.08em] font-semibold leading-snug text-ink">
              {beat.title}
            </h3>
            {/* first paragraph = the scenario line, the rest is the detail */}
            {paras.map((t, j) => (
              <p
                key={j}
                className={j === 0 && paras.length > 1
                  ? "mt-1 text-[0.9em] text-ink-muted"
                  : "mt-2 text-[0.95em] leading-relaxed text-ink-soft"}
              >
                {renderInline(t)}
              </p>
            ))}
            <div className="mt-3 flex items-center gap-2 text-[0.82em]">
              {[["← Previous", -1], ["Next →", 1]].map(([lbl, d]) => (
                <button
                  key={lbl as string}
                  type="button"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setStep((s) =>
                      (s + (d as number) + g.steps.length) % g.steps.length
                    );
                  }}
                  className="rounded-lg border border-chipline px-2 py-1 text-ink-soft hover:text-ink"
                >
                  {lbl as string}
                </button>
              ))}
              <span className="text-ink-muted">
                Beat {step + 1} of {g.steps.length}
              </span>
            </div>
          </div>
          {beat.note && (
            <div className="border-l-2 border-copper pl-4">
              <p className="text-[0.95em] leading-relaxed text-ink-soft">
                {renderInline(beat.note)}
              </p>
            </div>
          )}
        </div>
      )}
    </figure>
  );
}

// ```cards fences render a KPI row — the palette and the parse live in cards.ts.
export function CardsBlock({ text }: { text: string }) {
  const cards = parseCards(text);
  return (
    <div className="my-2 flex flex-wrap gap-2">
      {cards.map((c, i) => (
        <div
          key={i}
          className={`min-w-[140px] flex-1 rounded-lg border px-3.5 py-2.5 ${
            CARD_COLORS[c.color ?? "gray"]
          }`}
        >
          <div className="text-[19px] font-semibold leading-tight">
            {renderInline(c.value)}
          </div>
          {c.label && (
            <div className="mt-1 text-[11.5px] leading-snug text-ink-muted">
              {renderInline(c.label)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// `decision` fence: a question for a human with its options; picking one (or several with
// {{trame:pick=many}}, or a free-text "other") records the answer as marks (decision.ts).
// Read-only without `onPick`.
export function DecisionBlock({ text, onPick }: { text: string; onPick?: (answer: string | string[]) => void }) {
  const d = parseDecision(text);
  const answered = d.answers.length > 0;
  const [picked, setPicked] = useState<string[]>([]);
  const [other, setOther] = useState("");
  // a pick is written through the identity lookup: lock the card meanwhile, or a second
  // click would race the first and replace its answer
  const [pending, setPending] = useState(false);
  const locked = !onPick || answered || pending;
  const known = new Set(d.options.map((o) => o.label));
  const extra = d.answers.filter((a) => !known.has(a)); // a free-text answer shows as its own row
  const commit = (answer: string | string[]) => {
    if (locked) return;
    setPending(true);
    onPick(answer);
    setPicked([]);
    setOther("");
  };
  const stop = (e: { preventDefault(): void; stopPropagation(): void }) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const rowCls = (chosen: boolean) =>
    `flex items-start gap-2 rounded-md border px-2 py-1 text-left text-[0.92em] leading-snug ${
      chosen ? "border-active/50 bg-active/10" : answered ? "border-line-soft text-ink-muted" : "border-line-soft bg-panel hover:border-copper/60"
    } ${locked ? "cursor-default" : "cursor-pointer"} ${pending ? "opacity-60" : ""}`;
  const dot = (chosen: boolean, recommended: boolean) =>
    `mt-[3px] inline-block h-3 w-3 shrink-0 border-2 ${d.multi ? "rounded-sm" : "rounded-full"} ${
      chosen ? "border-active bg-active" : recommended && !answered ? "border-copper bg-copper" : "border-line"
    }`;
  return (
    <div
      className={`my-2 rounded-lg border-l-4 px-3.5 py-2.5 ${
        answered ? "border-active/60 bg-active/[0.06]" : "border-copper bg-copper/[0.08]"
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.95em] font-semibold leading-snug">
        <span>{renderInline(d.question)}</span>
        {answered
          ? (
            <span className={`rounded-full px-1.5 py-px font-mono text-[0.72em] font-normal ${PILL_COLORS.green}`}>
              {d.marks.answered_by ? `${d.marks.answered_by} · ` : ""}{d.marks.completed_at ?? "answered"}
            </span>
          )
          : (
            <span className={`rounded-full px-1.5 py-px font-mono text-[0.72em] font-normal ${PILL_COLORS.copper}`}>
              {d.marks.ask ? `waiting on ${d.marks.ask}` : "waiting"}{d.multi ? " · pick any" : ""}
            </span>
          )}
        {d.marks.due && !answered && <DuePill due={d.marks.due} />}
      </div>
      <div className="mt-1.5 flex flex-col gap-1">
        {d.options.map((o) => {
          const chosen = answered ? d.answers.includes(o.label) : picked.includes(o.label);
          return (
            <button
              key={o.label}
              type="button"
              disabled={locked}
              className={rowCls(chosen)}
              onMouseDown={stop}
              onClick={(e) => {
                e.stopPropagation();
                if (locked) return;
                if (d.multi) setPicked((p) => (p.includes(o.label) ? p.filter((x) => x !== o.label) : [...p, o.label]));
                else commit(o.label);
              }}
            >
              <span className={dot(chosen, o.recommended)} />
              <span>
                {renderInline(o.label)}
                {o.recommended && !answered && (
                  <span className="ml-1.5 font-mono text-[0.72em] text-copper">recommended</span>
                )}
              </span>
            </button>
          );
        })}
        {extra.map((a) => (
          <div key={a} className={rowCls(true)}>
            <span className={dot(true, false)} />
            <span>{renderInline(a)}</span>
          </div>
        ))}
        {!locked && (
          <form
            className="flex items-center gap-2"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              const text = other.trim();
              if (d.multi) commit(text ? [...picked, text] : picked);
              else if (text) commit(text);
            }}
          >
            <input
              value={other}
              onChange={(e) => setOther(e.target.value)}
              placeholder="Other…"
              aria-label="Other answer"
              className="min-w-0 flex-1 rounded-md border border-line-soft bg-panel px-2 py-1 text-[0.92em] outline-none placeholder:text-ink-muted/60 focus:border-copper/60"
            />
            <button
              type="submit"
              disabled={d.multi ? !picked.length && !other.trim() : !other.trim()}
              className="rounded-md border border-copper/60 bg-copper/10 px-2.5 py-1 font-mono text-[0.78em] text-copper disabled:opacity-40"
            >
              Answer
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
