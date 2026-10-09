import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CARD_COLORS, parseCards } from "./cards";
import { type EdgeGeo, edgeGeometry, parseGraph } from "./graph";
import { renderInline } from "./md-inline";

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
        // deno-lint-ignore react-no-danger
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    )
    : (
      <div className="my-1.5">
        <span className="text-[11px] text-ink-muted">rendering diagram…</span>
      </div>
    );
}

// ```graph fences draw an architecture diagram: nodes in ranked columns, curved
// edges between them, and `step` lines that light up one beat at a time. See
// graph.ts for the dialect. No dependency, no innerHTML — plain SVG elements.
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
  const beat = step >= 0 ? g.steps[step] : null;
  const litNodes = beat &&
    new Set([...beat.nodes, ...beat.edges.flatMap((k) => k.split(">"))]);
  const litEdges = beat && new Set(beat.edges);
  const paras = beat?.body?.split("\n\n") ?? [];
  const label = g.edges
    .map((e) =>
      `${g.nodes.get(e.from)?.title} to ${g.nodes.get(e.to)?.title}${
        e.label ? ` (${e.label})` : ""
      }`
    )
    .join("; ");
  return (
    <figure
      // wider than the 820px text column → grow into the margins, like a table
      className={`md-snippet-card my-2 rounded-lg border border-line bg-block px-3 py-2 ${
        geo.w > 756
          ? "relative left-1/2 w-[min(1400px,100cqw_-_4rem)] -translate-x-1/2"
          : ""
      }`}
    >
      <div className="overflow-x-auto py-1">
        <div
          ref={box}
          role="img"
          aria-label={label}
          className="relative isolate flex w-max items-stretch gap-x-20"
        >
          {g.columns.map((col, ci) => (
            <div key={ci} className="z-10 flex flex-col justify-center gap-4">
              {col.map((n) => (
                <div
                  key={n.id}
                  ref={(el) => {
                    if (el) nodeEls.current.set(n.id, el);
                    else nodeEls.current.delete(n.id);
                  }}
                  className={`min-w-[116px] max-w-[200px] rounded-lg border bg-panel px-3 py-1.5 text-center text-[0.92em] font-medium text-ink transition-opacity ${
                    litNodes?.has(n.id)
                      ? "border-copper ring-2 ring-copper/20"
                      : "border-chipline"
                  } ${litNodes && !litNodes.has(n.id) ? "opacity-40" : ""}`}
                >
                  {n.title}
                  {n.sub && (
                    <span className="mt-0.5 block text-[0.82em] font-normal leading-snug text-ink-muted">
                      {n.sub}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ))}
          <svg
            className="pointer-events-none absolute inset-0 h-full w-full text-ink-muted"
            viewBox={`0 0 ${geo.w} ${geo.h}`}
            aria-hidden="true"
          >
            <defs>
              <marker
                id={`gr-${uid}`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto"
              >
                <path d="M0 0L10 5 0 10z" fill="currentColor" />
              </marker>
            </defs>
            {geo.edges.map((e) => (
              <g
                key={e.key}
                className={!litEdges
                  ? ""
                  : litEdges.has(e.id)
                  ? "text-copper"
                  : "opacity-25"}
              >
                <path
                  d={e.d}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  markerEnd={`url(#gr-${uid})`}
                />
                {e.label && (
                  <text
                    x={e.lx}
                    y={e.ly}
                    textAnchor={e.anchor}
                    fontSize="11"
                    // halo: the label sits on top of its own line
                    style={{
                      fill: "currentColor",
                      paintOrder: "stroke",
                      stroke: "var(--color-block)",
                      strokeWidth: 4,
                    }}
                  >
                    {e.label}
                  </text>
                )}
              </g>
            ))}
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
