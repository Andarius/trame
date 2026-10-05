import { createContext, useContext, useEffect, useState } from "react";
import type { AgentPresenceSettings, LiveAgent } from "./api";

// brand marks for the harnesses/providers Trame knows; others send their own icon
const ICONS: Record<string, { viewBox: string; d: string }> = {
  claude: { viewBox: "0 0 24 24", d: "m4.714 15.956 4.718-2.648.079-.23-.08-.128h-.23l-.79-.048-2.695-.073-2.337-.097-2.265-.122-.57-.121-.535-.704.055-.353.48-.321.685.06 1.518.104 2.277.157 1.651.098 2.447.255h.389l.054-.158-.133-.097-.103-.098-2.356-1.596-2.55-1.688-1.336-.972-.722-.491L2 6.223l-.158-1.008.656-.722.88.06.224.061.893.686 1.906 1.476 2.49 1.833.364.304.146-.104.018-.072-.164-.274-1.354-2.446-1.445-2.49-.644-1.032-.17-.619a3 3 0 0 1-.103-.729L6.287.133 6.7 0l.995.134.42.364.619 1.415L9.735 4.14l1.555 3.03.455.898.243.832.09.255h.159V9.01l.127-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.583.28.48.685-.067.444-.286 1.851-.558 2.903-.365 1.942h.213l.243-.242.983-1.306 1.652-2.064.728-.82.85-.904.547-.431h1.032l.759 1.129-.34 1.166-1.063 1.347-.88 1.142-1.263 1.7-.79 1.36.074.11.188-.02 2.853-.606 1.542-.28 1.84-.315.832.388.09.395-.327.807-1.967.486-2.307.462-3.436.813-.043.03.049.061 1.548.146.662.036h1.62l3.018.225.79.522.473.638-.08.485-1.213.62-1.64-.389-3.825-.91-1.31-.329h-.183v.11l1.093 1.068 2.003 1.81 2.508 2.33.127.578-.321.455-.34-.049-2.204-1.657-.85-.747-1.925-1.62h-.127v.17l.443.649 2.343 3.521.122 1.08-.17.353-.607.213-.668-.122-1.372-1.924-1.415-2.168-1.141-1.943-.14.08-.674 7.254-.316.37-.728.28-.607-.461-.322-.747.322-1.476.388-1.924.316-1.53.285-1.9.17-.632-.012-.042-.14.018-1.432 1.967-2.18 2.945-1.724 1.845-.413.164-.716-.37.066-.662.401-.589 2.386-3.036 1.439-1.882.929-1.086-.006-.158h-.055L4.138 18.56l-1.13.146-.485-.456.06-.746.231-.243 1.907-1.312Z" },
  anthropic: { viewBox: "0 0 24 24", d: "M17.304 3.541h-3.672l6.696 16.918H24Zm-10.608 0L0 20.459h3.744l1.37-3.553h7.005l1.369 3.553h3.744L10.536 3.541Zm-.371 10.223L8.616 7.82l2.291 5.945Z" },
  openai: { viewBox: "0 0 512 512", d: "M196.4 185.8v-48.6c0-4.1 1.5-7.2 5.1-9.2l97.8-56.3c13.3-7.7 29.2-11.3 45.6-11.3 61.4 0 100.4 47.6 100.4 98.3 0 3.6 0 7.7-.5 11.8l-101.5-59.4c-6.1-3.6-12.3-3.6-18.4 0zm228.3 189.4V259c0-7.2-3.1-12.3-9.2-15.9L287 168.4l42-24.1c3.6-2 6.7-2 10.2 0l97.8 56.4c28.2 16.4 47.1 51.2 47.1 85 0 38.9-23 74.8-59.4 89.6zM166.2 272.8l-42-24.6c-3.6-2-5.1-5.1-5.1-9.2V126.4c0-54.8 42-96.3 98.8-96.3 21.5 0 41.5 7.2 58.4 20l-100.9 58.4c-6.1 3.6-9.2 8.7-9.2 15.9v148.5zm90.4 52.2-60.2-33.8v-71.7l60.2-33.8 60.2 33.8v71.7zm38.7 155.7c-21.5 0-41.5-7.2-58.4-20l100.9-58.4c6.1-3.6 9.2-8.7 9.2-15.9V237.9l42.5 24.6c3.6 2 5.1 5.1 5.1 9.2v112.6c0 54.8-42.5 96.3-99.3 96.3zM173.8 366.5l-97.7-56.3C47.9 293.8 29 259 29 225.2c0-39.4 23.6-74.8 59.9-89.6v116.7c0 7.2 3.1 12.3 9.2 15.9l128 74.2-42 24.1c-3.6 2-6.7 2-10.2 0zm-5.6 84c-57.9 0-100.4-43.5-100.4-97.3 0-4.1.5-8.2 1-12.3l100.9 58.4c6.1 3.6 12.3 3.6 18.4 0l128.5-74.2v48.6c0 4.1-1.5 7.2-5.1 9.2l-97.8 56.3c-13.3 7.7-29.2 11.3-45.6 11.3zm127 60.9c62 0 113.7-44 125.4-102.4 57.3-14.9 94.2-68.6 94.2-123.4 0-35.8-15.4-70.7-43-95.7 2.6-10.8 4.1-21.5 4.1-32.3 0-73.2-59.4-128-128-128-13.8 0-27.1 2-40.4 6.7-23-22.5-54.8-36.9-89.6-36.9-62 0-113.7 44-125.4 102.4-57.3 14.8-94.2 68.6-94.2 123.4 0 35.8 15.4 70.7 43 95.7-2.6 10.8-4.1 21.5-4.1 32.3 0 73.2 59.4 128 128 128 13.8 0 27.1-2 40.4-6.7 23 22.5 54.8 36.9 89.6 36.9" },
};

