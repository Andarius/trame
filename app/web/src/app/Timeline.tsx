import { Fragment, useEffect, useMemo, useState } from "react";
import { AgentIcon } from "../agents/agents";
import { type BoardData, type DueTodo, getDue, getTimeline, type Session, type TimelineEntry, type TimelineSpan } from "../api";
import { EmptyState, EntityIcon, SECTION_LABEL, SegToggle, STRING_CODEC, useLocalStorage } from "../ui/ui";

const TABS = [
  { value: "gantt", label: "Gantt" },
  { value: "journal", label: "Journal" },
];
const RANGES = [
  { value: "14", label: "2 weeks" },
  { value: "42", label: "6 weeks" },
  { value: "91", label: "Quarter" },
];
const GROUPS = [
  { value: "project", label: "By project" },
  { value: "status", label: "By status" },
];
const DAY_MS = 86_400_000;
const SHORT = new Intl.DateTimeFormat("en", { day: "numeric", month: "short" });
const WEEKDAY = new Intl.DateTimeFormat("en", { weekday: "long" });
const TIME = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

// a local calendar day as a day number, and back
const dayOf = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS;
const dateOf = (n: number) => new Date(1970, 0, 1 + n);
const parseDay = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return dayOf(new Date(y, m - 1, d));
};

type Data = { entries: TimelineEntry[]; spans: TimelineSpan[]; due: DueTodo[] };

// Timeline: when each card was worked on (Gantt), and what was logged day by day (Journal), from the worklog.
export function Timeline({ board, onOpenSession }: { board: BoardData | null; onOpenSession: (id: string) => void }) {
  const [tabRaw, setTab] = useLocalStorage("trame:timelineTab", "gantt", STRING_CODEC);
  const tab = tabRaw === "journal" ? "journal" : "gantt";
  const [range, setRange] = useLocalStorage("trame:timelineRange", "42", STRING_CODEC);
  const [groupRaw, setGroup] = useLocalStorage("trame:timelineGroup", "project", STRING_CODEC);
  const group = groupRaw === "status" ? "status" : "project";
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const days = Number(range);
  useEffect(() => {
    const load = () =>
      Promise.all([getTimeline(days), getDue()]).then(
        ([t, due]) => setData({ ...t, due }),
        (e: Error) => setError(e.message),
      );
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [days]);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-4 px-6 py-6">
        <div className="flex flex-wrap items-center gap-2">
          <SegToggle options={TABS} value={tab} onChange={setTab} />
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {tab === "gantt" && <SegToggle options={GROUPS} value={group} onChange={setGroup} />}
            <SegToggle options={RANGES} value={range} onChange={setRange} />
          </div>
        </div>
        {error
          ? <EmptyState page>Could not load the worklog: {error}</EmptyState>
          : !data || !board
          ? <EmptyState page>Reading the worklog…</EmptyState>
          : tab === "gantt"
          ? <Gantt data={data} board={board} days={days} group={group} onOpenSession={onOpenSession} />
          : <Journal entries={data.entries} board={board} onOpenSession={onOpenSession} />}
      </div>
    </div>
  );
}

const CARD = "rounded-xl border border-line bg-panel p-4";

const statusIn = (board: BoardData, key: string) => board.statuses.find((x) => x.key === key);

function projectOf(board: BoardData, s: Session) {
  return s.client_id ? board.projects.find((p) => p.id === s.client_id) ?? null : null;
}

type Row = { s: Session; from: number | null; to: number | null; open: boolean; ticks: Set<number>; due: number | null; n: number };

