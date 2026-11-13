import { Fragment, useEffect, useMemo, useState } from "react";
import { AgentIcon } from "../agents/agents";
import { type BoardData, getStats, type StatsRow } from "../api";
import { clientColor, EmptyState, EntityIcon, SECTION_LABEL, SegToggle, STRING_CODEC, useLocalStorage } from "../ui/ui";

const RANGES = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
];
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const fmt = (n: number) => (n < 10_000 ? n.toLocaleString() : compact.format(n));
const DAY_MS = 86_400_000;

// local YYYY-MM-DD, n days before `today` (also YYYY-MM-DD)
function shift(today: string, n: number): string {
  const [y, m, d] = today.split("-").map(Number);
  const t = new Date(y, m - 1, d - n);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

type Totals = { prompts: number; tokens: number; entries: number; done: number; prs: number; merged: number };
const ZERO: Totals = { prompts: 0, tokens: 0, entries: 0, done: 0, prs: 0, merged: 0 };
const sum = (rows: StatsRow[]) =>
  rows.reduce<Totals>(
    (t, r) => ({
      prompts: t.prompts + r.prompts,
      tokens: t.tokens + r.tokens,
      entries: t.entries + r.entries,
      done: t.done + r.done,
      prs: t.prs + r.prs,
      merged: t.merged + r.merged,
    }),
    ZERO,
  );
// a day counts as active when you prompted an agent or logged work
const activity = (r: StatsRow) => r.prompts + r.entries;

// Insights: what you and your agents did, from the worklog, cards and the Claude/Codex transcripts on this machine.
export function Insights({ board }: { board: BoardData | null }) {
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
    const t = setTimeout(() => void getStats().then(setData, () => {}), 5000);
    return () => clearTimeout(t);
  }, [data, pending]);

  const days = Number(range);
  const view = useMemo(() => {
    if (!data) return null;
    const from = shift(data.today, days - 1);
    const prevFrom = shift(data.today, 2 * days - 1);
    const cur = data.rows.filter((r) => r.d >= from);
    const prev = data.rows.filter((r) => r.d >= prevFrom && r.d < from);
    return { cur, totals: sum(cur), prev: sum(prev), hasPrev: data.rows.some((r) => r.d < from) };
  }, [data, days]);

  if (error) return <EmptyState page>Could not load stats: {error}</EmptyState>;
  if (!data || !view) return <EmptyState page>Reading the worklog and agent transcripts…</EmptyState>;

  const headline: { key: keyof Totals; label: string; hint: string }[] = [
    { key: "prompts", label: "PROMPTS SENT", hint: "messages you typed to Claude Code and Codex" },
    { key: "tokens", label: "TOKENS", hint: "agent input + output tokens, cache reads excluded" },
    { key: "entries", label: "WORKLOG ENTRIES", hint: "track and log entries on cards" },
    { key: "done", label: "CARDS DONE", hint: "cards in a done column, by last activity" },
    { key: "merged", label: "PRS MERGED", hint: "your GitHub PRs and GitLab MRs merged, by merge date" },
    { key: "prs", label: "CARDS WITH A PR", hint: "cards with a pull request, by last activity" },
  ];
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-5 px-6 py-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="ml-auto flex items-center gap-1">
            <SegToggle options={RANGES} value={range} onChange={setRange} />
          </div>
        </div>
        {/* two columns: numbers and projects | streak and agents */}
        <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
          <div className="flex min-w-0 flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              {headline.map((h) => (
                <Stat
                  key={h.key}
                  value={h.key === "merged" && data.prs.pending && !data.prs.fetched ? null : view.totals[h.key]}
                  prev={view.hasPrev ? view.prev[h.key] : null}
                  label={h.label}
                  hint={h.hint}
                />
              ))}
            </div>
            <ByProject rows={view.cur} board={board} />
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <Streak rows={data.rows} today={data.today} weeks={26} />
            <ByAgent rows={view.cur} />
          </div>
        </div>
        <p className="text-[11px] text-ink-faint">
          Prompts and tokens come from the {fmt(data.scan.files)} Claude Code and Codex transcripts on this machine
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

// a null value is still loading
function Stat({ value, prev, label, hint }: { value: number | null; prev: number | null; label: string; hint: string }) {
  const change = prev && value !== null ? Math.round(((value - prev) / prev) * 100) : null;
  return (
    <div className={CARD} title={hint}>
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        <div className="text-[26px] font-semibold leading-tight tabular-nums">
          {value === null ? <span className="text-ink-faint" title="asking GitHub / GitLab…">…</span> : fmt(value)}
        </div>
        {change !== null && change !== 0 && (
          <span
            className={`ml-auto shrink-0 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10.5px] font-medium ${
              change > 0 ? "bg-chip-active-bg text-active" : "bg-hover text-ink-muted"
            }`}
            title="vs the previous period"
          >
            {/* a near-empty previous period reads better as a multiple */}
            {change > 0 ? "↗" : "↘"} {change >= 1000 ? `${Math.round(value! / prev!)}×` : `${Math.abs(change)}%`}
          </span>
        )}
      </div>
      <div className={`${SECTION_LABEL} mt-1`}>{label}</div>
    </div>
  );
}

const GAP = 3;
const LEVELS = ["bg-line", "bg-copper/25", "bg-copper/50", "bg-copper/75", "bg-copper"];

