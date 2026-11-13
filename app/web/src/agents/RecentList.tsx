import { useState } from "react";
import type { BoardData, ClaudeSession, Session } from "../api";
import { useTermSessions } from "../term/term-api";
import { GroupMenu } from "../ui/GroupMenu";
import { enumCodec, SECTION_LABEL, StatusDot, useLocalStorage } from "../ui/ui";
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
const LAYOUTS = ["day", "repo", "card"] as const;
type Layout = typeof LAYOUTS[number];
const LAYOUT_LABEL: Record<Layout, string> = { day: "Day", repo: "Repo", card: "Card" };
const repoOf = (s: ClaudeSession) => s.repoPath?.replace(/\/+$/, "").split("/").at(-1) ?? "no folder";
// the title without the "repo — " the scan puts first, since the row shows the repo itself
const topic = (s: ClaudeSession) => {
  const prefix = `${repoOf(s)} — `;
  return s.title.startsWith(prefix) ? s.title.slice(prefix.length) : s.title;
};
// how it ended, at a glance: asked you, done, or stopped mid-work
const END: Record<string, { mark: string; tone: string; label: string }> = {
  asked: { mark: "?", tone: "text-wait", label: "asked you" },
  done: { mark: "✓", tone: "text-live", label: "done" },
  stopped: { mark: "!", tone: "text-blocked", label: "stopped mid-work" },
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
  const [layout, setLayout] = useLocalStorage<Layout>("trame:recentLayout", "day", enumCodec(LAYOUTS));
  const row = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px]";
  // the group a session sits in, its header, and the order groups come in (newest session first)
  const keyOf = (s: ClaudeSession) =>
    layout === "day" ? bucket(s.lastActive) : layout === "repo" ? repoOf(s) : cardOf.get(s.claudeId)?.id ?? "";
  const keys = [...new Set(past.map(keyOf))].sort((a, b) => (layout === "card" ? Number(a === "") - Number(b === "") : 0));
  const header = (key: string) => {
    if (layout !== "card") return <span>{layout === "repo" ? key.toUpperCase() : key}</span>;
    const card = board?.sessions.find((c) => c.id === key);
    return card
      ? (
        <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] tracking-normal text-ink-soft" title={card.title}>
          <StatusDot status={card.status} size={6} />
          <span className="truncate">{card.title}</span>
        </span>
      )
      : <span>NO CARD</span>;
  };
  const item = (s: ClaudeSession) => {
    const card = cardOf.get(s.claudeId);
    const end = s.ended && END[s.ended.kind];
    // second line: the question it ended on, else where it ran (and its card, when grouped otherwise)
    const second = s.ended?.kind === "asked" && s.ended.text
      ? <span className="truncate text-wait">asked: {s.ended.text}</span>
      : (
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          {card && layout !== "card" && <StatusDot status={card.status} size={6} />}
          <span className="truncate">{layout === "repo" ? s.branch ?? "" : [repoOf(s), s.branch].filter(Boolean).join(" · ")}</span>
        </span>
      );
    return (
      <button
        key={s.claudeId}
        type="button"
        title={[s.repoPath, card && `card: ${card.title}`, end && `${end.label}${s.ended?.text ? `: ${s.ended.text}` : ""}`].filter(Boolean).join("\n")}
        onClick={() => onSelect(s)}
        className={`${row} items-start ${selected === s.claudeId ? "bg-active-row text-ink" : "text-ink-muted hover:text-ink-soft"}`}
      >
        <span className={`w-3.5 shrink-0 text-center font-mono text-[12px] ${end?.tone ?? "text-ink-faint"}`}>{end?.mark ?? "·"}</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={`truncate ${selected === s.claudeId ? "font-medium" : ""}`}>{topic(s)}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-ink-faint">
            <AgentIcon a={{ harness: s.source, icon: null }} />
            {second}
          </span>
        </span>
        <span className="shrink-0 pt-0.5 font-mono text-[10px] tabular-nums text-ink-faint">{ago(s.lastActive)}</span>
      </button>
    );
  };
  return (
    <section className="flex flex-col gap-0.5">
      <div className={`flex items-center px-2 pb-1 ${SECTION_LABEL}`}>
        <span className="flex-1">RECENT</span>
        <GroupMenu value={layout} options={LAYOUT_LABEL} onChange={setLayout} />
      </div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="search past sessions"
        className="mx-2 mb-1 rounded-md border border-line bg-transparent px-2 py-1 text-[11.5px] text-ink outline-none placeholder:text-ink-faint focus:border-copper/60"
      />
      {!scan && <p className="px-2 text-[11.5px] text-ink-faint">looking for past sessions…</p>}
      {scan && past.length === 0 && <p className="px-2 text-[11.5px] text-ink-faint">{needle ? "No match." : "Nothing else this week."}</p>}
      {keys.map((key) => (
        <div key={`g:${key}`} className="flex flex-col gap-0.5">
          <div className="flex px-2 pb-0.5 pt-1.5 text-[10px] tracking-wide text-ink-faint">{header(key)}</div>
          {past.filter((s) => keyOf(s) === key).map(item)}
        </div>
      ))}
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
