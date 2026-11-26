import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { termToken } from "../term/term-api";
import { AgentIcon } from "./agents";
import { type Bot, botImageUrl, type Face } from "./bot-api";

const INK = "#1b1d24";
const SKIN = { fill: "#fff", fillOpacity: 0.92 };

// the four generated faces, white on the bot's hue
const FACES: Record<Face, ReactNode> = {
  f1: (
    <>
      <rect x="7" y="11" width="26" height="19" rx="7" {...SKIN} />
      <circle cx="15" cy="20.5" r="2.6" fill={INK} />
      <circle cx="25" cy="20.5" r="2.6" fill={INK} />
      <path d="M16 25.5q4 2.4 8 0" stroke={INK} strokeWidth="1.8" fill="none" strokeLinecap="round" />
      <path d="M20 11V6.5" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
      <circle cx="20" cy="5.5" r="2" fill="#fff" />
    </>
  ),
  f2: (
    <>
      <circle cx="20" cy="21" r="13" {...SKIN} />
      <rect x="11.5" y="17" width="17" height="6" rx="3" fill={INK} />
      <circle cx="16" cy="20" r="1.4" fill="#7bd88f" />
      <circle cx="24" cy="20" r="1.4" fill="#7bd88f" />
      <path d="M17 28h6" stroke={INK} strokeWidth="1.8" strokeLinecap="round" />
    </>
  ),
  f3: (
    <>
      <path d="M8 16a12 12 0 0 1 24 0v8a8 8 0 0 1-8 8h-8a8 8 0 0 1-8-8z" {...SKIN} />
      <path
        d="M13 20l3-2 3 2M21 20l3-2 3 2"
        stroke={INK}
        strokeWidth="1.9"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="20" cy="26.5" r="1.8" fill={INK} />
    </>
  ),
  f4: (
    <>
      <rect x="8" y="9" width="24" height="23" rx="5" {...SKIN} />
      <rect x="12.5" y="16" width="5" height="5" rx="1.2" fill={INK} />
      <rect x="22.5" y="16" width="5" height="5" rx="1.2" fill={INK} />
      <path d="M14 26h12" stroke={INK} strokeWidth="1.8" strokeDasharray="2 2" />
      <path d="M5 18v6M35 18v6" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
    </>
  ),
};
export const FACE_IDS = Object.keys(FACES) as Face[];

export type Glyph =
  | "slack" | "hook" | "relay" | "clock" | "hand" | "play" | "folder" | "branch"
  | "auto" | "manual" | "acceptEdits" | "plan";
