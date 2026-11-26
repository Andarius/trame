import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { type BoardData, getBoard } from "../api";
import { AgentIcon } from "../agents/agents";
import { EntityIcon, IconButton } from "../ui/ui";
import { DockIcon } from "../ui/icons";
import { POPOUT_CLOSE } from "./TermPopout";
import { adoptTerminals, GROUP_POPOUT, listTerms, POPOUT_CHANNEL, type PopoutMsg, repoName, revealTerminal, savedShells, sessionLabel, type TermInfo, type TermSession, useTermDock, useTermSessions } from "./term-api";

const TerminalDock = lazy(() => import("./TerminalDock"));
const POLL_MS = 3000;

// a project's agents in a window of their own (`/?popout=g-<project>`): their list, and their shells in a dock of
// this window's own (tabs, splits), laid out as it was left
export function TermGroupPopout({ project }: { project: string }) {
  const [board, setBoard] = useState<BoardData | null>(null);
  const [terms, setTerms] = useState<Record<string, TermInfo>>({});
  const sessions = useTermSessions();
  const dock = useTermDock();
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
  // as the sidebar: those waiting on you first, then the latest active
  const seen = (x: TermSession) => x.updated_at ?? x.started_at ?? 0;
  const mine = sessions
    .filter((x) => terms[x.term] && projectOf(terms[x.term]) === project)
    .sort((a, b) => Number(!!b.waiting) - Number(!!a.waiting) || seen(b) - seen(a));
  // this window's dock takes in its agents' shells as they appear, and the others it was left holding
  const self = `${GROUP_POPOUT}${project}`;
  const [kept] = useState(() => savedShells(`trame:termLayout:${self}`));
  const memberKey = [...new Set([...mine.map((x) => x.term), ...kept.filter((id) => terms[id])])].sort().join(",");
  useEffect(() => {
    adoptTerminals(`trame:termLayout:${self}`, memberKey.split(",").filter(Boolean).map((id) => terms[id]).filter(Boolean));
  }, [memberKey, self, terms]);
  // every shell this window holds: its agents and those opened here
  const held = Object.keys(dock.terms);
  const key = held.sort().join(",");
  const current = dock.tabs.find((t) => t.id === dock.active)?.focus ?? null;

  // tell the main dock which shells this window holds, now and whenever it asks; one gone here ended
  const prev = useRef<string[]>([]);
  useEffect(() => {
    const now = key.split(",").filter(Boolean);
    const gone = prev.current.filter((id) => !now.includes(id));
    prev.current = now;
    if (!gone.length) return;
    const ch = new BroadcastChannel(POPOUT_CHANNEL);
    gone.forEach((id) => ch.postMessage({ exit: id } satisfies PopoutMsg));
    ch.close();
  }, [key]);
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
                onClick={() => void revealTerminal(x.term)}
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
      <main className="flex min-w-0 flex-1 flex-col">
        <Suspense fallback={null}>
          <TerminalDock board={board} scope={{ all: true, card: null, project, cwd: null }} />
        </Suspense>
      </main>
    </div>
  );
}