// one year of active days, GitHub-style, with the current and longest streaks
// `weeks` limits the grid; the streaks still count over the whole year
function Streak({ rows, today, weeks: span = 52 }: { rows: StatsRow[]; today: string; weeks?: number }) {
  const { weeks, current, longest, months, max } = useMemo(() => {
    const perDay = new Map<string, number>();
    for (const r of rows) perDay.set(r.d, (perDay.get(r.d) ?? 0) + activity(r));
    const [y, m, d] = today.split("-").map(Number);
    const end = new Date(y, m - 1, d);
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
      const first = new Date(new Date(w[0].date).getTime() + DAY_MS / 2);
      const prev = i > 0 ? new Date(weeks[i - 1][0].date).getMonth() : -1;
      return first.getMonth() !== prev ? first.toLocaleString(undefined, { month: "short" }) : "";
    });
    const max = Math.max(1, ...cells.map((c) => c.n));
    return { weeks, current, longest, months, max };
  }, [rows, today]);
  const level = (n: number) => (n === 0 ? 0 : Math.min(4, 1 + Math.floor((n / max) * 3.999)));
  const shown = weeks.slice(-span);
  const shownMonths = months.slice(-span);
  return (
    <div className={CARD}>
      <div className="mb-3 flex flex-wrap items-baseline gap-3">
        <h2 className="text-[18px] font-semibold">{current} day streak</h2>
        <span className={`${SECTION_LABEL} ml-auto`}>LONGEST STREAK · {longest} DAY{longest === 1 ? "" : "S"}</span>
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

// share of activity (prompts + worklog entries) per project; transcripts outside a project's repos fall under their folder
function ByProject({ rows, board }: { rows: StatsRow[]; board: BoardData | null }) {
  const items = useMemo(() => {
    const by = new Map<
      string,
      { name: string; icon: string | null; glyph: string; color: string; n: number; prompts: number; entries: number }
    >();
    for (const r of rows) {
      const n = activity(r);
      if (!n) continue;
      const project = r.p ? board?.projects.find((p) => p.id === r.p) : null;
      const name = project?.name ?? r.r ?? "No project";
      const key = r.p ?? `repo:${name}`;
      const cur = by.get(key) ??
        { name, icon: project?.icon ?? null, glyph: project ? "◎" : "◌", color: project ? clientColor(project.name, project.color) : "var(--color-ink-faint)", n: 0, prompts: 0, entries: 0 };
      by.set(key, { ...cur, n: cur.n + n, prompts: cur.prompts + r.prompts, entries: cur.entries + r.entries });
    }
    return [...by.values()].sort((a, b) => b.n - a.n).slice(0, 10);
  }, [rows, board]);
  const total = items.reduce((t, i) => t + i.n, 0);
  const max = Math.max(1, ...items.map((i) => i.n));
  return (
    <div className={CARD}>
      <h2 className="mb-3 text-[15px] font-semibold">By project</h2>
      {items.length === 0 && <EmptyState block>No activity in this period.</EmptyState>}
      <div className="flex flex-col gap-2.5">
        {items.map((i) => (
          <div key={i.name} className="flex items-center gap-3 text-[12.5px]">
            <span className="flex w-[34%] min-w-0 items-center gap-2 text-ink-soft" title={i.name}>
              <span className="grid w-4 shrink-0 place-items-center">
                <EntityIcon icon={i.icon} fallback={i.glyph} size={16} />
              </span>
              <span className="truncate">{i.name}</span>
            </span>
            <Bar share={i.n / max} color={i.color} />
            <span
              className="w-[92px] shrink-0 text-right text-[11px] tabular-nums text-ink-muted"
              title={`${i.prompts} prompts, ${i.entries} worklog entries`}
            >
              {Math.round((i.n / total) * 100)}% · {fmt(i.n)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// tokens per agent and model, with each agent's prompts and worklog entries
function ByAgent({ rows }: { rows: StatsRow[] }) {
  const agents = useMemo(() => {
    const by = new Map<string, { prompts: number; entries: number; tokens: number; models: Map<string, number> }>();
    for (const r of rows) {
      const cur = by.get(r.a) ?? { prompts: 0, entries: 0, tokens: 0, models: new Map() };
      cur.prompts += r.prompts;
      cur.entries += r.entries;
      cur.tokens += r.tokens;
      if (r.m && r.tokens) cur.models.set(r.m, (cur.models.get(r.m) ?? 0) + r.tokens);
      by.set(r.a, cur);
    }
    return [...by.entries()]
      .filter(([, a]) => a.prompts + a.entries + a.tokens > 0)
      .sort((a, b) => b[1].tokens - a[1].tokens || b[1].entries - a[1].entries);
  }, [rows]);
  const maxTokens = Math.max(1, ...agents.flatMap(([, a]) => [...a.models.values()]));
  return (
    <div className={CARD}>
      <h2 className="mb-3 text-[15px] font-semibold">By agent and model</h2>
      {agents.length === 0 && <EmptyState block>No activity in this period.</EmptyState>}
      <div className="flex flex-col gap-4">
        {agents.map(([name, a]) => (
          <div key={name} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 text-[12.5px]">
              {name === "you"
                ? <span className="h-3.5 w-3.5 shrink-0 rounded-full bg-chipline" />
                : <AgentIcon a={{ harness: name, icon: null }} />}
              <span className="font-medium capitalize text-ink">{name}</span>
              <span className="ml-auto text-[11px] tabular-nums text-ink-muted">
                {[
                  a.prompts && `${fmt(a.prompts)} prompts`,
                  a.entries && `${fmt(a.entries)} entries`,
                  a.tokens && `${fmt(a.tokens)} tokens`,
                ].filter(Boolean).join(" · ")}
              </span>
            </div>
            {[...a.models.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([model, tokens]) => (
              <div key={model} className="flex items-center gap-3 pl-5.5 text-[11.5px]">
                <span className="w-[34%] truncate text-ink-muted" title={model}>{model}</span>
                <Bar share={tokens / maxTokens} color="var(--color-copper)" />
                <span className="w-[52px] shrink-0 text-right tabular-nums text-ink-faint">{fmt(tokens)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
