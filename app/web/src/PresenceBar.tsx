import { useState } from "react";
import { type Presence, startWatcher } from "./api";

// Notion-style avatar stack: who's on the page + which agents are watching.
export function PresenceBar({ people }: { people: Presence[] }) {
  if (people.length === 0) return null;
  // viewers first, then watchers; server dedups by id, but two tabs can yield two
  // viewer entries for one person — dedup the rendered avatars by name (keep first).
  const seen = new Set<string>();
  const sorted = [...people]
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "viewer" ? -1 : 1))
    .filter((p) => (seen.has(p.name) ? false : (seen.add(p.name), true)));
  return (
    <div className="flex items-center">
      {sorted.map((p) => (
        <div
          key={p.id}
          className="relative -ml-1.5 first:ml-0"
          title={p.kind === "watcher" ? `${p.name} is watching` : p.name}
        >
          {p.avatar
            ? (
              <img
                src={p.avatar}
                alt={p.name}
                className={`h-6 w-6 rounded-full object-cover ring-2 ring-canvas ${
                  p.kind === "watcher" ? "ring-copper/60" : ""
                }`}
              />
            )
            : (
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-chipline text-[10px] font-medium text-ink ring-2 ring-canvas">
                {p.name.slice(0, 1).toUpperCase()}
              </div>
            )}
          {p.kind === "watcher" && (
            <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-copper ring-2 ring-canvas" />
          )}
        </div>
      ))}
    </div>
  );
}

// Ghosted avatar next to the presence stack: an agent with threads on this page but
// no active watcher. Clicking asks the server to open the comment watcher in a
// terminal; when none can open (headless/bundled build) the command is copied instead.
export function StartWatcherButton(
  { agent, name, avatar, pageId }: {
    agent: string;
    name: string;
    avatar: string;
    pageId: string;
  },
) {
  const [state, setState] = useState<"idle" | "starting" | "copied">("idle");
  const start = async () => {
    setState("starting");
    try {
      const r = await startWatcher(agent, pageId);
      if (!r.launched) {
        await navigator.clipboard?.writeText(r.cmd);
        setState("copied");
        setTimeout(() => setState("idle"), 2500);
      }
      // launched: stay "starting" until the watcher's heartbeat reaches presence
      // and this button unmounts
    } catch {
      setState("idle");
    }
  };
  const title = state === "copied"
    ? "No terminal opened — command copied, paste it in a shell"
    : state === "starting"
    ? `Starting ${name} watcher…`
    : `Start ${name} watcher`;
  return (
    <button
      type="button"
      title={title}
      disabled={state === "starting"}
      onClick={start}
      className={`relative -ml-1.5 first:ml-0 ${
        state === "starting" ? "" : "opacity-40 hover:opacity-90"
      }`}
    >
      <img
        src={avatar}
        alt={name}
        className={`h-6 w-6 rounded-full object-cover ring-2 ring-canvas ${
          state === "starting" ? "" : "grayscale"
        }`}
      />
      <span
        className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-canvas ${
          state === "starting" ? "animate-pulse bg-copper" : "bg-chipline"
        }`}
      />
    </button>
  );
}
