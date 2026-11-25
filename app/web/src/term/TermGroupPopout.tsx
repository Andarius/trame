import { useEffect, useState } from "react";
import { type BoardData, getBoard } from "../api";
import { AgentIcon } from "../agents/agents";
import { EntityIcon, IconButton } from "../ui/ui";
import { DockIcon } from "../ui/icons";
import { TerminalView } from "./TerminalView";
import { POPOUT_CLOSE } from "./TermPopout";
import { GROUP_POPOUT, listTerms, POPOUT_CHANNEL, type PopoutMsg, repoName, sessionLabel, type TermInfo, useTermSessions } from "./term-api";

const POLL_MS = 3000;

// a project's agents in a window of their own (`/?popout=g-<project>`): their list, and the selected one's shell
export function TermGroupPopout({ project }: { project: string }) {
  const [board, setBoard] = useState<BoardData | null>(null);
  const [terms, setTerms] = useState<Record<string, TermInfo>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const sessions = useTermSessions();
  useEffect(() => {
    const load = () => {
      void getBoard().then(setBoard, () => {});
      void listTerms().then((l) => setTerms(Object.fromEntries(l.filter((t) => !t.exited).map((t) => [t.id, t]))), () => {});
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, []);
  // its agents: a card's project, else the project its shell was opened for
  const cardProject = new Map(board?.sessions.map((s) => [s.id, s.client_id]));
  const projectOf = (t: TermInfo | undefined) => (t?.card && cardProject.get(t.card)) || t?.project || null;
  const mine = sessions.filter((x) => terms[x.term] && projectOf(terms[x.term]) === project);
  const ids = mine.map((x) => x.term);
  const key = ids.join(",");
  const current = selected && ids.includes(selected) ? selected : ids[0] ?? null;

  // tell the dock which shells this window holds, now and whenever it asks
  const self = `${GROUP_POPOUT}${project}`;
  useEffect(() => {
    const ch = new BroadcastChannel(POPOUT_CHANNEL);
    const announce = () => key.split(",").filter(Boolean).forEach((id) => ch.postMessage({ open: id, group: project } satisfies PopoutMsg));
    ch.onmessage = (e: MessageEvent<PopoutMsg>) => "ping" in e.data && announce();
    announce();
    return () => ch.close();
  }, [key, project]);
  useEffect(() => {
    const bye = () => {
      const ch = new BroadcastChannel(POPOUT_CHANNEL);
      ch.postMessage({ close: self } satisfies PopoutMsg);
      ch.close();
    };
    addEventListener("pagehide", bye);
    return () => removeEventListener("pagehide", bye);
  }, [self]);

  const p = board?.projects.find((x) => x.id === project);
  useEffect(() => void (document.title = `${p?.name ?? "Project"} · agents`), [p?.name]);
  // a shell ended here: the dock closes it, as for a single popout
  const exited = (id: string) => {
    const ch = new BroadcastChannel(POPOUT_CHANNEL);
    ch.postMessage({ exit: id } satisfies PopoutMsg);
    ch.close();
  };
  const back = () => {
    const ch = new BroadcastChannel(POPOUT_CHANNEL);
    ch.postMessage({ close: self } satisfies PopoutMsg);
    ch.close();
    if (globalThis.opener) globalThis.close();
    else location.replace(POPOUT_CLOSE);
  };

  return (
    <div className="flex h-screen bg-panel text-ink">
      <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-sidebar">
        <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-line pl-2.5 pr-1 text-[11px] font-medium tracking-[0.8px] text-ink-muted">
          {p && <EntityIcon icon={p.icon} size={14} />}
          <span className="min-w-0 flex-1 truncate">{(p?.name ?? "Project").toUpperCase()}</span>
          <span className="tabular-nums text-ink-faint">{mine.length}</span>
          <IconButton
            tone="close"
            className="grid h-6 w-6 place-items-center rounded-md hover:bg-hover"
            title="back to the main window"
            aria-label="Back to the main window"
            onClick={back}
          >
            <DockIcon size={12} />
          </IconButton>
        </div>
        <nav aria-label="Agents" className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-1.5">
          {mine.length === 0 && <p className="px-2 py-1 text-[11.5px] text-ink-muted">No agent running in this project.</p>}
          {mine.map((x) => {
            const t = terms[x.term];
            const state = x.waiting ? "waiting" : x.asleep ? "not resumed" : x.busy ? "working" : x.done ? "done" : "idle";
            return (
              <button
                key={x.term}
                type="button"
                onClick={() => setSelected(x.term)}
                className={`flex flex-col rounded-md px-2 py-1.5 text-left text-[12.5px] ${
                  x.term === current ? "bg-active-row text-ink" : "text-ink-soft hover:bg-hover"
                } ${x.waiting ? "bg-wait/[0.14]" : ""}`}
              >
                <span className="flex items-center gap-2">
                  <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${x.waiting ? "bg-wait" : x.busy ? "bg-live" : "bg-ink-faint"}`} />
                  <span className="min-w-0 flex-1 truncate">{sessionLabel(x)}</span>
                </span>
                <span className="flex items-center gap-1.5 pl-[15px] text-[11px] text-ink-muted">
                  <AgentIcon a={{ harness: x.agent, icon: null }} />
                  <span className="truncate">{[repoName(t?.cwd ?? null), state].filter(Boolean).join(" · ")}</span>
                </span>
              </button>
            );
          })}
        </nav>
      </aside>
      <main className="relative min-w-0 flex-1">
        {ids.map((id) => (
          <div key={id} className={id === current ? "absolute inset-0" : "hidden"}>
            <TerminalView id={id} visible={id === current} focused={id === current} onFocus={() => setSelected(id)} onExit={exited} />
          </div>
        ))}
      </main>
    </div>
  );
}
