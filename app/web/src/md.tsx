// Tiny dependency-free Markdown → React renderer. Safe by construction: it builds
// React nodes (never dangerouslySetInnerHTML) and scheme-checks link hrefs. Covers the
// common subset — headings, fenced code, blockquotes, ordered/unordered lists, rules,
// paragraphs; inline code, **bold**, *italic*, ~~strike~~, [links](url), bare URLs
// (PR/MR links render as state chips) and {{pills}} ({{green:text}} ·
// green|yellow|red|copper|gray — handy for table cells).
// Underscore emphasis is intentionally NOT supported so snake_case survives.
import {
  Fragment,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  getEvents,
  getPageEvents,
  type PageEvent,
  type SessionEvent,
} from "./api";
import { MenuRow, Modal, Popover, statusStyle, timeAgo, IconButton } from "./ui";
import { EventMeta, PresencePill } from "./agents";
import { CARD_COLORS, parseCards } from "./cards";
import { type EdgeGeo, edgeGeometry, parseGraph } from "./graph";
import { HL_ALIAS, highlightCode } from "./md-highlight";
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

function MermaidBlock({ text }: { text: string }) {
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
function GraphBlock({ text }: { text: string }) {
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
function CardsBlock({ text }: { text: string }) {
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

const HEADING: Record<number, string> = {
  1: "mb-1 mt-2 text-[1.15em] font-semibold text-ink first:mt-0",
  2: "mb-1 mt-2 text-[1.08em] font-semibold text-ink first:mt-0",
  3: "mb-0.5 mt-1.5 text-[1em] font-semibold text-ink first:mt-0",
};
const isBlockStart = (l: string) =>
  /^\s*```/.test(l) || /^#{1,6}\s/.test(l) || /^\s*([-*_])\1{2,}\s*$/.test(l) ||
  /^\s*>\s?/.test(l) || /^\s*([-*+]|\d+\.)\s+/.test(l) ||
  /^\s*\|.*\|\s*$/.test(l);

// GFM pipe-table row: strip outer pipes, split on unescaped `|`
function parseTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
// A column's width is the dash count of its separator cell (× PX_PER_DASH) —
// valid GFM either way, so it survives export, sync and any agent rewrite.
const PX_PER_DASH = 8;
const colWidth = (c: string) => {
  const n = (c.match(/-/g) ?? []).length;
  return n > 3 ? n * PX_PER_DASH : null;
};

const colAlign = (c: string) =>
  c.startsWith(":") && c.endsWith(":")
    ? "text-center"
    : c.endsWith(":")
    ? "text-right"
    : "text-left";

// Session-report styling for bullet lists, driven by the section they sit under
// (Page.tsx maps the preceding heading block to a variant): "done" renders green
// checks with muted text, "open" renders copper rings in a copper-tinted callout.
export type ListVariant = "done" | "open";

// per-row controls (table reorder/comment, open-list mark-done) — only wired by
// the page editor; read-only contexts (comments, drawers) render them inert
type TableOps = {
  onEdit?: (next: string) => void;
  onCommentRow?: (anchor: string) => void;
  // how many visible comments anchor to this row — tints the row + pins its 💬
  rowComments?: (anchor: string) => number;
  onMarkDone?: (item: string) => void;
  onMarkOpen?: (item: string) => void;
  onEditItem?: (item: string, next: string) => void;
  // Enter inside the item editor: split the item at the caret into two lines
  onSplitItem?: (item: string, before: string, after: string) => void;
  // item text whose editor opens on mount (the fresh half of a split)
  autoEditItem?: string;
  // session links on list items: resolver returns the chip for a linked item,
  // onLinkItem puts "Link a session" in the item's ⋯ menu
  getItemLinks?: (item: string) => ItemLink[];
  onLinkItem?: (item: string) => void;
};

// Per-item ⋯ menu (shown on hover of that item only — the group is named so the
// block wrapper's own `group` does not light up every line at once).
function ItemMenu({ actions }: { actions: { label: string; icon: string; run: () => void }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className="relative ml-1 shrink-0 self-center"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        aria-label="Item actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`rounded px-1 text-[12px] leading-none text-ink-muted transition-opacity hover:bg-panel hover:text-ink-soft focus-visible:opacity-100 ${
          open ? "opacity-100" : "opacity-0 group-hover/item:opacity-100"
        }`}
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)} className="min-w-[160px]" style={{ left: "auto", right: 0 }}>
          <div role="menu">
            {actions.map((a) => (
              <MenuRow dense
                key={a.label}
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  a.run();
                }}
              >
                <span className="w-4 text-center text-[11px]">{a.icon}</span>
                <span className="flex-1 truncate">{a.label}</span>
              </MenuRow>
            ))}
          </div>
        </Popover>
      )}
    </span>
  );
}

// The linked-session chip and its feed: the session's worklog, newest first, each
// entry rendered as Markdown. Fetched on open — the page payload carries the links,
// never the entries.
export type ItemLink = { title: string; color: string; sessionId: string; open: () => void };

function SessionFeed({ lk, onClose }: { lk: ItemLink; onClose: () => void }) {
  const [events, setEvents] = useState<SessionEvent[] | "failed" | null>(null);
  useEffect(() => {
    let alive = true;
    setEvents(null);
    getEvents(lk.sessionId)
      .then((e) => alive && setEvents(Array.isArray(e) ? e : "failed"))
      .catch(() => alive && setEvents("failed"));
    return () => {
      alive = false;
    };
  }, [lk.sessionId]);
  return (
    <Modal width={720} onClose={onClose}>
      <button
        type="button"
        onClick={() => {
          onClose();
          lk.open();
        }}
        className="flex items-center gap-2 text-left text-[13px] font-medium text-ink hover:text-copper"
      >
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: lk.color }} />
        <span className="min-w-0 truncate">{lk.title}</span>
        <span className="ml-auto shrink-0 text-[11px] font-normal text-ink-muted">open the card →</span>
      </button>
      <FeedList
        events={events}
        limit={3}
        onMore={() => {
          onClose();
          lk.open();
        }}
      />
    </Modal>
  );
}

// The timeline both chips render. An entry carrying `session_title` came from the
// page feed, where several sessions are merged and each line has to name its own.
type FeedEvent = SessionEvent & Partial<Pick<PageEvent, "session_title" | "session_status">>;

// `limit` keeps a peek short (the chip popover); the rest stays in the card's journal
function FeedList({ events, limit, onMore }: {
  events: FeedEvent[] | "failed" | null;
  limit?: number;
  onMore?: () => void;
}) {
  const all = Array.isArray(events) ? events : [];
  const feed = limit ? all.slice(0, limit) : all;
  const hidden = all.length - feed.length;
  return (
    <div className={`ml-[3px] flex flex-col gap-3.5 pl-3.5 ${feed.length ? "border-l border-line" : ""}`}>
      {feed.map((e) => (
        <div key={e.id} className="relative">
          <span className="absolute -left-[18px] top-[5px] h-[7px] w-[7px] rounded-full bg-chipline" />
          <div className="flex items-center gap-1.5 text-[10.5px] text-ink-muted">
            {e.session_title && (
              <>
                <span
                  className="h-[6px] w-[6px] shrink-0 rounded-full"
                  style={{ background: statusStyle(e.session_status ?? "active").color }}
                />
                <span className="max-w-[240px] truncate font-medium text-ink-soft/90">{e.session_title}</span>
              </>
            )}
          </div>
          {e.kind === "presence"
            ? <PresencePill e={e} when={timeAgo(e.at)} />
            : (
              <>
                {e.summary && <Markdown className="text-[12.5px] text-ink-soft" text={e.summary} />}
                <EventMeta e={e} agent={e.agent ?? null} when={timeAgo(e.at)} />
              </>
            )}
        </div>
      ))}
      {hidden > 0 && (
        <button
          type="button"
          className="w-fit text-left text-[11.5px] text-ink-muted hover:text-copper"
          onClick={onMore}
        >
          {hidden} more in the card →
        </button>
      )}
      <span className="text-[11px] text-ink-muted/60">
        {events === null
          ? "loading…"
          : events === "failed"
          ? "worklog unavailable"
          : feed.length === 0
          ? "No entries yet"
          : ""}
      </span>
    </div>
  );
}

// Page-level twin of LinkChip: every session linked anywhere on the page, one
// timeline. Same rule — entries are fetched on open, never carried by the page.
export function PageActivityChip({ pageId, sessions }: { pageId: string; sessions: number }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<PageEvent[] | "failed" | null>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setEvents(null);
    getPageEvents(pageId)
      .then((e) => alive && setEvents(Array.isArray(e) ? e : "failed"))
      .catch(() => alive && setEvents("failed"));
    return () => {
      alive = false;
    };
  }, [open, pageId]);
  return (
    <>
      <button
        type="button"
        title="every session linked to this page — one worklog"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-chipline/60 px-2 py-1 text-[11px] leading-none text-ink-muted transition-colors hover:border-copper/50 hover:text-copper"
      >
        <span>Activity</span>
        <span className="text-ink-muted/70">{sessions}</span>
      </button>
      {open && (
        <Modal width={720} onClose={() => setOpen(false)}>
          <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
            <span>Page activity</span>
            <span className="ml-auto shrink-0 text-[11px] font-normal text-ink-muted">
              {Array.isArray(events) ? `${events.length} entries · ${sessions} sessions` : ""}
            </span>
          </div>
          <FeedList events={events} />
        </Modal>
      )}
    </>
  );
}

export function LinkChip({ lk }: { lk: ItemLink }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className="relative ml-1 shrink-0 self-center"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        title={`session: ${lk.title} — open the worklog`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="inline-flex max-w-[200px] items-center gap-1.5 rounded-md border border-chipline/60 px-1.5 py-0.5 align-middle text-[10px] leading-none text-ink-muted transition-colors hover:border-copper/50 hover:text-copper"
      >
        <span className="h-[6px] w-[6px] shrink-0 rounded-full" style={{ background: lk.color }} />
        <span className="truncate">{lk.title}</span>
      </button>
      {open && <SessionFeed lk={lk} onClose={() => setOpen(false)} />}
    </span>
  );
}

// trailing per-item affordances: the linked-session chip and the ⋯ menu
function itemTrail(t: string, ops?: TableOps): ReactNode {
  const lks = ops?.getItemLinks?.(t) ?? [];
  const actions = [];
  if (!lks.length && ops?.onLinkItem) actions.push({ label: "Link a session", icon: "🔗", run: () => ops.onLinkItem!(t) });
  return (
    <>
      {lks.map((lk) => <LinkChip key={lk.sessionId} lk={lk} />)}
      {actions.length > 0 && <ItemMenu actions={actions} />}
    </>
  );
}

// click a list item's text to edit just that line in place (page editor only) —
// Enter/blur commits, Escape cancels; links/images/buttons inside keep their clicks
function EditableItem(
  { raw, onCommit, onSplit, startEditing, children }: {
    raw: string;
    onCommit: (next: string) => void;
    // Enter splits at the caret instead of committing (page editor lists)
    onSplit?: (before: string, after: string) => void;
    startEditing?: boolean;
    children: ReactNode;
  },
) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(raw);
  // list items are index-keyed, so a split reuses a neighbor's instance for the
  // fresh item — open the editor on the prop flip, not just on mount
  useEffect(() => {
    if (startEditing) {
      setVal(raw);
      setEditing(true);
    }
  }, [startEditing]);
  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  if (!editing) {
    return (
      <span
        data-item-edit=""
        className="min-w-0 cursor-text"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a,img,button")) return;
          e.stopPropagation();
          setVal(raw);
          setEditing(true);
        }}
      >
        {children}
      </span>
    );
  }
  return (
    <textarea
      rows={1}
      value={val}
      // font: inherit — an editor in another face/size reflows the line you aimed at
      style={{ font: "inherit" }}
      className="w-full min-w-0 resize-none border-0 border-b border-copper/40 bg-transparent p-0 text-ink outline-none"
      ref={(el) => {
        if (el && document.activeElement !== el) {
          grow(el);
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      }}
      onChange={(e) => {
        setVal(e.target.value);
        grow(e.target);
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const el = e.currentTarget;
          setEditing(false);
          if (onSplit) {
            onSplit(val.slice(0, el.selectionStart), val.slice(el.selectionEnd));
          } else onCommit(val);
        }
        if (e.key === "Escape") {
          e.stopPropagation();
          setEditing(false);
          // reverts the draft; committing raw also removes an empty split item
          onCommit(raw);
        }
      }}
      onBlur={() => {
        setEditing(false);
        onCommit(val);
      }}
    />
  );
}

// wraps an item's rendered content in the line editor when the page editor wired it
function itemContent(
  t: string,
  ops: TableOps | undefined,
  cls?: string,
): ReactNode {
  return ops?.onEditItem
    ? (
      <EditableItem
        raw={t}
        startEditing={ops.autoEditItem !== undefined && ops.autoEditItem === t}
        onCommit={(next) => ops.onEditItem!(t, next)}
        onSplit={ops.onSplitItem
          ? (before, after) => ops.onSplitItem!(t, before, after)
          : undefined}
      >
        {renderInline(t)}
      </EditableItem>
    )
    : cls
    ? <span className={cls}>{renderInline(t)}</span>
    : renderInline(t);
}

// grow a cell editor to its content — a one-line input hid the rest of a long cell
function fitCell(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

// Card-framed table. When editable: click selects a row (shift = range,
// ctrl/cmd = toggle), ↑/↓ moves the selection, Delete removes it, Escape clears.
function MdTable(
  { header, align, rows, lines, hdrIdx, ops }: {
    header: string[];
    align: (string | undefined)[];
    rows: string[][];
    lines: string[];
    hdrIdx: number;
    ops?: TableOps;
  },
) {
  const editable = Boolean(ops?.onEdit);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  // double-clicked cell being edited in place (raw markdown only via the ✏️ toolbar)
  const [editing, setEditing] = useState<{ ri: number; ci: number } | null>(
    null,
  );
  const [draft, setDraft] = useState("");
  // column being dragged by its header edge, with the live width
  const [drag, setDrag] = useState<{ ci: number; px: number } | null>(null);
  const base = hdrIdx + 2;
  const widths = parseTableRow(lines[hdrIdx + 1]).map(colWidth);
  const widthOf = (ci: number) =>
    drag?.ci === ci ? drag.px : widths[ci] ?? null;
  const sized = header.some((_, ci) => widthOf(ci) !== null);
  // the table needs at least the sum of its columns; autos get a readable share
  const minW = sized
    ? header.reduce((t, _, ci) => t + (widthOf(ci) ?? 120), editable ? 76 : 0)
    : null;
  const setColWidth = (ci: number, px: number) => {
    const cells = parseTableRow(lines[hdrIdx + 1]);
    const cur = (cells[ci] ?? "---").trim();
    const n = Math.max(4, Math.min(160, Math.round(px / PX_PER_DASH)));
    cells[ci] = `${cur.startsWith(":") ? ":" : ""}${"-".repeat(n)}${
      cur.endsWith(":") ? ":" : ""
    }`;
    const next = [...lines];
    next[hdrIdx + 1] = `| ${cells.join(" | ")} |`;
    ops?.onEdit?.(next.join("\n"));
  };
  // drag the right edge of a header cell; commit once, on release
  const startResize = (ci: number, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).parentElement as HTMLElement;
    const x0 = e.clientX, w0 = th.offsetWidth;
    const at = (ev: PointerEvent) => Math.max(40, w0 + ev.clientX - x0);
    const move = (ev: PointerEvent) => setDrag({ ci, px: at(ev) });
    const up = (ev: PointerEvent) => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      setDrag(null);
      setColWidth(ci, at(ev));
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  };
  // comment anchor for a row: its raw line, pipes stripped (see onCommentRow)
  const anchorOf = (ri: number) =>
    lines[base + ri].replaceAll("|", " ").trim().slice(0, 80);

  const apply = (rowLines: string[], nextSel: Set<number>) => {
    const next = [...lines];
    next.splice(base, rows.length, ...rowLines);
    setSel(nextSel);
    ops?.onEdit?.(next.join("\n"));
  };
  const moveSel = (dir: -1 | 1) => {
    if (!sel.size) return;
    const rl = lines.slice(base, base + rows.length);
    const flags = rl.map((_, idx) => sel.has(idx));
    const idxs = [...rl.keys()];
    if (dir === 1) idxs.reverse();
    for (const idx of idxs) {
      if (!flags[idx]) continue;
      const j = idx + dir;
      if (j < 0 || j >= rl.length || flags[j]) continue;
      [rl[idx], rl[j]] = [rl[j], rl[idx]];
      [flags[idx], flags[j]] = [flags[j], flags[idx]];
    }
    apply(rl, new Set(flags.flatMap((f, idx) => (f ? [idx] : []))));
  };
  const removeSel = () => {
    if (!sel.size) return;
    apply(
      lines.slice(base, base + rows.length).filter((_, idx) => !sel.has(idx)),
      new Set(),
    );
  };
  const rowLines = () => lines.slice(base, base + rows.length);
  const removeRow = (ri: number) =>
    apply(rowLines().filter((_, idx) => idx !== ri), new Set());
  const addRow = () => {
    apply(
      [...rowLines(), `| ${header.map(() => "").join(" | ")} |`],
      new Set(),
    );
    setEditing({ ri: rows.length, ci: 0 });
    setDraft("");
  };
  // rewrite one cell in its raw line; `then` chains Tab-editing into the next cell
  const commitCell = (
    ri: number,
    ci: number,
    value: string,
    then: { ri: number; ci: number } | null,
  ) => {
    const cells = parseTableRow(lines[base + ri]);
    cells[ci] = value.replaceAll("|", "\\|").trim();
    const next = [...lines];
    next[base + ri] = `| ${cells.join(" | ")} |`;
    setEditing(then);
    if (then) setDraft(parseTableRow(next[base + then.ri])[then.ci] ?? "");
    ops?.onEdit?.(next.join("\n"));
  };

  useEffect(() => {
    if (!sel.size) return;
    const key = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return; // cell edit owns the keys
      if (e.key === "ArrowUp") {
        e.preventDefault();
        moveSel(-1);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        moveSel(1);
      } else if (e.key === "Escape") {
        setSel(new Set());
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        removeSel();
      }
    };
    const clear = () => setSel(new Set());
    document.addEventListener("keydown", key);
    document.addEventListener("mousedown", clear);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("mousedown", clear);
    };
  });

  // checkbox column mirrors the List/database selection layout (shiftRange-style)
  const boxClick = (ri: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setSel((cur) => {
      const next = new Set(cur);
      if (e.shiftKey && anchor !== null) {
        const on = !cur.has(ri);
        const [lo, hi] = [Math.min(anchor, ri), Math.max(anchor, ri)];
        for (let k = lo; k <= hi; k++) {
          if (on) next.add(k);
          else next.delete(k);
        }
        return next;
      }
      if (next.has(ri)) next.delete(ri);
      else next.add(ri);
      return next;
    });
    setAnchor(ri);
  };

  return (
    <div
      // wider than the 820px text column (px-8 gutters) → grow into the margins
      className={`md-table-card group/table my-2 overflow-x-auto rounded-lg border border-line bg-block px-3 py-1 ${
        editable && minW && minW > 756
          ? "relative left-1/2 w-[min(1400px,100cqw_-_4rem)] -translate-x-1/2"
          : ""
      }`}
    >
      <table
        style={minW ? { minWidth: minW } : undefined}
        className={`w-full border-collapse text-[0.92em] ${
          sized ? "table-fixed" : ""
        }`}
      >
        {sized && (
          <colgroup>
            {editable && <col style={{ width: 24 }} />}
            {header.map((_, ci) => (
              <col
                key={ci}
                style={widthOf(ci) !== null
                  ? { width: widthOf(ci)! }
                  : undefined}
              />
            ))}
            {editable && <col style={{ width: 52 }} />}
          </colgroup>
        )}
        <thead>
          <tr>
            {editable && (
              <th className="w-6 border-b border-line px-1 py-2">
                <input
                  type="checkbox"
                  title="Select all rows"
                  className={`h-3.5 w-3.5 accent-[#c98a63] ${
                    sel.size ? "" : "opacity-0 hover:opacity-100"
                  }`}
                  checked={rows.length > 0 && sel.size === rows.length}
                  onChange={(e) =>
                    setSel(
                      e.target.checked
                        ? new Set(rows.map((_, idx) => idx))
                        : new Set(),
                    )}
                  onMouseDown={(e) =>
                    e.stopPropagation()}
                />
              </th>
            )}
            {header.map((h, ci) => (
              <th
                key={ci}
                className={`relative border-b border-line px-2.5 py-2 text-[0.8em] font-medium uppercase tracking-wider text-ink-muted ${
                  align[ci] ?? "text-left"
                }`}
              >
                {renderInline(h)}
                {editable && (
                  <span
                    title="Drag to resize this column"
                    onPointerDown={(e) => startResize(ci, e)}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    // the hairline shows on table hover: an invisible grip is
                    // one nobody finds
                    className="absolute -right-1.5 top-0 z-10 h-full w-3 cursor-col-resize after:absolute after:inset-y-1 after:left-1/2 after:w-px after:bg-copper/40 after:opacity-0 group-hover/table:after:opacity-100 hover:after:w-0.5 hover:after:bg-copper hover:after:opacity-100"
                  />
                )}
              </th>
            ))}
            {editable && <th className="w-0 border-b border-line" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => {
            const nComments = ops?.rowComments?.(anchorOf(ri)) ?? 0;
            return (
              <tr
                key={ri}
                className={`group/row border-b border-line-soft/50 last:border-0 ${
                  sel.has(ri) || nComments ? "bg-copper/[0.06]" : ""
                }`}
              >
                {editable && (
                  <td className="w-6 px-1 py-1.5 align-top">
                    <input
                      type="checkbox"
                      title="Select row — shift-click ranges, ↑↓ move, Del remove"
                      className={`h-3.5 w-3.5 accent-[#c98a63] ${
                        sel.size ? "" : "opacity-0 group-hover/row:opacity-100"
                      }`}
                      checked={sel.has(ri)}
                      readOnly
                      // no text selection on shift-click; keep block select/clear out of it
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        if (e.shiftKey) e.preventDefault();
                      }}
                      // toggle in onClick (not onChange): change events have no shiftKey
                      onClick={(e) => boxClick(ri, e)}
                    />
                  </td>
                )}
                {r.map((c, ci) => (
                  <td
                    key={ci}
                    title={editable &&
                        !(editing?.ri === ri && editing?.ci === ci)
                      ? "Double-click to edit"
                      : undefined}
                    onDoubleClick={(e) => {
                      if (!editable) return;
                      e.stopPropagation();
                      document.getSelection()?.removeAllRanges();
                      setEditing({ ri, ci });
                      setDraft(c);
                    }}
                    className={`px-2.5 py-1.5 align-top text-ink-soft ${
                      align[ci] ?? "text-left"
                    }`}
                  >
                    {editing?.ri === ri && editing?.ci === ci
                      ? (
                        <textarea
                          autoFocus
                          rows={1}
                          ref={fitCell}
                          value={draft}
                          onChange={(e) => {
                            setDraft(e.target.value);
                            fitCell(e.target);
                          }}
                          onBlur={() => {
                            if (editing?.ri === ri && editing?.ci === ci) {
                              commitCell(ri, ci, draft, null);
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commitCell(ri, ci, draft, null);
                            } else if (e.key === "Escape") {
                              setEditing(null);
                            } else if (e.key === "Tab") {
                              e.preventDefault();
                              const d = e.shiftKey ? -1 : 1;
                              let nri = ri, nci = ci + d;
                              if (nci >= r.length) {
                                nri = ri + 1;
                                nci = 0;
                              } else if (nci < 0) {
                                nri = ri - 1;
                                nci = r.length - 1;
                              }
                              commitCell(
                                ri,
                                ci,
                                draft,
                                nri >= 0 && nri < rows.length
                                  ? { ri: nri, ci: nci }
                                  : null,
                              );
                            }
                          }}
                          style={{ font: "inherit" }}
                          className="block w-full resize-none overflow-hidden border-0 border-b border-copper/60 bg-transparent p-0 text-ink outline-none"
                        />
                      )
                      : renderInline(c)}
                  </td>
                ))}
                {editable && (
                  <td className="w-0 whitespace-nowrap px-1 py-1 align-top">
                    {ops?.onCommentRow && (
                      <button
                        type="button"
                        title={nComments
                          ? `${nComments} comment${
                            nComments > 1 ? "s" : ""
                          } on this row — add another`
                          : "Comment on this row"}
                        onClick={(e) => {
                          e.stopPropagation();
                          ops.onCommentRow?.(anchorOf(ri));
                        }}
                        className={`flex items-center gap-0.5 rounded px-1 text-[11px] hover:bg-panel hover:text-copper ${
                          nComments
                            ? "text-copper"
                            : "text-ink-muted opacity-0 group-hover/row:opacity-100"
                        }`}
                      >
                        💬{nComments > 0 && (
                          <span className="text-[10px] font-medium">
                            {nComments}
                          </span>
                        )}
                      </button>
                    )}
                    <IconButton tone="danger" aria-label="Delete this row"
                      title="Delete this row"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeRow(ri);
                      }}
                      className="rounded px-1 text-[11px] opacity-0 hover:bg-panel group-hover/row:opacity-100"
                    >
                      ×
                    </IconButton>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {editable && (
        <button
          type="button"
          title="Add a row at the end"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            addRow();
          }}
          className="my-1 w-full rounded px-2 py-1 text-left text-[0.8em] text-ink-muted opacity-0 hover:bg-panel hover:text-copper group-hover/table:opacity-100"
        >
          + Row
        </button>
      )}
    </div>
  );
}

function renderBlocks(
  src: string,
  listVariant?: ListVariant,
  ops?: TableOps,
): ReactNode[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0, key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = line.match(/^\s*```\s*([\w+#-]*)/);
    if (fence) { // fenced code — the token after ``` is the language
      const label = fence[1];
      const lang = HL_ALIAS[label.toLowerCase()] ?? null;
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i++]);
      }
      i++; // closing fence
      const code = buf.join("\n");
      if (label.toLowerCase() === "mermaid") {
        out.push(<MermaidBlock key={key++} text={code} />);
        continue;
      }
      if (label.toLowerCase() === "graph") {
        out.push(<GraphBlock key={key++} text={code} />);
        continue;
      }
      if (label.toLowerCase() === "cards") {
        out.push(<CardsBlock key={key++} text={code} />);
        continue;
      }
      out.push(
        <pre
          key={key++}
          className="md-snippet-card relative my-1.5 overflow-x-auto rounded-md bg-panel p-2 font-mono text-[0.92em] leading-relaxed text-ink-soft"
        >
          {label && (
            <span className="pointer-events-none absolute right-1.5 top-1 select-none text-[9px] uppercase tracking-wide text-ink-muted/50">
              {label}
            </span>
          )}
          <code>{lang ? highlightCode(code, lang) : code}</code>
        </pre>,
      );
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      const Tag = `h${Math.min(lvl, 6)}` as keyof JSX.IntrinsicElements;
      out.push(
        <Tag key={key++} className={HEADING[lvl] ?? HEADING[3]}>
          {renderInline(h[2])}
        </Tag>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push(<hr key={key++} className="my-2 border-line-soft" />);
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) { // blockquote
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      }
      out.push(
        <blockquote
          key={key++}
          className="my-1.5 border-l-2 border-chipline pl-2.5 text-ink-muted"
        >
          {renderBlocks(buf.join("\n"))}
        </blockquote>,
      );
      continue;
    }
    const listM = line.match(/^\s*([-*+]|\d+\.)\s+/);
    if (listM) {
      const ordered = /\d+\./.test(listM[1]);
      const texts: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*([-*+]|\d+\.)\s+(.*)$/);
        if (!m) break;
        texts.push(m[2]);
        i++;
      }
      if (ordered) {
        out.push(
          <ol
            key={key++}
            className="my-1 list-decimal space-y-0.5 pl-5 text-ink-soft"
          >
            {texts.map((t, j) => (
              <li key={j} className="leading-relaxed">{itemContent(t, ops)}</li>
            ))}
          </ol>,
        );
      } else if (listVariant === "done") {
        out.push(
          <ul
            key={key++}
            className="my-1 list-none space-y-1 pl-0 text-ink-muted"
          >
            {texts.map((t, j) => (
              <li key={j} className="group/item flex gap-2 leading-relaxed">
                {ops?.onMarkOpen
                  ? (
                    <button
                      type="button"
                      title="Mark as open"
                      className="w-3.5 shrink-0 pt-px text-center text-[11px] text-active hover:opacity-60"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        // don't bubble into the block's click-to-edit
                        e.stopPropagation();
                        ops.onMarkOpen!(t);
                      }}
                    >
                      ✓
                    </button>
                  )
                  : (
                    <span className="w-3.5 shrink-0 pt-px text-center text-[11px] text-active">
                      ✓
                    </span>
                  )}
                {itemContent(t, ops, "min-w-0")}
                {itemTrail(t, ops)}
              </li>
            ))}
          </ul>,
        );
      } else if (listVariant === "open") {
        out.push(
          <div
            key={key++}
            className="my-1.5 rounded-lg border border-copper/30 bg-copper/[0.06] px-3 py-2"
          >
            <ul className="list-none space-y-1.5 pl-0 text-ink-soft">
              {texts.map((t, j) => (
                <li key={j} className="group/item flex gap-2 leading-relaxed">
                  {ops?.onMarkDone
                    ? (
                      <button
                        type="button"
                        title="Mark as done"
                        className="mt-[5px] h-3 w-3 shrink-0 rounded-full border-[1.5px] border-copper hover:bg-copper/20"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          // don't bubble into the block's click-to-edit
                          e.stopPropagation();
                          ops.onMarkDone!(t);
                        }}
                      />
                    )
                    : (
                      <span className="mt-[5px] h-3 w-3 shrink-0 rounded-full border-[1.5px] border-copper" />
                    )}
                  {itemContent(t, ops, "min-w-0")}
                  {itemTrail(t, ops)}
                </li>
              ))}
            </ul>
          </div>,
        );
      } else {
        out.push(
          <ul
            key={key++}
            className="my-1 list-disc space-y-0.5 pl-4 text-ink-soft"
          >
            {texts.map((t, j) => (
              <li key={j} className="group/item leading-relaxed">
                {itemContent(t, ops)}
                {itemTrail(t, ops)}
              </li>
            ))}
          </ul>,
        );
      }
      continue;
    }
    if (line.includes("|") && TABLE_SEP.test(lines[i + 1] ?? "")) {
      const hdrIdx = i;
      const align = parseTableRow(lines[i + 1]).map(colAlign);
      const header = parseTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        rows.push(parseTableRow(lines[i]));
        i++;
      }
      out.push(
        <MdTable
          key={key++}
          header={header}
          align={align}
          rows={rows}
          lines={lines}
          hdrIdx={hdrIdx}
          ops={ops}
        />,
      );
      continue;
    }
    // paragraph: accumulate until a blank line or a block starter; single newlines → <br>
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      buf.push(lines[i++]);
    }
    // a block starter no branch above consumed (a pipe row with no separator line)
    // would leave i unmoved and spin the outer loop — take it as plain text
    if (!buf.length) buf.push(lines[i++]);
    out.push(
      <p
        key={key++}
        className="my-1 leading-relaxed text-ink-soft first:mt-0 last:mb-0"
      >
        {buf.map((l, j) => (
          <Fragment key={j}>{j > 0 && <br />}{renderInline(l)}</Fragment>
        ))}
      </p>,
    );
  }
  return out;
}

