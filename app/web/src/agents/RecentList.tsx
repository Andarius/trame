import { useState } from "react";
import type { BoardData, ClaudeSession, Session } from "../api";
import { useTermSessions } from "../term/term-api";
import { SECTION_LABEL, StatusDot } from "../ui/ui";
import { AgentIcon } from "./agents";
import { useScan } from "./scan";

const RECENT_DAYS = 7;
const SHOWN = 10;

// the day bucket a session falls in, for Recent's group labels
const bucket = (iso: string, now = new Date()) => {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(new Date(iso))) / 86_400_000);
  return days <= 0 ? "TODAY" : days === 1 ? "YESTERDAY" : days < 7 ? "THIS WEEK" : "OLDER";
};
const ago = (iso: string) => {
  const m = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};

// past sessions found on this machine that no shell runs now, newest first, then the way to every session
export function RecentList(
  { board, selected, history, onSelect, onHistory }: {
    board: BoardData | null; // to name the card a session is linked to
    selected: string | null; // the transcript shown
    history: boolean; // All sessions is shown
    onSelect: (s: ClaudeSession) => void;
    onHistory: () => void;
  },
) {
  const scan = useScan(RECENT_DAYS);
  const running = new Set(useTermSessions().map((x) => x.id));
  const [q, setQ] = useState("");
  const all = (scan?.groups ?? []).flatMap((g) => g.sessions).filter((s) => !s.ignored);
  const needle = q.trim().toLowerCase();
  const past = all
    .filter((s) => !running.has(s.claudeId))
    .filter((s) =>
      !needle || s.title.toLowerCase().includes(needle) || (s.repoPath ?? "").toLowerCase().includes(needle)
    )
    .sort((a, b) => b.lastActive.localeCompare(a.lastActive))
    .slice(0, SHOWN);
  const cardOf = new Map((board?.sessions ?? []).flatMap((c): [string, Session][] => [[c.id, c], ...(c.claude_id ? [[c.claude_id, c] as [string, Session]] : [])]));
  const row = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px]";
  let last: string | null = null;
  return (
    <section className="flex flex-col gap-0.5">
      <div className={`px-2 pb-1 ${SECTION_LABEL}`}>RECENT</div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="search past sessions"
        className="mx-2 mb-1 rounded-md border border-line bg-transparent px-2 py-1 text-[11.5px] text-ink outline-none placeholder:text-ink-faint focus:border-copper/60"
      />
      {!scan && <p className="px-2 text-[11.5px] text-ink-faint">looking for past sessions…</p>}
      {scan && past.length === 0 && <p className="px-2 text-[11.5px] text-ink-faint">{needle ? "No match." : "Nothing else this week."}</p>}
      {past.map((s) => {
        const b = bucket(s.lastActive);
        const head = b !== last ? <div key={`b:${b}`} className="px-2 pb-0.5 pt-1.5 text-[10px] tracking-wide text-ink-faint">{b}</div> : null;
        last = b;
        const card = cardOf.get(s.claudeId);
        return [
          head,
          <button
            key={s.claudeId}
            type="button"
            title={s.repoPath ?? undefined}
            onClick={() => onSelect(s)}
            className={`${row} ${selected === s.claudeId ? "bg-active-row font-medium text-ink" : "text-ink-muted hover:text-ink-soft"}`}
          >
            <AgentIcon a={{ harness: s.source, icon: null }} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{s.title}</span>
              {card && (
                <span
                  className="mt-0.5 inline-flex max-w-full items-center gap-1 self-start rounded border border-line px-1.5 text-[10.5px] font-normal text-ink-muted"
                  title={`linked to the card ${card.title}`}
                >
                  <StatusDot status={card.status} size={6} />
                  <span className="truncate">{card.title}</span>
                </span>
              )}
            </span>
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-faint">{ago(s.lastActive)}</span>
          </button>,
        ];
      })}
      <button
        type="button"
        onClick={onHistory}
        title="every past session, with filters and resume options"
        className={`${row} ${history ? "bg-active-row font-medium text-ink" : "text-copper hover:text-ink"}`}
      >
        <span className="w-3.5 text-center">⤢</span>
        <span className="flex-1">All sessions{scan ? ` · ${all.length}` : ""}</span>
      </button>
    </section>
  );
}
