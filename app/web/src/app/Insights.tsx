import { Fragment, useEffect, useMemo, useState } from "react";
import { AgentIcon } from "../agents/agents";
import { type BoardData, type CardUsage, getStats, type StatsRow } from "../api";
import { EmptyState, EntityIcon, SECTION_LABEL, SegToggle, STRING_CODEC, useLocalStorage } from "../ui/ui";
import { burn, type CostParts, costOf, costParts, costSum, heatLevels, hourGrid, median, modelMix, topModels, usd, weekOf } from "./insights-stats";

const RANGES = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
];
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const fmt = (n: number) => (n < 10_000 ? n.toLocaleString() : compact.format(n));

// local midnight of a YYYY-MM-DD day
function localDate(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// local YYYY-MM-DD, n days before `today` (also YYYY-MM-DD)
function shift(today: string, n: number): string {
  const t = localDate(today);
  t.setDate(t.getDate() - n);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

type Totals = {
  prompts: number;
  tokens: number;
  entries: number;
  done: number;
  prs: number;
  merged: number;
  reopened: number;
};
const ZERO: Totals = { prompts: 0, tokens: 0, entries: 0, done: 0, prs: 0, merged: 0, reopened: 0 };
const sum = (rows: StatsRow[]) =>
  rows.reduce<Totals>(
    (t, r) => ({
      prompts: t.prompts + r.prompts,
      tokens: t.tokens + r.tokens,
      entries: t.entries + r.entries,
      done: t.done + r.done,
      prs: t.prs + r.prs,
      merged: t.merged + r.merged,
      reopened: t.reopened + (r.reopened ?? 0),
    }),
    ZERO,
  );
// a row from this machine's transcripts; another device's carry no token split
const local = (r: StatsRow) => r.out > 0 || r.cached > 0;
// a day counts as active when you prompted an agent or logged work
const activity = (r: StatsRow) => r.prompts + r.entries;

// Insights: what you and your agents did, from the worklog, cards and the agent transcripts on this machine.
export function Insights({ board, onOpenSession }: { board: BoardData | null; onOpenSession: (id: string) => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof getStats>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useLocalStorage("trame:insightsRange", "30", STRING_CODEC);
  useEffect(() => {
    getStats().then(setData, (e: Error) => setError(e.message));
  }, []);
  // merged PRs arrive from GitHub/GitLab in the background: reload until they are in
  const pending = data?.prs.pending || data?.devices.pending;
  useEffect(() => {
    if (!pending) return;
    // an interval, so a failed reload is tried again
    const t = setInterval(() => void getStats().then(setData, () => {}), 5000);
    return () => clearInterval(t);
  }, [pending]);

  const days = Number(range);
  const view = useMemo(() => {
    if (!data) return null;
    const from = shift(data.today, days - 1);
    const prevFrom = shift(data.today, 2 * days - 1);
    const cur = data.rows.filter((r) => r.d >= from);
    const prev = data.rows.filter((r) => r.d >= prevFrom && r.d < from);
    // no comparison against a previous period the data only partly covers
    const hasPrev = prevFrom >= data.from && data.rows.some((r) => r.d < from);
    const inRange = <T extends { d: string }>(xs: T[]) => xs.filter((x) => x.d >= from);
    const inPrev = <T extends { d: string }>(xs: T[]) => xs.filter((x) => x.d >= prevFrom && x.d < from);
    return {
      cur,
      cards: inRange(data.cards),
      prevCards: inPrev(data.cards),
      hours: inRange(data.hours),
      closed: inRange(data.closed),
      prevClosed: inPrev(data.closed),
      agentTime: inRange(data.agent_time),
      parallel: inRange(data.parallel),
      prevParallel: inPrev(data.parallel),
      prevAgentTime: inPrev(data.agent_time),
      totals: sum(cur),
      prev: sum(prev),
      prevRows: prev,
      hasPrev,
      // ranked over the whole year, so a model keeps its colour across ranges
      models: topModels(data.rows),
    };
  }, [data, days]);

  if (error) return <EmptyState page>Could not load stats: {error}</EmptyState>;
  if (!data || !view) return <EmptyState page>Reading the worklog and agent transcripts…</EmptyState>;

  const fromDay = shift(data.today, days - 1);
  const period = (a: string, b: string) => `${short(a)} – ${short(b)}`;
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-6 px-6 py-6">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[12.5px] text-ink-soft">
            {period(fromDay, data.today)}
            {view.hasPrev && (
              <span className="text-ink-faint"> · vs {period(shift(data.today, 2 * days - 1), shift(data.today, days))}</span>
            )}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <SegToggle options={RANGES} value={range} onChange={setRange} />
          </div>
        </div>
        <Section title="ACTIVITY">
          <Tiles view={view} pick={["prompts", "tokens", "agentHours", "parallel"]} prsLoading={false} />
          <div className="grid items-stretch gap-3 lg:grid-cols-5">
            <div className="min-w-0 lg:col-span-3"><Streak rows={data.rows} today={data.today} weeks={26} entries={view.totals.entries} /></div>
            <div className="min-w-0 lg:col-span-2"><Hours rows={view.hours} /></div>
          </div>
        </Section>
        <Section title="FLOW">
          <Tiles
            view={view}
            pick={["done", "merged", "cycle", "promptsPerCard"]}
            prsLoading={!!data.prs.pending && !data.prs.fetched}
          />
          <div className="grid items-stretch gap-3 lg:grid-cols-5">
            <div className="min-w-0 lg:col-span-3"><ByProject rows={view.cur} closed={view.closed} board={board} /></div>
            <div className="min-w-0 lg:col-span-2"><Stalled board={board} onOpenSession={onOpenSession} /></div>
          </div>
        </Section>
        <Section title="COST">
          <Tiles view={view} pick={["cost", "costPerCard", "tokensPerCard", "cache"]} prsLoading={false} />
          <Spend rows={data.rows} cur={view.cur} today={data.today} />
          <Models rows={view.cur} models={view.models} from={fromDay} today={data.today} daily={days <= 30} />
          <TopCards rows={view.cards} local={view.cur.filter(local)} board={board} onOpenSession={onOpenSession} />
        </Section>
        <p className="text-[11px] text-ink-faint">
          Prompts and tokens come from the {fmt(data.scan.files)} Claude Code, Codex and Vibe transcripts on this machine
          {data.devices.others > 0
            ? ` and ${data.devices.others} other device${data.devices.others === 1 ? "" : "s"} through the hub`
            : data.devices.hub
            ? " (other devices show up once they run this version)"
            : " only (no hub configured)"}; the worklog and cards from Trame.
        </p>
      </div>
    </div>
  );
}

const CARD = "rounded-xl border border-line bg-panel p-4";
const TITLE = "text-[14px] font-semibold";
// "Nov 3" from YYYY-MM-DD
const short = (day: string) => localDate(day).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className={SECTION_LABEL}>{title}</h2>
      {children}
    </section>
  );
}

