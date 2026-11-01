import type { AgentKind, ResumeInfo, ResumeMode } from "../api";
import { enumCodec, useLocalStorage } from "../ui/ui";

export const agentLabel = (a?: AgentKind) => (a === "codex" ? "Codex" : "Claude");

// How a Resume button places the session; the last pick is the default, persisted.
const ALL_RESUME_MODES: { mode: ResumeMode; label: string; hint: string }[] = [
  { mode: "window", label: "New window", hint: "opens a fresh terminal window" },
  { mode: "tab", label: "New tab", hint: "adds a tab to your open terminal" },
  { mode: "existing", label: "Existing session", hint: "types into your focused konsole" },
  { mode: "desktop", label: "Desktop app", hint: "opens Claude Desktop or Codex Desktop" },
  { mode: "embedded", label: "Trame terminal", hint: "opens in Trame's Terminals view" },
];
// typing into an open session drives konsole over D-Bus: Linux only
export const RESUME_MODES = /Mac/.test(navigator.userAgent)
  ? ALL_RESUME_MODES.filter((m) => m.mode !== "existing")
  : ALL_RESUME_MODES;
export const RESUME_DONE: Record<ResumeMode, string> = {
  window: "terminal opened",
  tab: "tab opened",
  existing: "sent to terminal",
  desktop: "desktop app opened",
  embedded: "opened in Terminals",
};
const RESUME_MODE_CODEC = enumCodec<ResumeMode>(["window", "tab", "existing", "desktop", "embedded"]);

// the last picked mode, shared by the card drawer and the AI Sessions view
export function useResumeMode() {
  const [stored, setMode] = useLocalStorage<ResumeMode>("trame:resumeMode", "window", RESUME_MODE_CODEC);
  // a mode remembered from another platform falls back to a new window
  const mode = RESUME_MODES.some((m) => m.mode === stored) ? stored : "window";
  return [mode, setMode] as const;
}

// a resume the backend didn't launch: copy the command (or desktop link) as an escape hatch, and say why
export async function notLaunched(r: ResumeInfo): Promise<string> {
  try {
    await navigator.clipboard?.writeText(r.reason === "no-desktop-app" && r.url ? r.url : r.cmd);
  } catch { /* clipboard blocked — still show why below */ }
  return r.reason === "no-desktop-app"
    ? `${agentLabel(r.agent)} desktop app not installed — link copied`
    : r.reason === "api-disabled"
    ? "enable konsole D-Bus — copied"
    : r.local === false
    ? (r.homeNode ? `on ${r.homeNode} — copied` : "no transcript here — copied")
    : "command copied";
}
