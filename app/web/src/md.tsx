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
  useState,
} from "react";
import {
  getEvents,
  getPageEvents,
  type PageEvent,
  type SessionEvent,
} from "./api";
import { MenuRow, Modal, Popover, statusStyle, timeAgo } from "./ui";
import { EventMeta, PresencePill } from "./agents";
import { HL_ALIAS, highlightCode } from "./md-highlight";
import { CardsBlock, GraphBlock, MermaidBlock } from "./md-diagrams";
import { MdTable, TABLE_SEP, colAlign, parseTableRow } from "./MdTable";
import { renderInline } from "./md-inline";
import type { ItemLink, ListVariant, TableOps } from "./md-types";

const HEADING: Record<number, string> = {
  1: "mb-1 mt-2 text-[1.15em] font-semibold text-ink first:mt-0",
  2: "mb-1 mt-2 text-[1.08em] font-semibold text-ink first:mt-0",
  3: "mb-0.5 mt-1.5 text-[1em] font-semibold text-ink first:mt-0",
};
const isBlockStart = (l: string) =>
  /^\s*```/.test(l) || /^#{1,6}\s/.test(l) || /^\s*([-*_])\1{2,}\s*$/.test(l) ||
  /^\s*>\s?/.test(l) || /^\s*([-*+]|\d+\.)\s+/.test(l) ||
  /^\s*\|.*\|\s*$/.test(l);

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