// Maps: harness/provider are agent-supplied strings ("__proto__" must not hit a prototype)
const HARNESS_ICON = new Map([["claude-code", "claude"], ["claude", "claude"], ["codex", "openai"]]);
const PROVIDER_ICON = new Map([["anthropic", "anthropic"], ["openai", "openai"]]);

function Svg({ name, className = "" }: { name: string; className?: string }) {
  const i = ICONS[name];
  return (
    <svg viewBox={i.viewBox} aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 fill-current ${className}`}>
      <path d={i.d} />
    </svg>
  );
}

// the harness's logo, else the icon the agent sent (emoji or image URL), else a monogram
export function AgentIcon({ a }: { a: Pick<LiveAgent, "harness" | "icon"> }) {
  const known = HARNESS_ICON.get(a.harness.toLowerCase());
  if (known) return <Svg name={known} className={known === "claude" ? "text-[#d97757]" : ""} />;
  if (a.icon && /^(https?:|data:image\/)/.test(a.icon)) {
    return <img src={a.icon} alt="" className="h-3.5 w-3.5 shrink-0 rounded-sm object-cover" />;
  }
  if (a.icon) return <span className="text-[12px] leading-none">{a.icon}</span>;
  return (
    <span className="grid h-3.5 w-3.5 shrink-0 place-items-center rounded-sm bg-card text-[8.5px] font-bold uppercase text-ink-soft">
      {a.harness[0]}
    </span>
  );
}

export type LiveState = "working" | "waiting";

// working needs a recent heartbeat; a waiting agent sits idle, so it lasts until stale
export function liveState(a: LiveAgent, cfg: AgentPresenceSettings, now = Date.now()): LiveState | null {
  const age = now - a.at;
  if (a.state === "working" && age <= cfg.liveMinutes * 60_000) return "working";
  if (a.state === "waiting" && age <= cfg.staleMinutes * 60_000) return "waiting";
  return null;
}

export type Live = { a: LiveAgent; state: LiveState };

// the todo this agent works on now: its pushed target, else any todo its session links
export const worksOn = (a: LiveAgent, blockId: string) =>
  a.block_id ? a.block_id === blockId : a.links.some((l) => l.block_id === blockId);

export const AgentsContext = createContext<{ live: Live[]; cfg: AgentPresenceSettings | null }>({
  live: [],
  cfg: null,
});
export const useAgents = () => useContext(AgentsContext);

// live agents, the ones waiting on you first, then the most recently active
export function liveAgents(agents: LiveAgent[], cfg: AgentPresenceSettings | null): Live[] {
  if (!cfg) return [];
  const now = Date.now();
  return agents
    .flatMap((a) => {
      const state = liveState(a, cfg, now);
      return state ? [{ a, state }] : [];
    })
    .sort((x, y) => (x.state === y.state ? y.a.at - x.a.at : x.state === "waiting" ? -1 : 1));
}

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
};

// working: a running clock; waiting: how long it has waited on you
export function Elapsed({ since, state }: { since: number; state: LiveState }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), state === "working" ? 1000 : 30_000);
    return () => clearInterval(t);
  }, [state]);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  if (state === "waiting") return <>waiting {s < 3600 ? `${Math.max(1, Math.round(s / 60))}m` : `${Math.floor(s / 3600)}h`}</>;
  const mm = String(Math.floor(s / 60) % 60).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return <>{s >= 3600 ? `${Math.floor(s / 3600)}:` : ""}{mm}:{ss}</>;
}

const dotCls = (state: LiveState) => (state === "working" ? "bg-live" : "bg-wait");

// Row pieces shared by page todos and the settings preview.
export const liveRowCls = (state: LiveState, cfg: AgentPresenceSettings) =>
  cfg.tint ? (state === "working" ? "rounded-md bg-live/[0.07]" : "rounded-md bg-wait/[0.09]") : "";

export const liveRingCls = (state: LiveState, cfg: AgentPresenceSettings) =>
  cfg.marker !== "ring"
    ? null
    : state === "working"
    ? `border-live/40 border-t-live ${cfg.motion ? "motion-safe:animate-spin" : ""}`
    : "border-dashed border-wait";

export function LiveRail({ state, cfg }: { state: LiveState; cfg: AgentPresenceSettings }) {
  if (cfg.marker !== "rail") return null;
  return (
    <span
      aria-hidden="true"
      className={`absolute bottom-1.5 left-2.5 top-1.5 w-[3px] rounded-full ${dotCls(state)} ${
        state === "working" && cfg.motion ? "motion-safe:animate-pulse" : ""
      }`}
    />
  );
}

export function LiveLine({ a, state, cfg }: Live & { cfg: AgentPresenceSettings }) {
  if (cfg.activity === "off") return null;
  const f = cfg.fields;
  const provider = a.provider ? PROVIDER_ICON.get(a.provider.toLowerCase()) : undefined;
  const sep = <span className="text-ink-muted/50">·</span>;
  return (
    <div
      className={`flex-wrap items-center gap-x-1.5 pb-1 font-mono [overflow-wrap:anywhere] text-[11.5px] leading-relaxed text-ink-muted ${
        cfg.activity === "hover" ? "hidden group-focus-within:flex group-hover:flex" : "flex"
      }`}
    >
      {f.harness && (
        <span className="inline-flex items-center gap-1 rounded border border-chipline px-1 text-ink-soft">
          <AgentIcon a={a} />
          {a.harness}
        </span>
      )}
      {f.provider && a.provider && (
        <span title={a.provider} className="inline-flex text-ink-soft">
          {provider ? <Svg name={provider} /> : a.provider}
        </span>
      )}
      {f.model && a.model && <b className="font-semibold text-ink-soft">{a.model}</b>}
      {f.tokens && a.tokens !== null && (
        <span className="inline-flex items-center gap-1.5 text-ink-soft" title={`${a.tokens.toLocaleString()} tokens so far`}>
          {sep}
          {fmtTokens(a.tokens)} tok
          {a.context_max
            ? (
              <span className="inline-block h-1 w-9 overflow-hidden rounded bg-card">
                <span
                  className="block h-full bg-ink-muted"
                  style={{ width: `${Math.min(100, (a.tokens / a.context_max) * 100)}%` }}
                />
              </span>
            )
            : null}
        </span>
      )}
      {f.step && state === "waiting" && a.question && (
        <span className="italic text-ink-soft">
          {sep} asks: “{a.question}”
        </span>
      )}
      {f.step && state === "working" && a.step && (
        <span>
          {sep} {a.step} {sep} {ago(Date.now() - a.at)}
        </span>
      )}
    </div>
  );
}

export function LiveTrail({ a, state, cfg }: Live & { cfg: AgentPresenceSettings }) {
  return (
    <span className="mt-1 flex shrink-0 items-center gap-1.5" title={`${a.harness} · ${a.session_title}`}>
      {cfg.chip && (
        <span
          className={`inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] leading-none text-ink-soft ${
            state === "working" ? "border-live/60" : "border-wait/70"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${dotCls(state)} ${cfg.motion ? "motion-safe:animate-pulse" : ""}`} />
          <b className="font-semibold text-ink">{state === "working" ? "working" : "needs you"}</b>
        </span>
      )}
      {cfg.timer && (
        <span className="inline-flex items-center gap-1 rounded-full border border-chipline/60 px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-ink-soft">
          <span className={`h-1.5 w-1.5 rounded-full ${dotCls(state)}`} />
          <Elapsed since={a.since} state={state} />
        </span>
      )}
    </span>
  );
}