const GLYPHS: Record<Glyph, ReactNode> = {
  slack: (
    <>
      <path d="M4 6.5a2.5 2.5 0 0 1 2.5-2.5h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V17H6.5A2.5 2.5 0 0 1 4 14.5z" />
      <path d="M10 8l-1 6M14 8l-1 6M8.5 9.8h7M8 12.3h7" />
    </>
  ),
  hook: (
    <>
      <path d="M9 7a3 3 0 1 1 3.9 2.9L10 15" />
      <path d="M6.2 13.5A3 3 0 1 0 9 18h6" />
      <path d="M15 18a3 3 0 1 0 1.9-5.3L13.5 7" />
    </>
  ),
  relay: (
    <>
      <circle cx="5" cy="12" r="2.2" />
      <circle cx="19" cy="6" r="2.2" />
      <circle cx="19" cy="18" r="2.2" />
      <path d="M7 11l10-4M7 13l10 4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  hand: <path d="M6 12l5 5 8-10" />,
  play: <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none" />,
  folder: <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />,
  // permission modes
  auto: <path d="M12 3.5l1.9 4.6 4.6 1.9-4.6 1.9L12 16.5l-1.9-4.6L5.5 10l4.6-1.9zM18 15.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z" />,
  manual: (
    <>
      <path d="M12 3.5l7 2.8v5.4c0 4.2-3 7.4-7 8.8-4-1.4-7-4.6-7-8.8V6.3z" />
      <path d="M10 10.2a2 2 0 1 1 2.7 1.9c-.5.2-.7.6-.7 1.1v.4M12 16v.1" />
    </>
  ),
  acceptEdits: (
    <>
      <path d="M14.5 5.5l4 4L9 19H5v-4z" />
      <path d="M12.5 7.5l4 4" />
    </>
  ),
  plan: (
    <>
      <path d="M9 6.5h10M9 12h10M9 17.5h10" />
      <path d="M4.5 6l1 1 1.8-2M4.5 11.5l1 1 1.8-2M5 17.5h1" />
    </>
  ),
  branch: (
    <>
      <circle cx="7" cy="6" r="2.2" />
      <circle cx="7" cy="18" r="2.2" />
      <circle cx="17" cy="8" r="2.2" />
      <path d="M7 8.2v7.6M17 10.2c0 4-6 3-9.2 6" />
    </>
  ),
};

// a trigger, source or outcome glyph, stroked in currentColor
export function Glyph({ name, className = "h-3 w-3" }: { name: Glyph; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {GLYPHS[name]}
    </svg>
  );
}

// the face on the bot's hue, as the avatars' radial gradient
export const hueBg = (hue: number): CSSProperties => ({
  background: `radial-gradient(120% 120% at 30% 20%, hsl(${hue} 80% 68%), hsl(${hue + 40} 60% 38%))`,
  boxShadow: "inset 0 -2px 0 rgba(0,0,0,.18), 0 1px 2px rgba(0,0,0,.3)",
});
// a wash of the hue, for the bot page's hero
export const hueWash = (hue: number, alpha = 0.16): CSSProperties => ({
  background: `linear-gradient(180deg, hsl(${hue} 60% 50% / ${alpha}), transparent 75%)`,
});

export function BotFace({ face, className = "h-[62%] w-[62%]" }: { face: Face | null; className?: string }) {
  return <svg viewBox="0 0 40 40" className={className} aria-hidden="true">{FACES[face ?? "f1"]}</svg>;
}

let tokenNow: string | null = null;
// the app token for <img> URLs, which can't send the header
export function useTermTokenValue() {
  const [token, setToken] = useState(tokenNow);
  useEffect(() => {
    if (!token) void termToken().then((t) => setToken((tokenNow = t)), () => {});
  }, [token]);
  return token;
}
// bumped on upload/remove so every avatar refetches
const imageEpoch = new Map<string, number>();
export const bumpBotImage = (id: string) => imageEpoch.set(id, (imageEpoch.get(id) ?? 0) + 1);

export type BotState = "working" | "needs you" | "idle";
const SIZE = {
  s: "h-[26px] w-[26px] rounded-[30%]",
  m: "h-10 w-10 rounded-[30%]",
  l: "h-[72px] w-[72px] rounded-[26%]",
  xl: "h-24 w-24 rounded-[24%]",
};
const DOT: Record<BotState, string> = { working: "bg-live", "needs you": "bg-wait", idle: "bg-ink-faint" };

// A bot's face on its hue, or its uploaded image; with a run-state dot and the agent's logo in a corner.
export function BotAvatar(
  { bot, size = "s", state, provider, ring = "border-panel" }: {
    bot: Pick<Bot, "id" | "hue" | "face" | "hasImage" | "provider">;
    size?: keyof typeof SIZE;
    state?: BotState | null;
    provider?: boolean;
    ring?: string; // the dot's border, to match the background it sits on
  },
) {
  const token = useTermTokenValue();
  const big = size === "l" || size === "xl";
  const image = bot.hasImage && token && bot.id;
  return (
    <span className={`relative grid shrink-0 place-items-center ${SIZE[size]}`} style={image ? undefined : hueBg(bot.hue)}>
      {image
        ? <img src={botImageUrl(bot.id, token, imageEpoch.get(bot.id))} alt="" className="h-full w-full rounded-[inherit] object-cover" />
        : <BotFace face={bot.face} />}
      {state && (
        <span
          title={state}
          className={`absolute rounded-full ${ring} ${DOT[state]} ${
            big ? "-bottom-0.5 -right-0.5 h-3.5 w-3.5 border-[3px]" : "-bottom-0.5 -right-0.5 h-[9px] w-[9px] border-2"
          }`}
        />
      )}
      {provider && (
        <span className="absolute -left-[3px] -top-[3px] grid h-[18px] w-[18px] place-items-center rounded-[5px] border border-line bg-panel">
          <AgentIcon a={{ harness: bot.provider, icon: null }} size="h-3 w-3" />
        </span>
      )}
    </span>
  );
}

// each trigger's tile tint
export const TRIGGER_TONE = {
  slack: "bg-chart-5/15 text-chart-5",
  hook: "bg-copper/15 text-copper",
  relay: "bg-chart-7/15 text-chart-7",
  clock: "bg-live/15 text-live",
} as const;

// an on/off switch, copper when on
export function Switch(
  { on, onChange, disabled, label }: { on: boolean; onChange?: (on: boolean) => void; disabled?: boolean; label: string },
) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      disabled={disabled}
      className={`relative h-[17px] w-[30px] shrink-0 rounded-full transition-colors disabled:opacity-40 ${on ? "bg-copper" : "bg-chipline"}`}
      onClick={() => onChange?.(!on)}
    >
      <span
        className={`absolute top-[2px] h-[13px] w-[13px] rounded-full transition-[left] ${on ? "left-[15px] bg-copper-ink" : "left-[2px] bg-ink"}`}
      />
    </button>
  );
}