// Render `text` as Markdown. `className` styles the wrapper (e.g. font size context).
// `onEdit`/`onCommentRow`/`onMarkDone` enable per-row controls (page editor only).
export function Markdown(
  {
    text,
    className,
    listVariant,
    onEdit,
    onCommentRow,
    rowComments,
    onMarkDone,
    onMarkOpen,
    onEditItem,
    onSplitItem,
    autoEditItem,
    getItemLinks,
    onLinkItem,
  }: {
    text: string;
    className?: string;
    listVariant?: ListVariant;
    onEdit?: (next: string) => void;
    onCommentRow?: (anchor: string) => void;
    rowComments?: (anchor: string) => number;
    onMarkDone?: (item: string) => void;
    onMarkOpen?: (item: string) => void;
    onEditItem?: (item: string, next: string) => void;
    onSplitItem?: (item: string, before: string, after: string) => void;
    autoEditItem?: string;
    getItemLinks?: TableOps["getItemLinks"];
    onLinkItem?: (item: string) => void;
  },
) {
  return (
    <div className={className}>
      {renderBlocks(text, listVariant, {
        onEdit,
        onCommentRow,
        rowComments,
        onMarkDone,
        onMarkOpen,
        onEditItem,
        onSplitItem,
        autoEditItem,
        getItemLinks,
        onLinkItem,
      })}
    </div>
  );
}
