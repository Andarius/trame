import { useEffect, useState } from "react";
import { AgentIcon } from "../agents/agents";
import { IconButton } from "../ui/ui";
import { DockIcon } from "../ui/icons";
import { TerminalView } from "./TerminalView";
import { POPOUT_CHANNEL, type PopoutMsg, termNow, type TermNow, useTermSessions } from "./term-api";

// the desktop app has no window.close() (WebKitGTK would leave an empty window): it closes on this navigation
export const POPOUT_CLOSE = "/?popout-close";

// one shell in a window of its own (`/?popout=<id>`); closing the window sends it back to the dock
export function TermPopout({ id }: { id: string }) {
  const [now, setNow] = useState<TermNow | null>(null);
  const running = useTermSessions().find((x) => x.term === id);
  useEffect(() => {
    const ch = new BroadcastChannel(POPOUT_CHANNEL);
    const say = (m: PopoutMsg) => ch.postMessage(m);
    ch.onmessage = (e: MessageEvent<PopoutMsg>) => "ping" in e.data && say({ open: id });
    say({ open: id });
    const bye = () => say({ close: id });
    addEventListener("pagehide", bye);
    const load = () => void termNow(id).then(setNow);
    load();
    const t = setInterval(load, 2000);
    return () => {
      clearInterval(t);
      removeEventListener("pagehide", bye);
      ch.close();
    };
  }, [id]);
  const folder = now?.cwd?.replace(/\/+$/, "").split("/").pop() || null;
  const title = [(running?.named && running.name) || folder, now?.process].filter(Boolean).join(" : ") || "Terminal";
  useEffect(() => void (document.title = title), [title]);
  const close = (m: PopoutMsg) => {
    const ch = new BroadcastChannel(POPOUT_CHANNEL);
    ch.postMessage(m);
    ch.close();
    if (globalThis.opener) globalThis.close();
    else location.replace(POPOUT_CLOSE);
  };
  return (
    <div className="flex h-screen flex-col bg-panel">
      <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-line pl-2.5 pr-1 text-[12px] text-ink">
        {running?.agent && <AgentIcon a={{ harness: running.agent, icon: null }} />}
        <span className="min-w-0 flex-1 truncate" title={now?.cwd ?? undefined}>{title}</span>
        <IconButton
          tone="close"
          className="grid h-6 w-6 place-items-center rounded-md hover:bg-hover"
          title="back to the dock"
          aria-label="Back to the dock"
          onClick={() => close({ close: id })}
        >
          <DockIcon size={12} />
        </IconButton>
      </div>
      <div className="relative min-h-0 flex-1">
        <TerminalView id={id} visible focused onFocus={() => {}} onExit={() => close({ exit: id })} />
      </div>
    </div>
  );
}
