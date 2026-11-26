import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { timeAgo } from "../ui/ui";
import { modeOf } from "./agent-run";
import { type Bot, type BotRun, type BotStats, useTriggerActions } from "./bot-api";
import { BotAvatar, type BotState, Glyph, Switch, TRIGGER_TONE } from "./bot-faces";
import { folderName } from "./bot-stats";
import type { RunFilter } from "./BotPage";

const TRIG_W = 190, BOT_W = 230, OUT_W = 200, NODE_H = 56, BOT_H = 100, PAD = 24, H = 470;
const NODE = "absolute flex items-center gap-2.5 rounded-xl border bg-panel px-3 py-2.5 text-left shadow-[0_6px_16px_rgba(0,0,0,.25)]";
const CLICK = "cursor-pointer transition-colors hover:border-copper/60 hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper";

type Node = {
  key: string;
  glyph: Parameters<typeof Glyph>[0]["name"];
  title: string;
  sub: string;
  on: boolean;
  show?: RunFilter; // clicking shows these runs
  hint?: string;
  aside?: ReactNode; // a control on the node itself
};

// a horizontal S-curve between two points
const curve = (x1: number, y1: number, x2: number, y2: number) => {
  const mx = (x1 + x2) / 2;
  return `M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
};

// What starts the bot on the left, the bot, what its runs give back on the right: each node acts or shows its runs.
export function BotWiring(
  { bot, state, runs, stats, reload, onShow, onSettings }: {
    bot: Bot;
    state: BotState;
    runs: BotRun[] | null;
    stats: BotStats | null;
    reload: () => void;
    onShow: (f: RunFilter) => void;
    onSettings: () => void;
  },
) {
  const { notice, error, copy, toggleSlack } = useTriggerActions(bot, reload);
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(860);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(680, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const count = (k: keyof BotStats["sources"]) => (stats?.sources[k] ? ` · ${stats.sources[k]} in 30 d` : "");
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  const lastHook = runs?.find((r) => r.source === "hook");
  const triggers: Node[] = [
    {
      key: "slack",
      glyph: "slack",
      title: "Slack",
      sub: bot.slack ? `@Trame ${bot.name}${count("slack")}` : `off${count("slack")}`,
      on: bot.slack,
      show: { source: "slack" },
      hint: "show its Slack runs",
      aside: (
        <span onClick={stop}>
          <Switch on={bot.slack} label={bot.slack ? "stop Slack mentions" : "start on Slack mentions"} onChange={toggleSlack} />
        </span>
      ),
    },
    {
      key: "hook",
      glyph: "hook",
      title: "Hook",
      sub: lastHook ? `last call ${timeAgo(lastHook.startedAt)}${count("hook")}` : "never called",
      on: true,
      show: { source: "hook" },
      hint: "show its hook runs",
      aside: (
        <span
          role="button"
          tabIndex={0}
          title="copy the hook command"
          className="rounded-md border border-chipline px-1.5 py-0.5 text-[10.5px] text-ink-soft hover:border-copper hover:text-copper"
          onClick={(e) => (stop(e), void copy(false))}
          onKeyDown={(e) => e.key === "Enter" && (stop(e), void copy(false))}
        >
          Copy
        </span>
      ),
    },
    { key: "relay", glyph: "relay", title: "Relay", sub: "coming soon", on: false },
    { key: "clock", glyph: "clock", title: "Schedule", sub: "coming soon", on: false },
  ];
  const outcomes: Node[] = [
    {
      key: "thread",
      glyph: "slack",
      title: "Reply in thread",
      sub: "status card + Stop",
      on: bot.slack,
      show: { source: "slack" },
      hint: "show the runs answered in Slack",
    },
    {
      key: "changes",
      glyph: "branch",
      title: `Changes in ${folderName(bot.cwd)}`,
      sub: stats ? `${stats.success} finished · ${stats.error} failed` : "commits or a pull request",
      on: true,
      show: { outcome: "success" },
      hint: "show the finished runs",
    },
    { key: "answer", glyph: "relay", title: "Answer the asker", sub: "via relay · coming soon", on: false },
  ];

  const botX = (w - BOT_W) / 2, botY = (H - BOT_H) / 2, botMid = botY + BOT_H / 2;
  const outX = w - PAD - OUT_W;
  const trigY = (i: number) => 40 + i * ((H - 80 - NODE_H) / (triggers.length - 1));
  const outY = (i: number) => 70 + i * ((H - 140 - NODE_H) / (outcomes.length - 1));
  const mode = bot.provider === "claude" ? modeOf(bot.mode)?.label : null;

  return (
    <div className="overflow-x-auto px-7 py-[18px]">
      <div
        ref={box}
        className="relative min-w-[680px] rounded-xl border border-line"
        style={{
          height: H,
          backgroundImage: "radial-gradient(var(--color-line) 1px, transparent 1px)",
          backgroundSize: "18px 18px",
        }}
      >
        <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
          <g fill="none" strokeWidth="1.6">
            {triggers.map((t, i) => (
              <path
                key={t.key}
                d={curve(PAD + TRIG_W, trigY(i) + NODE_H / 2, botX, botMid - 9 + i * 6)}
                stroke="var(--color-chipline)"
                strokeDasharray={t.on ? undefined : "4 4"}
                opacity={t.on ? 1 : 0.6}
              />
            ))}
            {outcomes.map((o, i) => (
              <path
                key={o.key}
                d={curve(botX + BOT_W, botMid - 6 + i * 6, outX, outY(i) + NODE_H / 2)}
                stroke={o.on ? "var(--color-copper)" : "var(--color-chipline)"}
                strokeDasharray={o.on ? undefined : "4 4"}
                opacity={o.on ? 1 : 0.6}
              />
            ))}
          </g>
        </svg>
        {triggers.map((t, i) => (
          <WireNode key={t.key} n={t} x={PAD} y={trigY(i)} w={TRIG_W} onShow={onShow}>
            <span className={`grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg ${TRIGGER_TONE[t.glyph as keyof typeof TRIGGER_TONE]}`}>
              <Glyph name={t.glyph} className="h-4 w-4" />
            </span>
          </WireNode>
        ))}
        <button
          type="button"
          title="edit this bot"
          className={`${NODE} ${CLICK} border-copper/55 px-4 py-3.5`}
          style={{ left: botX, top: botY, width: BOT_W, height: BOT_H }}
          onClick={onSettings}
        >
          <BotAvatar bot={bot} size="m" state={state} />
          <div className="min-w-0 text-[12.5px]">
            <b className="block truncate text-[15px] text-ink">{bot.name}</b>
            <small className="block truncate text-[11px] text-ink-faint">
              {bot.provider === "codex" ? "Codex" : "Claude"}
              {mode && ` · ${mode}`} · {folderName(bot.cwd)}
            </small>
            <small className="block text-[11px] text-ink-faint">
              {state === "idle" ? "idle" : state === "working" ? `${Math.max(bot.working, 1)} running` : "needs you"}
            </small>
          </div>
        </button>
        {outcomes.map((o, i) => (
          <WireNode key={o.key} n={o} x={outX} y={outY(i)} w={OUT_W} onShow={onShow}>
            <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-md bg-active-row text-ink-soft">
              <Glyph name={o.glyph} />
            </span>
          </WireNode>
        ))}
      </div>
      {(notice || error) && (
        <p className={`mt-2 text-[11.5px] ${error ? "text-blocked" : "text-ink-muted"}`}>{error ?? notice}</p>
      )}
      <p className="mt-2 text-[11px] text-ink-faint">Click a node to see its runs; the bot opens its settings.</p>
    </div>
  );
}

function WireNode(
  { n, x, y, w, children, onShow }: {
    n: Node;
    x: number;
    y: number;
    w: number;
    children: ReactNode;
    onShow: (f: RunFilter) => void;
  },
) {
  const body = (
    <>
      {children}
      <div className="min-w-0 flex-1 text-[12.5px] text-ink">
        <span className="block truncate">{n.title}</span>
        <small className="block truncate text-[11px] text-ink-faint">{n.sub}</small>
      </div>
      {n.aside}
    </>
  );
  const style = { left: x, top: y, width: w, height: NODE_H };
  if (!n.show) {
    return (
      <div className={`${NODE} border-line opacity-50`} style={style} title={n.sub}>
        {body}
      </div>
    );
  }
  return (
    <div
      role="button"
      tabIndex={0}
      title={n.hint}
      className={`${NODE} ${CLICK} border-line ${n.on ? "" : "opacity-60"}`}
      style={style}
      onClick={() => onShow(n.show!)}
      onKeyDown={(e) => e.key === "Enter" && onShow(n.show!)}
    >
      {body}
    </div>
  );
}
