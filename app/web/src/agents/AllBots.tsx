import type { ReactNode } from "react";
import { Button, EmptyState, ErrorNote, timeAgo } from "../ui/ui";
import { type Bot, botRuns, botsActivity, type BotRun, useBots, usePoll } from "./bot-api";
import { BotAvatar, Glyph } from "./bot-faces";
import { heatLevel, mondayMark, pct, sumSources } from "./bot-stats";
import { CARD, SOURCE } from "./BotPage";

const DAYS = 28;
const LEVEL = ["", "0.35", "0.6", "0.95"];
const LEVEL_LIGHT = ["", "45%", "50%", "58%"];
const COLS = { gridTemplateColumns: `150px repeat(${DAYS}, minmax(0, 1fr)) 56px` };

// Every bot over four weeks: a heatmap per bot, outcomes, where work comes from, what needs you.
export function AllBots({ onOpenBot, onOpenRun, onNew }: {
  onOpenBot: (bot: string) => void;
  onOpenRun: (run: string) => void;
  onNew: () => void;
}) {
  const { bots, loaded } = useBots(true);
  const activity = usePoll(() => botsActivity(DAYS), 30_000, "activity");
  const busy = bots.filter((b) => b.working > 0);
  const waiting = usePoll(
    () => Promise.all(busy.map((b) => botRuns(b.id, 20).then((rs) => rs.filter((r) => r.needsYou).map((r) => ({ bot: b, run: r }))))),
    5000,
    busy.map((b) => b.id).join(),
  );
  if (!loaded) return null;
  if (!bots.length) {
    return (
      <div className="flex flex-col items-start gap-3 px-7 py-7 text-[13px] text-ink-muted">
        No bots yet. A bot is an agent that Slack, a hook or you start in one folder.
        <Button variant="primary" onClick={onNew}>New bot</Button>
      </div>
    );
  }
  const byBot = new Map((activity.data ?? []).map((a) => [a.bot, a]));
  const max = Math.max(1, ...(activity.data ?? []).flatMap((a) => a.daily.map((d) => d.runs)));
  const days = activity.data?.[0]?.daily.map((d) => d.day) ?? [];
  const runs = (activity.data ?? []).reduce((n, a) => n + a.runs, 0);
  const success = (activity.data ?? []).reduce((n, a) => n + a.success, 0);
  const failed = (activity.data ?? []).reduce((n, a) => n + a.daily.reduce((m, d) => m + d.failed, 0), 0);
  const other = Math.max(0, runs - success - failed);
  const sources = sumSources((activity.data ?? []).map((a) => a.sources));
  const needs = (waiting.data ?? []).flat();

  return (
    <div className="@container min-h-full bg-canvas px-6 py-5">
      <h2 className="mb-3.5 mt-0 text-[18px] font-semibold text-ink">Bots · last 4 weeks</h2>
      {activity.error && !activity.data && <ErrorNote className="mb-3">{activity.error}</ErrorNote>}
      <div className="grid items-center gap-[3px]" style={COLS}>
        <div />
        {(days.length ? days : Array.from({ length: DAYS }, () => "")).map((d, i) => (
          <div key={d || i} className="text-center text-[10px] text-ink-faint">{d && mondayMark(d)}</div>
        ))}
        <div className="text-right text-[10px] text-ink-faint">ok</div>
        {bots.map((b) => {
          const a = byBot.get(b.id);
          const ok = a ? pct(a.success, a.runs) : null;
          return (
            <BotRow key={b.id} bot={b} onOpen={() => onOpenBot(b.id)}>
              {(a?.daily ?? Array.from({ length: DAYS }, (_, i) => ({ day: String(i), runs: 0, failed: 0 }))).map((d) => {
                const l = heatLevel(d, max);
                return (
                  <i
                    key={d.day}
                    title={a ? `${d.day}: ${d.runs} run${d.runs === 1 ? "" : "s"}${d.failed ? `, ${d.failed} failed` : ""}` : undefined}
                    className={`aspect-square rounded-[3px] ${l === "x" ? "bg-blocked" : l === 0 ? "bg-line-soft" : ""}`}
                    style={typeof l === "number" && l > 0
                      ? { background: `hsl(${b.hue} ${50 + l * 5}% ${LEVEL_LIGHT[l]} / ${LEVEL[l]})` }
                      : undefined}
                  />
                );
              })}
              <div className="text-right text-[12px] text-ink-soft">{ok == null ? "—" : `${ok}%`}</div>
            </BotRow>
          );
        })}
      </div>
      <div className="mt-5 grid gap-3 @3xl:grid-cols-3">
        <div className={`${CARD} p-3.5`}>
          <h4 className="mb-2 mt-0 text-[12px] font-medium text-ink-muted">Outcomes</h4>
          {runs
            ? (
              <div className="flex items-center gap-3.5">
                <Donut parts={[[success, "var(--color-live)"], [other, "var(--color-wait)"], [failed, "var(--color-blocked)"]]} />
                <div className="flex flex-col gap-0.5 text-[12px] text-ink-soft">
                  <Legend tone="bg-live" text={`${pct(success, runs)}% finished`} />
                  <Legend tone="bg-wait" text={`${pct(other, runs)}% stopped or running`} />
                  <Legend tone="bg-blocked" text={`${pct(failed, runs)}% failed`} />
                </div>
              </div>
            )
            : <EmptyState>No runs in four weeks.</EmptyState>}
        </div>
        <div className={`${CARD} p-3.5`}>
          <h4 className="mb-2 mt-0 text-[12px] font-medium text-ink-muted">Where work comes from</h4>
          {runs
            ? (
              <div className="flex flex-wrap gap-1.5">
                {(Object.keys(SOURCE) as (keyof typeof SOURCE)[]).filter((k) => sources[k] > 0).map((k) => (
                  <span
                    key={k}
                    className="inline-flex items-center gap-1.5 rounded-full border border-chipline px-2 py-[2px] text-[11px] text-ink-soft"
                  >
                    <Glyph name={SOURCE[k].glyph} className="h-3.5 w-3.5" />
                    {SOURCE[k].label} {pct(sources[k], runs)}%
                  </span>
                ))}
              </div>
            )
            : <EmptyState>Nothing yet.</EmptyState>}
        </div>
        <div className={`${CARD} p-3.5`}>
          <h4 className="mb-2 mt-0 text-[12px] font-medium text-ink-muted">Needs you</h4>
          {needs.length
            ? needs.map(({ bot, run }) => <NeedsYou key={run.id} bot={bot} run={run} onOpen={() => onOpenRun(run.id)} />)
            : <EmptyState>Nothing waits on you.</EmptyState>}
        </div>
      </div>
    </div>
  );
}

