import { useEffect, useState } from "react";
import { getEvents, getPageEvents, type PageEvent, type SessionEvent } from "./api";
import { MenuRow, Modal, Popover, statusStyle, timeAgo } from "./ui";
import { EventMeta, PresencePill } from "./agents";
import type { ItemLink, RenderMd } from "./md-types";

// Per-item ⋯ menu (shown on hover of that item only — the group is named so the
// block wrapper's own `group` does not light up every line at once).
export function ItemMenu({ actions }: { actions: { label: string; icon: string; run: () => void }[] }) {
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

function SessionFeed({ lk, onClose, md }: { lk: ItemLink; onClose: () => void; md: RenderMd }) {
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
        md={md}
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
function FeedList({ events, md, limit, onMore }: {
  events: FeedEvent[] | "failed" | null;
  md: RenderMd;
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
                {e.summary && md(e.summary)}
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
export function PageActivityChip({ pageId, sessions, md }: { pageId: string; sessions: number; md: RenderMd }) {
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
          <FeedList events={events} md={md} />
        </Modal>
      )}
    </>
  );
}

export function LinkChip({ lk, md }: { lk: ItemLink; md: RenderMd }) {
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
      {open && <SessionFeed lk={lk} md={md} onClose={() => setOpen(false)} />}
    </span>
  );
}