// how a change reads: "up" and "down" name the better direction, none for volumes where more is not better
type Judge = "up" | "down" | null;

// a null value has no data, unless `loading`
function Stat({ value, prev, label, hint, format = fmt, judge = null, points = false, note, loading = false }: {
  value: number | null;
  prev: number | null;
  label: string;
  hint: string;
  format?: (n: number) => string;
  judge?: Judge;
  // compare in percentage points, for rates
  points?: boolean;
  note?: string;
  loading?: boolean;
}) {
  let delta: { up: boolean; text: string } | null = null;
  if (value !== null && prev !== null) {
    if (points) {
      const pp = (value - prev) * 100;
      if (Math.abs(pp) >= 0.05) delta = { up: pp > 0, text: `${Math.abs(pp).toFixed(1)} pp` };
    } else if (prev) {
      const change = Math.round(((value - prev) / prev) * 100);
      // a near-empty previous period reads better as a multiple
      if (change) delta = { up: change > 0, text: change >= 1000 ? `${Math.round(value / prev)}×` : `${Math.abs(change)}%` };
    }
  }
  const tone = !delta || !judge ? "text-ink-muted" : delta.up === (judge === "up") ? "text-live" : "text-blocked";
  return (
    <div className={`${CARD} flex flex-col`} title={hint}>
      <div className={SECTION_LABEL}>{label}</div>
      <div className={`mt-1.5 text-[26px] font-semibold leading-tight tabular-nums ${value ? "" : "text-ink-faint"}`}>
        {loading
          ? <span title="asking GitHub / GitLab…">…</span>
          : value === null
          ? "—"
          : format(value)}
      </div>
      <div className="mt-1 flex min-h-[16px] flex-wrap gap-x-2 text-[11px] text-ink-faint">
        {delta && (
          <span className={`font-medium tabular-nums ${tone}`} title="vs the previous period">
            {delta.up ? "↗" : "↘"} {delta.text}
          </span>
        )}
        {value === null && !loading ? <span>no data in this period</span> : note && <span>{note}</span>}
      </div>
    </div>
  );
}

const GAP = 3;
// copper/25 on a white panel is as light as an empty cell
const LEVELS = ["bg-line", "bg-copper/35", "bg-copper/55", "bg-copper/75", "bg-copper"];