function BotRow({ bot, onOpen, children }: { bot: Bot; onOpen: () => void; children: ReactNode }) {
  return (
    <>
      <button
        type="button"
        title={bot.cwd ?? bot.workspace}
        className="flex min-w-0 items-center gap-2 rounded-md text-left text-[12.5px] font-medium text-ink hover:text-copper"
        onClick={onOpen}
      >
        <BotAvatar bot={bot} state={bot.working > 0 ? "working" : "idle"} ring="border-canvas" />
        <span className="truncate">{bot.name}</span>
      </button>
      {children}
    </>
  );
}

function NeedsYou({ bot, run, onOpen }: { bot: Bot; run: BotRun; onOpen: () => void }) {
  return (
    <div className="flex items-center gap-2.5 py-1">
      <BotAvatar bot={bot} size="m" state="needs you" />
      <div className="min-w-0 flex-1">
        <b className="block truncate text-[12.5px] text-ink">{bot.name}</b>
        <div className="truncate text-[11.5px] text-ink-faint">{run.summary} · {timeAgo(run.startedAt)}</div>
      </div>
      <Button variant="primary" size="sm" onClick={onOpen}>Open</Button>
    </div>
  );
}

function Legend({ tone, text }: { tone: string; text: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-[7px] w-[7px] rounded-full ${tone}`} />
      {text}
    </span>
  );
}

// a ring of shares, as a conic gradient
function Donut({ parts }: { parts: [number, string][] }) {
  const total = parts.reduce((n, [v]) => n + v, 0) || 1;
  let at = 0;
  const stops = parts.map(([v, c]) => {
    const from = at;
    at += (v / total) * 100;
    return `${c} ${from}% ${at}%`;
  });
  return (
    <div className="grid h-16 w-16 shrink-0 place-items-center rounded-full" style={{ background: `conic-gradient(${stops.join(", ")})` }}>
      <div className="h-[42px] w-[42px] rounded-full bg-panel" />
    </div>
  );
}