function Gantt({ data, board, days, group, onOpenSession }: {
  data: Data;
  board: BoardData;
  days: number;
  group: "project" | "status";
  onOpenSession: (id: string) => void;
}) {
  const today = dayOf(new Date());
  const start = today - days + 1;
  // room on the right for upcoming due dates
  const end = today + Math.max(7, Math.round(days / 6));
  const span = end - start + 1;
  const pct = (d: number) => `${((d - start) / span) * 100}%`;
  const statusOf = (key: string) => statusIn(board, key);

  const lanes = useMemo(() => {
    const rows = new Map<string, Row>();
    const byId = new Map(board.sessions.map((s) => [s.id, s]));
    for (const sp of data.spans) {
      const s = byId.get(sp.session_id);
      if (!s) continue;
      rows.set(s.id, {
        s,
        from: dayOf(new Date(sp.first)),
        to: dayOf(new Date(sp.last)),
        open: !(statusIn(board, s.status)?.terminal ?? false),
        ticks: new Set(),
        due: null,
        n: sp.n,
      });
    }
    for (const e of data.entries) rows.get(e.session_id)?.ticks.add(dayOf(new Date(e.at)));
    for (const d of data.due) {
      const s = d.card_id ? byId.get(d.card_id) : null;
      if (!s) continue;
      const day = parseDay(d.due);
      if (day > end) continue;
      const row = rows.get(s.id) ?? { s, from: null, to: null, open: true, ticks: new Set<number>(), due: null, n: 0 };
      row.due = row.due === null ? day : Math.min(row.due, day);
      rows.set(s.id, row);
    }
    const out = new Map<string, { label: string; icon: string | null; glyph: string; color?: string; order: string; rows: Row[] }>();
    for (const r of rows.values()) {
      const p = projectOf(board, r.s);
      const st = statusIn(board, r.s.status);
      const key = group === "project" ? p?.id ?? "" : r.s.status;
      const lane = out.get(key) ?? (group === "project"
        ? { label: p?.name ?? "No project", icon: p?.icon ?? null, glyph: p ? "◎" : "◌", order: p ? p.name.toLowerCase() : "~", rows: [] }
        : { label: st?.label ?? r.s.status, icon: null, glyph: "●", color: st?.color, order: st?.sort_key ?? "~", rows: [] });
      lane.rows.push(r);
      out.set(key, lane);
    }
    const sorted = [...out.values()].sort((a, b) => a.order.localeCompare(b.order));
    for (const l of sorted) l.rows.sort((a, b) => (a.from ?? a.due ?? 0) - (b.from ?? b.due ?? 0));
    return sorted;
  }, [data, board, group, end]);

  if (lanes.length === 0) return <EmptyState page>No worklog entries in this period.</EmptyState>;
  // Mondays label the axis; at a quarter, every other one
  const mondays: number[] = [];
  for (let d = start; d <= end; d++) if (dateOf(d).getDay() === 1) mondays.push(d);
  const labels = days > 60 ? mondays.filter((_, i) => i % 2 === 0) : mondays;
  const weekends: number[] = [];
  if (days <= 60) for (let d = start; d <= end; d++) if ([0, 6].includes(dateOf(d).getDay())) weekends.push(d);
  const cell = (d: number) => ({ left: pct(d), width: `${(1 / span) * 100}%` });

  return (
    <div className={`${CARD} overflow-x-auto`}>
      <div className="grid min-w-[720px] grid-cols-[220px_minmax(0,1fr)] text-[12.5px]">
        <div />
        <div className="relative h-6 border-b border-line">
          {labels.map((d) => (
            <span key={d} className="absolute top-1 -translate-x-1/2 whitespace-nowrap text-[10.5px] text-ink-muted" style={{ left: pct(d + 0.5) }}>
              {SHORT.format(dateOf(d))}
            </span>
          ))}
        </div>
        {lanes.map((lane) => (
          <Fragment key={lane.label}>
            <div className={`col-span-2 flex items-center gap-1.5 pb-1 pt-3 ${SECTION_LABEL}`}>
              {lane.color
                ? <span className="h-2 w-2 rounded-full" style={{ background: lane.color }} />
                : <EntityIcon icon={lane.icon} fallback={lane.glyph} size={13} />}
              {lane.label.toUpperCase()}
            </div>
            {lane.rows.map((r) => {
              const st = statusOf(r.s.status);
              const color = st?.color ?? "var(--color-ink-faint)";
              const from = r.from === null ? null : Math.max(r.from, start);
              const late = r.due !== null && r.due < today;
              return (
                <Fragment key={r.s.id}>
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-2 py-1 pr-3 text-left text-ink-soft hover:text-ink"
                    onClick={() => onOpenSession(r.s.id)}
                    title={r.s.title}
                  >
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
                    <span className="truncate">{r.s.title}</span>
                  </button>
                  <button
                    type="button"
                    className="relative h-7 border-b border-line-soft hover:bg-hover"
                    onClick={() => onOpenSession(r.s.id)}
                    title={`${r.s.title}: ${st?.label ?? r.s.status}, ${r.n} worklog entr${r.n === 1 ? "y" : "ies"}${
                      r.from === null ? "" : `, ${SHORT.format(dateOf(r.from))} → ${SHORT.format(dateOf(r.to!))}`
                    }${r.due === null ? "" : `, due ${SHORT.format(dateOf(r.due))}`}`}
                  >
                    {weekends.map((d) => <span key={d} className="absolute inset-y-0 bg-line/35" style={cell(d)} />)}
                    <span className="absolute inset-y-0 right-0 bg-hover/60" style={{ left: pct(today + 1) }} />
                    {r.open && r.to !== null && r.to < today && (
                      <span
                        className="absolute top-[13px] h-0.5 opacity-40"
                        style={{ left: pct(r.to + 1), width: `${((today - r.to) / span) * 100}%`, background: color }}
                      />
                    )}
                    {from !== null && r.to !== null && (
                      <span
                        className={`absolute top-[7px] h-3.5 opacity-90 ${r.from! < start ? "rounded-r-full" : "rounded-full"}`}
                        style={{ left: pct(from), width: `${((r.to - from + 1) / span) * 100}%`, background: color }}
                      />
                    )}
                    {[...r.ticks].filter((d) => d >= start).map((d) => (
                      <span key={d} className="absolute top-[10px] h-2 w-[3px] -translate-x-1/2 rounded-sm bg-panel/85" style={{ left: pct(d + 0.5) }} />
                    ))}
                    <span className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-copper" style={{ left: pct(today + 0.5) }} />
                    {r.due !== null && r.due >= start && (
                      <span
                        className={`absolute top-1 z-10 -translate-x-1/2 text-[13px] leading-5 ${late ? "text-blocked" : "text-ink"}`}
                        style={{ left: pct(r.due + 0.5), textShadow: "0 0 2px var(--color-panel), 0 0 2px var(--color-panel)" }}
                      >
                        ◆
                      </span>
                    )}
                  </button>
                </Fragment>
              );
            })}
          </Fragment>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-muted">
        <span>Bars run from a card's first worklog entry to its last; a thin line runs on to today while the card is open.</span>
        <span>▮ a day with entries</span>
        <span>◆ next due todo</span>
        <span className="text-copper">│ today</span>
      </div>
    </div>
  );
}

function Journal({ entries, board, onOpenSession }: {
  entries: TimelineEntry[];
  board: BoardData;
  onOpenSession: (id: string) => void;
}) {
  const days = useMemo(() => {
    const out: { day: number; cards: { id: string; entries: TimelineEntry[] }[]; n: number }[] = [];
    for (const e of entries) {
      const day = dayOf(new Date(e.at));
      let d = out.at(-1);
      if (!d || d.day !== day) out.push(d = { day, cards: [], n: 0 });
      let c = d.cards.find((x) => x.id === e.session_id);
      if (!c) d.cards.push(c = { id: e.session_id, entries: [] });
      c.entries.push(e);
      d.n++;
    }
    return out;
  }, [entries]);
  if (days.length === 0) return <EmptyState page>No worklog entries in this period.</EmptyState>;
  const today = dayOf(new Date());
  // weekday names only while they are unambiguous; older days lead with the date
  const dayLabel = (d: number) =>
    d === today ? "Today" : d === today - 1 ? "Yesterday" : today - d < 7 ? WEEKDAY.format(dateOf(d)) : SHORT.format(dateOf(d));
  const daySub = (d: number) => today - d < 7 ? SHORT.format(dateOf(d)) : WEEKDAY.format(dateOf(d));
  const byId = new Map(board.sessions.map((s) => [s.id, s]));

  return (
    <div className={CARD}>
      <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-5 text-[13px]">
        {days.map((d) => (
          <Fragment key={d.day}>
            <div className="pt-3">
              <div className="text-[12.5px] font-semibold">{dayLabel(d.day)}</div>
              <div className="text-[11px] text-ink-muted">
                {daySub(d.day)} · {d.n} entr{d.n === 1 ? "y" : "ies"}
              </div>
            </div>
            <div className="relative border-l-2 border-line py-3 pl-5">
              <span className="absolute -left-[6px] top-[18px] h-2.5 w-2.5 rounded-full bg-copper" />
              {d.cards.map((c) => {
                const s = byId.get(c.id);
                const p = s ? projectOf(board, s) : null;
                const st = s ? board.statuses.find((x) => x.key === s.status) : undefined;
                return (
                  <div key={c.id} className="mb-3 last:mb-0">
                    <button
                      type="button"
                      className="flex max-w-full items-center gap-2 text-left font-semibold hover:underline"
                      onClick={() => onOpenSession(c.id)}
                    >
                      {p && <EntityIcon icon={p.icon} fallback="◎" size={14} />}
                      <span className="truncate">{s?.title ?? "Deleted card"}</span>
                      {st && (
                        <span className="shrink-0 rounded-full border px-1.5 text-[10.5px] font-normal" style={{ color: st.color }}>
                          {st.label.toLowerCase()}
                        </span>
                      )}
                    </button>
                    {c.entries.map((e) => (
                      <div key={e.id} className="flex gap-2.5 py-0.5 pl-4 text-ink-soft">
                        <span className="w-[42px] shrink-0 font-mono text-[11.5px] leading-5 text-ink-faint">{TIME.format(new Date(e.at))}</span>
                        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                          {e.summary || <span className="text-ink-faint">(no summary)</span>}
                          {e.agent && (
                            <span className="ml-1.5 inline-flex items-center gap-1 align-[-2px] text-[11px] text-ink-faint">
                              · <AgentIcon a={{ harness: e.agent, icon: null }} />
                              {e.agent_name ?? e.agent}
                            </span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