// one year of active days, GitHub-style, with the current and longest streaks
// `weeks` limits the grid; the streaks still count over the whole year
function Streak({ rows, today, weeks: span = 52, entries }: {
  rows: StatsRow[];
  today: string;
  weeks?: number;
  // worklog entries in the selected range
  entries: number;
}) {
  const { weeks, current, longest, months, level } = useMemo(() => {
    const perDay = new Map<string, number>();
    for (const r of rows) perDay.set(r.d, (perDay.get(r.d) ?? 0) + activity(r));
    const end = localDate(today);
    // start on the Monday 52 weeks back, so the last column holds today
    const back = 52 * 7 + ((end.getDay() + 6) % 7);
    const cells = Array.from({ length: back + 1 }, (_, i) => {
      const date = shift(today, back - i);
      return { date, n: perDay.get(date) ?? 0 };
    });
    const weeks: (typeof cells)[] = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    let longest = 0;
    let run = 0;
    for (const c of cells) {
      run = c.n > 0 ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    // today without activity yet does not break the streak
    let current = 0;
    for (let i = cells.length - 1 - (cells.at(-1)!.n > 0 ? 0 : 1); i >= 0 && cells[i].n > 0; i--) current++;
    const months = weeks.map((w, i) => {
      const first = localDate(w[0].date);
      const prev = i > 0 ? localDate(weeks[i - 1][0].date).getMonth() : -1;
      return first.getMonth() !== prev ? first.toLocaleString(undefined, { month: "short" }) : "";
    });
    return { weeks, current, longest, months, level: heatLevels(cells.map((c) => c.n)) };
  }, [rows, today]);
  const shown = weeks.slice(-span);
  const shownMonths = months.slice(-span);
  return (
    <div className={`${CARD} h-full`}>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className={TITLE}>{current} day streak</h3>
        <span className="text-[11px] text-ink-muted">
          longest {longest} day{longest === 1 ? "" : "s"} · active days, last {span} weeks · {entries} worklog entr{
            entries === 1 ? "y" : "ies"
          } this period
        </span>
      </div>
      {/* the last `shown` weeks, cells sized to fill the card's width */}
      <div
        className="grid text-[9.5px] leading-none text-ink-faint"
        style={{ gridTemplateColumns: `26px repeat(${shown.length}, minmax(0, 1fr))`, gap: GAP }}
      >
        <span />
        {shownMonths.map((m, i) => <span key={i} className="h-3 overflow-visible whitespace-nowrap text-[10px]">{m}</span>)}
        {["Mon", "", "Wed", "", "Fri", "", ""].map((l, row) => (
          <Fragment key={row}>
            <span className="self-center">{l}</span>
            {shown.map((w) => {
              const c = w[row];
              return c
                ? (
                  <span
                    key={c.date}
                    title={`${c.date}: ${c.n} prompt${c.n === 1 ? "" : "s"} and entries`}
                    className={`aspect-square max-h-[18px] rounded-[3px] ${LEVELS[level(c.n)]} ${
                      c.date === today ? "ring-1 ring-ink-muted" : ""
                    }`}
                  />
                )
                : <span key={`${w[0].date}:${row}`} />;
            })}
          </Fragment>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1 text-[10.5px] text-ink-faint">
        Less
        {LEVELS.map((l) => <span key={l} className={`h-[10px] w-[10px] rounded-[2px] ${l}`} />)}
        More
      </div>
    </div>
  );
}

function Bar({ share, color }: { share: number; color: string }) {
  return (
    <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-hover">
      <div className="h-full rounded-full" style={{ width: `${Math.max(2, share * 100)}%`, background: color }} />
    </div>
  );
}

// activity, cards done and cycle time per project; transcripts outside a project's repos fall under their folder
function ByProject({ rows, closed, board }: { rows: StatsRow[]; closed: View["closed"]; board: BoardData | null }) {
  const { items, total } = useMemo(() => {
    type Item = { key: string; name: string; icon: string | null; glyph: string; n: number; prompts: number; entries: number; done: number; cycle: number[]; cost: number | null };
    const by = new Map<string, Item>();
    const get = (p: string | null, repo: string | null) => {
      const project = p ? board?.projects.find((x) => x.id === p) : null;
      const name = project?.name ?? repo ?? "No project";
      // a deleted project's rows join "No project"
      const key = project ? project.id : `repo:${name}`;
      const cur = by.get(key) ??
        { key, name, icon: project?.icon ?? null, glyph: project ? "◎" : "◌", n: 0, prompts: 0, entries: 0, done: 0, cycle: [], cost: null };
      by.set(key, cur);
      return cur;
    };
    for (const r of rows) {
      const c = costOf(r);
      if (!activity(r) && !r.done && c === null) continue;
      const cur = get(r.p, r.r);
      if (c !== null) cur.cost = (cur.cost ?? 0) + c;
      cur.n += activity(r);
      cur.prompts += r.prompts;
      cur.entries += r.entries;
      cur.done += r.done;
    }
    for (const c of closed) get(c.p, null).cycle.push(c.days);
    const all = [...by.values()].filter((i) => i.n || i.done || i.cycle.length || i.cost);
    // shares over every project, before keeping the top ten
    return { items: all.sort((a, b) => b.n - a.n || b.done - a.done).slice(0, 10), total: all.reduce((t, i) => t + i.n, 0) };
  }, [rows, closed, board]);
  const COLS = "grid grid-cols-[minmax(0,30%)_minmax(0,1fr)_40px_56px_40px_44px] items-center gap-3";
  return (
    <div className={`${CARD} h-full`}>
      <h3 className={`${TITLE} mb-3`}>By project</h3>
      {items.length === 0 && <EmptyState block>No activity in this period.</EmptyState>}
      {items.length > 0 && (
        <div className="flex flex-col gap-2.5">
          <div className={`${COLS} ${SECTION_LABEL} text-right`}>
            <span />
            <span className="text-left" title="prompts + worklog entries">SHARE OF ACTIVITY</span>
            <span />
            <span title="estimated, this machine's transcripts">COST</span>
            <span>DONE</span>
            <span title="median days from first worklog entry to close">CYCLE</span>
          </div>
          {items.map((i) => {
            const cycle = median(i.cycle);
            return (
              <div key={i.key} className={`${COLS} text-[12.5px]`}>
                <span className="flex min-w-0 items-center gap-2 text-ink-soft" title={i.name}>
                  <span className="grid w-4 shrink-0 place-items-center">
                    <EntityIcon icon={i.icon} fallback={i.glyph} size={16} />
                  </span>
                  <span className="truncate">{i.name}</span>
                </span>
                <Bar share={total ? i.n / total : 0} color="var(--color-copper)" />
                <span
                  className="text-right text-[11px] tabular-nums text-ink-muted"
                  title={`${i.prompts} prompts, ${i.entries} worklog entries`}
                >
                  {total ? Math.round((i.n / total) * 100) : 0}%
                </span>
                <span className="text-right text-[11px] tabular-nums text-ink-muted">
                  {i.cost === null ? <span className="text-ink-faint">—</span> : usd(i.cost)}
                </span>
                <span className={`text-right text-[11px] tabular-nums ${i.done ? "text-ink-muted" : "text-ink-faint"}`}>
                  {i.done}
                </span>
                <span
                  className="text-right text-[11px] tabular-nums text-ink-muted"
                  title={cycle === null ? "no card closed" : `median of ${i.cycle.length} card${i.cycle.length === 1 ? "" : "s"}`}
                >
                  {cycle === null ? <span className="text-ink-faint">—</span> : dayCount(cycle)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

type View = {
  models: string[];
  cur: StatsRow[];
  prevRows: StatsRow[];
  cards: CardUsage[];
  prevCards: CardUsage[];
  closed: { s: string; p: string | null; d: string; days: number }[];
  prevClosed: { s: string; p: string | null; d: string; days: number }[];
  agentTime: { d: string; a: string; ms: number }[];
  parallel: { d: string; peak: number; ms: number }[];
  prevParallel: { d: string; peak: number; ms: number }[];
  prevAgentTime: { d: string; a: string; ms: number }[];
  totals: Totals;
  prev: Totals;
  hasPrev: boolean;
};

const dayCount = (n: number) => (n < 1 ? `${Math.round(n * 24)}h` : `${n.toFixed(n < 10 ? 1 : 0)}d`);
const hours = (ms: number) => ms / 3_600_000;
// one decimal near the ends, where rounding would read as 0% or 100%
const pct = (n: number) => `${(n * 100).toFixed(n > 0.99 || n < 0.01 ? 1 : 0)}%`;

// share of input served from cache, this machine's transcripts only
const cacheRate = (rows: StatsRow[]) => {
  let cached = 0, input = 0;
  for (const r of rows) {
    if (!r.out && !r.cached) continue;
    cached += r.cached;
    input += r.tokens - r.out;
  }
  return cached + input ? cached / (cached + input) : null;
};

// per card with agent work: median over cards of a per-card total
const perCard = (rows: CardUsage[], value: (r: CardUsage) => number | null) => {
  const by = new Map<string, number>();
  for (const r of rows) {
    const v = value(r);
    if (v) by.set(r.s, (by.get(r.s) ?? 0) + v);
  }
  return { median: median([...by.values()]), n: by.size };
};
const cards = (n: number) => `median of ${n} card${n === 1 ? "" : "s"}`;

type TileKey =
  | "prompts"
  | "tokens"
  | "agentHours"
  | "parallel"
  | "done"
  | "merged"
  | "cycle"
  | "promptsPerCard"
  | "cost"
  | "costPerCard"
  | "tokensPerCard"
  | "cache";

// a row of four stat tiles, picked from every number Insights computes
function Tiles({ view, pick, prsLoading }: { view: View; pick: TileKey[]; prsLoading: boolean }) {
  const prev = (n: number | null) => (view.hasPrev ? n : null);
  const ms = (xs: View["agentTime"]) => xs.reduce((t, r) => t + r.ms, 0);
  const byAgent = new Map<string, number>();
  for (const r of view.agentTime) byAgent.set(r.a, (byAgent.get(r.a) ?? 0) + r.ms);
  const cost = costSum(view.cur);
  const costCard = perCard(view.cards, costOf);
  const tokensCard = perCard(view.cards, (r) => r.tokens);
  const promptsCard = perCard(view.cards, (r) => r.prompts);
  const all: Record<TileKey, Parameters<typeof Stat>[0]> = {
    prompts: {
      label: "PROMPTS",
      value: view.totals.prompts,
      prev: prev(view.prev.prompts),
      hint: "messages you typed to Claude Code, Codex and Vibe",
    },
    tokens: {
      label: "TOKENS",
      value: view.totals.tokens,
      prev: prev(view.prev.tokens),
      hint: "agent input + output tokens, cache reads excluded",
    },
    agentHours: {
      label: "AGENT HOURS",
      value: hours(ms(view.agentTime)),
      prev: prev(hours(ms(view.prevAgentTime))),
      format: (n) => (n < 10 ? n.toFixed(1) : fmt(Math.round(n))),
      hint: "time agents spent on cards, from presence",
      note: [...byAgent.entries()].sort((x, y) => y[1] - x[1]).map(([a, t]) => `${a} ${hours(t).toFixed(1)}h`)
        .join(" · ") || undefined,
    },
    parallel: {
      label: "PARALLEL AGENTS",
      value: view.parallel.length ? Math.max(...view.parallel.map((p) => p.peak)) : null,
      prev: prev(view.prevParallel.length ? Math.max(...view.prevParallel.map((p) => p.peak)) : null),
      hint: "most agents working on cards at the same time, from presence",
      note: view.parallel.length
        ? `peak · ${hours(view.parallel.reduce((t, p) => t + p.ms, 0)).toFixed(1)}h with 2+ at once`
        : undefined,
    },
    done: {
      label: "CARDS DONE",
      value: view.totals.done,
      prev: prev(view.prev.done),
      judge: "up",
      hint: "cards in a done column, by the day they were closed; reopened: cards moved back out of one",
      note: `${view.totals.reopened} reopened`,
    },
    merged: {
      label: "PRS MERGED",
      value: view.totals.merged,
      prev: prev(view.prev.merged),
      judge: "up",
      loading: prsLoading,
      hint: "your GitHub PRs and GitLab MRs merged, by merge date",
      note: `${view.totals.prs} card${view.totals.prs === 1 ? "" : "s"} with a PR`,
    },
    cycle: {
      label: "CYCLE TIME",
      value: median(view.closed.map((c) => c.days)),
      prev: prev(median(view.prevClosed.map((c) => c.days))),
      format: dayCount,
      judge: "down",
      hint: "median time from a card's first worklog event to its close",
      note: cards(view.closed.length),
    },
    promptsPerCard: {
      label: "PROMPTS / CARD",
      value: promptsCard.median,
      prev: prev(perCard(view.prevCards, (r) => r.prompts).median),
      judge: "down",
      hint: "prompts you sent per card, over cards with a linked transcript",
      note: cards(promptsCard.n),
    },
    cost: {
      label: "EST. COST",
      value: cost.usd,
      prev: prev(costSum(view.prevRows).usd),
      format: usd,
      hint: "list-price estimate of this machine's Claude tokens, cache reads and writes included",
      note: cost.covered < 0.995 ? `covers ${pct(cost.covered)} of tokens` : "at list prices",
    },
    costPerCard: {
      label: "COST / CARD",
      value: costCard.median,
      prev: prev(perCard(view.prevCards, costOf).median),
      format: usd,
      judge: "down",
      hint: "estimated cost of each card's linked transcripts",
      note: cards(costCard.n),
    },
    tokensPerCard: {
      label: "TOKENS / CARD",
      value: tokensCard.median,
      prev: prev(perCard(view.prevCards, (r) => r.tokens).median),
      judge: "down",
      hint: "tokens of each card's linked transcripts, subagents included",
      note: cards(tokensCard.n),
    },
    cache: {
      label: "CACHE HIT RATE",
      value: cacheRate(view.cur),
      prev: prev(cacheRate(view.prevRows)),
      format: pct,
      judge: "up",
      points: true,
      hint: "share of agent input served from the prompt cache, this machine's transcripts",
    },
  };
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {pick.map((k) => <Stat key={k} {...all[k]} />)}
    </div>
  );
}

const SERIES = [1, 2, 3, 4, 5].map((n) => `var(--color-chart-${n})`);
const OTHER = "var(--color-ink-faint)";

// tokens over time stacked by model, next to the agents and models that spent them
function Models({ rows, models, from, today, daily }: {
  rows: StatsRow[];
  models: string[];
  from: string;
  today: string;
  daily: boolean;
}) {
  const color = (m: string) => (models.includes(m) ? SERIES[models.indexOf(m)] : OTHER);
  const { keys, bars, agents, total } = useMemo(() => {
    const { keys, buckets } = modelMix(rows, models, daily ? (d) => d : weekOf);
    const by = new Map(buckets);
    // every day or week of the range, empty ones included, so gaps read as gaps
    const bars: [string, Map<string, number>][] = [];
    const step = daily ? 1 : 7;
    for (let d = daily ? from : weekOf(from); d <= today; d = shift(d, -step)) bars.push([d, by.get(d) ?? new Map()]);
    type Agent = { prompts: number; tokens: number; models: Map<string, { tokens: number; rows: StatsRow[] }> };
    const agents = new Map<string, Agent>();
    for (const r of rows) {
      const a = agents.get(r.a) ?? { prompts: 0, tokens: 0, models: new Map() };
      a.prompts += r.prompts;
      a.tokens += r.tokens;
      if (r.m && r.tokens) {
        const m = a.models.get(r.m) ?? { tokens: 0, rows: [] };
        m.tokens += r.tokens;
        m.rows.push(r);
        a.models.set(r.m, m);
      }
      agents.set(r.a, a);
    }
    return {
      keys,
      bars,
      agents: [...agents.entries()].filter(([, a]) => a.tokens > 0).sort((a, b) => b[1].tokens - a[1].tokens),
      total: rows.reduce((t, r) => t + r.tokens, 0),
    };
  }, [rows, models, from, today, daily]);
  const sumOf = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...bars.map(([, m]) => sumOf(m)));
  const every = Math.max(1, Math.ceil(bars.length / 6));
  const per = daily ? "per day" : "per week";
  return (
    <div className={CARD}>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className={TITLE}>Agents and models</h3>
        {total > 0 && <span className="text-[11px] text-ink-muted">{fmt(total)} tokens, {per}</span>}
      </div>
      {total === 0 && <EmptyState block>No agent tokens in this period.</EmptyState>}
      {total > 0 && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="flex min-w-0 flex-col">
            <div className="text-[10.5px] tabular-nums text-ink-faint">{fmt(max)}</div>
            <div
              className="flex h-[150px] items-end gap-[2px] border-b border-line"
              role="img"
              aria-label={`tokens ${per}, stacked by model`}
            >
              {bars.map(([d, m]) => {
                const sum = sumOf(m);
                const shown = keys.filter((k) => m.get(k));
                const head = `${daily ? short(d) : `week of ${short(d)}`}: ${fmt(sum)} tokens`;
                return (
                  <div
                    key={d}
                    className="flex h-full min-w-0 flex-1 flex-col justify-end hover:opacity-80"
                    title={[head, ...shown.map((k) => `${k}: ${fmt(m.get(k)!)}`)].join("\n")}
                  >
                    <div className="flex flex-col-reverse gap-[2px]" style={{ height: `${(sum / max) * 100}%` }}>
                      {shown.map((k, i) => (
                        <div
                          key={k}
                          className={i === shown.length - 1 ? "rounded-t-[3px]" : ""}
                          style={{ flexGrow: m.get(k), flexBasis: 0, minHeight: 2, background: color(k) }}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-1 flex gap-[2px] text-[10.5px] text-ink-faint">
              {bars.map(([d], i) => (
                <span key={d} className="min-w-0 flex-1 overflow-visible whitespace-nowrap">
                  {i % every === 0 ? short(d) : ""}
                </span>
              ))}
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            {agents.map(([name, a]) => (
              <div key={name} className="flex flex-col gap-1">
                <div className="flex items-center gap-2 text-[12.5px]">
                  {name === "you"
                    ? <span className="h-3.5 w-3.5 shrink-0 rounded-full bg-chipline" />
                    : <AgentIcon a={{ harness: name, icon: null }} />}
                  <span className="font-medium capitalize text-ink">{name}</span>
                  <span className="ml-auto text-[11px] tabular-nums text-ink-muted">
                    {a.prompts > 0 && `${fmt(a.prompts)} prompts · `}
                    {Math.round((a.tokens / total) * 100)}% of tokens
                  </span>
                </div>
                {[...a.models.entries()].sort((x, y) => y[1].tokens - x[1].tokens).slice(0, 6).map(([model, m]) => {
                  const c = costSum(m.rows);
                  return (
                    <div
                      key={model}
                      className="grid grid-cols-[10px_minmax(0,1fr)_48px_52px] items-center gap-2 pl-5.5 text-[11.5px]"
                    >
                      <span className="h-2 w-2 rounded-[2px]" style={{ background: color(model) }} />
                      <span className="truncate text-ink-muted" title={model}>{model}</span>
                      <span className="text-right tabular-nums text-ink-soft">{fmt(m.tokens)}</span>
                      <span className="text-right tabular-nums text-ink-faint" title="estimated cost at list prices">
                        {c.covered > 0 ? usd(c.usd) : "—"}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// cards ranked by the cost or tokens of their linked transcripts, subagents included
const RANK_BY = [
  { value: "cost", label: "Est. cost" },
  { value: "tokens", label: "Tokens" },
];

function TopCards({ rows, local, board, onOpenSession }: {
  rows: CardUsage[];
  // this machine's usage rows, card-linked or not
  local: StatsRow[];
  board: BoardData | null;
  onOpenSession: (id: string) => void;
}) {
  const [rank, setRank] = useLocalStorage("trame:insightsRankCards", "cost", STRING_CODEC);
  const all = useMemo(() => {
    const by = new Map<string, { tokens: number; prompts: number; sub: number; cost: number | null }>();
    for (const r of rows) {
      const cur = by.get(r.s) ?? { tokens: 0, prompts: 0, sub: 0, cost: null };
      const c = costOf(r);
      by.set(r.s, {
        tokens: cur.tokens + r.tokens,
        prompts: cur.prompts + r.prompts,
        sub: cur.sub + (r.sub ?? 0),
        cost: c === null ? cur.cost : (cur.cost ?? 0) + c,
      });
    }
    return [...by.entries()].filter(([, c]) => c.tokens > 0);
  }, [rows]);
  const byCost = rank === "cost";
  // unpriced cards rank last by cost
  const key = (c: { tokens: number; cost: number | null }) => (byCost ? c.cost ?? -1 : c.tokens);
  const top = [...all].sort((a, b) => key(b[1]) - key(a[1]) || b[1].tokens - a[1].tokens).slice(0, 10);
  const max = Math.max(1e-9, ...top.map(([, c]) => key(c)));
  // the same three facts in the ranked unit
  const metric = (c: { tokens: number; cost: number | null }) => (byCost ? c.cost ?? 0 : c.tokens);
  const show = (n: number) => (byCost ? usd(n) : `${fmt(n)} tokens`);
  const linked = all.reduce((t, [, c]) => t + metric(c), 0);
  // cards with a value in the ranked unit; unpriced cards have no cost
  const values = all.map(([, c]) => metric(c)).filter((v) => v > 0).sort((a, b) => b - a);
  const top3 = values.slice(0, 3).reduce((a, b) => a + b, 0);
  const open = new Set(board?.statuses.filter((x) => !x.terminal).map((x) => x.key));
  const inFlight = all
    .filter(([id]) => open.has(board?.sessions.find((x) => x.id === id)?.status ?? ""))
    .reduce((t, [, c]) => t + metric(c), 0);
  const machine = byCost ? costSum(local).usd : local.reduce((t, r) => t + r.tokens, 0);
  const untracked = Math.max(0, machine - linked);
  const COLS = "grid grid-cols-[minmax(0,36%)_minmax(0,1fr)_60px_60px_56px_64px] items-center gap-3";
  const col = (active: boolean) => `text-right tabular-nums ${active ? "font-medium text-ink" : "text-ink-faint"}`;
  return (
    <div className={CARD}>
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className={TITLE}>{byCost ? "Most costly cards" : "Cards by tokens"}</h3>
        {all.length > 0 && (
          <span className="text-[11px] text-ink-muted">
            {all.length} card{all.length === 1 ? "" : "s"} with agent work
          </span>
        )}
        <div className="ml-auto">
          <SegToggle options={RANK_BY} value={rank} onChange={setRank} />
        </div>
      </div>
      {linked > 0 && (
        <div className="mb-4 grid grid-cols-1 gap-3 sm:auto-cols-fr sm:grid-flow-col">
          {/* with three cards or fewer the top three hold everything */}
          {values.length > 3 && (
            <Fact value={pct(top3 / linked)} label="on the top 3 cards" hint="share of card-linked spend on the most costly cards" />
          )}
          <Fact
            value={show(inFlight)}
            label="on cards still open"
            hint="spend on cards not in a done column yet; it can still grow"
          />
          <Fact
            value={show(untracked)}
            label={`not linked to a card · ${machine ? pct(untracked / machine) : "0%"}`}
            hint="this machine's transcripts no card links to: work you did but didn't track"
          />
        </div>
      )}
      {top.length === 0 && <EmptyState block>No card-linked agent work in this period.</EmptyState>}
      {top.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className={`${COLS} ${SECTION_LABEL} text-right`}>
            <span />
            <span />
            <span>COST</span>
            <span>TOKENS</span>
            <span>PROMPTS</span>
            <span title="share of the card's tokens spent in Claude subagents">SUBAGENTS</span>
          </div>
          {top.map(([id, c]) => {
            const s = board?.sessions.find((x) => x.id === id);
            const p = s?.client_id ? board?.projects.find((x) => x.id === s.client_id) : null;
            const st = s ? board?.statuses.find((x) => x.key === s.status) : undefined;
            return (
              <div key={id} className={`${COLS} text-[12.5px]`}>
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-2 text-left text-ink-soft hover:underline"
                  title={s?.title}
                  onClick={() => onOpenSession(id)}
                >
                  <span className="grid w-4 shrink-0 place-items-center">
                    <EntityIcon icon={p?.icon ?? null} fallback={p ? "◎" : "◌"} size={14} />
                  </span>
                  <span className="truncate">{s?.title ?? "Deleted card"}</span>
                  {st && (
                    <span className="shrink-0 rounded-full border px-1.5 text-[10.5px]" style={{ color: st.color }}>
                      {st.label.toLowerCase()}
                    </span>
                  )}
                </button>
                {key(c) > 0 ? <Bar share={key(c) / max} color="var(--color-copper)" /> : <span />}
                <span className={col(byCost)} title={c.cost === null ? "no priced model" : undefined}>
                  {c.cost === null ? "—" : usd(c.cost)}
                </span>
                <span className={col(!byCost)}>{fmt(c.tokens)}</span>
                <span className={col(false)}>{c.prompts ? fmt(c.prompts) : "—"}</span>
                <span className={col(false)}>{c.sub ? pct(c.sub / c.tokens) : "—"}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// a headline number with what it measures, for inside a panel
function Fact({ value, label, hint }: { value: string; label: string; hint: string }) {
  return (
    <div className="rounded-lg bg-hover px-3 py-2" title={hint}>
      <div className="text-[16px] font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] text-ink-muted">{label}</div>
    </div>
  );
}

const PARTS: { key: keyof CostParts; label: string; color: string }[] = [
  { key: "read", label: "Cache reads", color: "var(--color-chart-1)" },
  { key: "write", label: "Cache writes", color: "var(--color-chart-2)" },
  { key: "input", label: "Input", color: "var(--color-chart-3)" },
  { key: "out", label: "Output", color: "var(--color-chart-4)" },
];

// this month's spend and its pace, and which kind of token the period's money went to
function Spend({ rows, cur, today }: { rows: StatsRow[]; cur: StatsRow[]; today: string }) {
  const b = useMemo(() => burn(rows, today), [rows, today]);
  const parts = useMemo(() => costParts(cur), [cur]);
  const total = PARTS.reduce((t, p) => t + parts[p.key], 0);
  const month = localDate(today).toLocaleDateString(undefined, { month: "long" });
  return (
    <div className={CARD}>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="flex flex-col gap-3">
          <h3 className={TITLE}>{month} spend</h3>
          <div className="grid grid-cols-3 gap-3">
            <Fact value={usd(b.mtd)} label="so far" hint="estimated, this machine's Claude transcripts" />
            <Fact value={usd(b.projected)} label="on pace for" hint="month-to-date spend, extended at the same daily rate" />
            <Fact value={usd(b.last)} label="last month" hint="last calendar month's estimated spend" />
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <h3 className={TITLE}>Where the money goes <span className="text-[11px] font-normal text-ink-muted">this period</span></h3>
          {total === 0 && <EmptyState block>No priced agent tokens in this period.</EmptyState>}
          {total > 0 && (
            <>
              <div className="flex h-3 gap-[2px] overflow-hidden rounded-full" role="img" aria-label="cost by kind of token">
                {PARTS.filter((p) => parts[p.key] > 0).map((p) => (
                  <div
                    key={p.key}
                    title={`${p.label}: ${usd(parts[p.key])}`}
                    style={{ flexGrow: parts[p.key], flexBasis: 0, minWidth: 3, background: p.color }}
                  />
                ))}
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[11.5px]">
                {PARTS.map((p) => (
                  <span key={p.key} className="flex items-center gap-1.5 whitespace-nowrap text-ink-muted">
                    <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: p.color }} />
                    {p.label}
                    <span className="ml-auto tabular-nums text-ink-soft">{usd(parts[p.key])}</span>
                    <span className="w-9 text-right tabular-nums text-ink-faint">{pct(parts[p.key] / total)}</span>
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// prompts by weekday and local hour
function Hours({ rows }: { rows: { d: string; h: number; n: number }[] }) {
  const grid = useMemo(() => hourGrid(rows), [rows]);
  const { max, level, peak } = useMemo(() => {
    const flat = grid.flat();
    const max = Math.max(0, ...flat);
    const i = flat.indexOf(max);
    return { max, level: heatLevels(flat), peak: { wd: Math.floor(i / 24), h: i % 24 } };
  }, [grid]);
  return (
    <div className={`${CARD} h-full`}>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className={TITLE}>When you prompt</h3>
        {max > 0 && (
          <span className="text-[11px] text-ink-muted">
            busiest {WEEKDAYS[peak.wd]} {String(peak.h).padStart(2, "0")}:00 · {max} prompt{max === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {max === 0 && <EmptyState block>No prompts in this period.</EmptyState>}
      {max > 0 && (
        <div className="grid grid-cols-[28px_repeat(24,minmax(0,1fr))] gap-[3px] text-[10px] text-ink-faint">
          {grid.map((row, wd) => (
            <Fragment key={wd}>
              <span className="leading-[14px]">{WEEKDAYS[wd]}</span>
              {row.map((n, h) => (
                <div
                  key={h}
                  className={`h-[14px] rounded-[3px] ${LEVELS[level(n)]}`}
                  title={`${WEEKDAYS[wd]} ${String(h).padStart(2, "0")}:00 — ${n} prompt${n === 1 ? "" : "s"}`}
                />
              ))}
            </Fragment>
          ))}
          <span />
          {Array.from({ length: 24 }, (_, h) => (
            <span key={h} className="text-center">{h % 6 === 0 ? h : ""}</span>
          ))}
        </div>
      )}
      {max > 0 && (
        <div className="mt-2 flex items-center gap-1 text-[10.5px] text-ink-faint">
          Less {LEVELS.map((l) => <span key={l} className={`h-2.5 w-2.5 rounded-[2px] ${l}`} />)} More
        </div>
      )}
    </div>
  );
}

const STALE_DAYS = 7;

// open cards nobody touched for a week, most recently stalled first
function Stalled({ board, onOpenSession }: { board: BoardData | null; onOpenSession: (id: string) => void }) {
  const items = useMemo(() => {
    if (!board) return [];
    const open = new Set(board.statuses.filter((s) => !s.terminal).map((s) => s.key));
    const cutoff = Date.now() - STALE_DAYS * 86_400_000;
    return board.sessions
      .filter((s) => open.has(s.status) && Date.parse(s.last_touched) < cutoff)
      .sort((a, b) => Date.parse(b.last_touched) - Date.parse(a.last_touched));
  }, [board]);
  return (
    <div className={`${CARD} h-full`}>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className={TITLE}>Stalled cards</h3>
        <span className="text-[11px] text-ink-muted" title="the board now, whatever the range">
          right now · open, untouched for {STALE_DAYS}+ days{items.length > 0 && ` · ${items.length}`}
        </span>
      </div>
      {items.length === 0 && <EmptyState block>Nothing stalled.</EmptyState>}
      <div className="flex flex-col gap-1.5">
        {items.slice(0, 8).map((s) => {
          const p = s.client_id ? board?.projects.find((x) => x.id === s.client_id) : null;
          const st = board?.statuses.find((x) => x.key === s.status);
          const idle = Math.floor((Date.now() - Date.parse(s.last_touched)) / 86_400_000);
          return (
            <button
              key={s.id}
              type="button"
              className="flex items-center gap-2 text-left text-[12.5px] text-ink-soft hover:underline"
              onClick={() => onOpenSession(s.id)}
            >
              <span className="grid w-4 shrink-0 place-items-center">
                <EntityIcon icon={p?.icon ?? null} fallback={p ? "◎" : "◌"} size={14} />
              </span>
              <span className="min-w-0 truncate">{s.title}</span>
              {st && (
                <span className="shrink-0 rounded-full border px-1.5 text-[10.5px]" style={{ color: st.color }}>
                  {st.label.toLowerCase()}
                </span>
              )}
              <span className="ml-auto shrink-0 text-[11px] tabular-nums text-ink-faint">{idle}d idle</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
