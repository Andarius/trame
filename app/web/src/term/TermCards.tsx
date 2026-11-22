import { useState } from "react";
import type { BoardData, ClaudeSession } from "../api";
import { RecentList } from "../agents/RecentList";
import { AgentIcon, Elapsed, type Live, useAgents } from "../agents/agents";
import { GroupMenu } from "../ui/GroupMenu";
import { appConfirm, EntityIcon, enumCodec, MenuRow, Popover, SECTION_LABEL, SET_CODEC, useLocalStorage } from "../ui/ui";
import { LinkCardDialog } from "./LinkCardDialog";
import { NewTerminalDialog } from "./NewTerminalDialog";
import { closeTerminal, revealTerminal, sessionLabel, type TermSession, useTermDock, useTermSessions } from "./term-api";

const GROUPINGS = ["project", "none"] as const;
type Grouping = typeof GROUPINGS[number];
const GROUPING_LABEL: Record<Grouping, string> = { project: "Project", none: "No grouping" };

// The Terminals view's sidebar column: the agents running in Trame's shells (and outside it, from their card's
// presence), grouped by project or not at all.
export function TermCards(
  {
    board,
    selected,
    selectedProject,
    all,
    selectedTerm,
    recent,
    history,
    onSelectAll,
    onSelectTerm,
    onSelect,
    onSelectProject,
    onSelectRecent,
    onSelectHistory,
  }: {
    board: BoardData | null;
    selected: string | null;
    selectedProject: string | null; // its project shells are shown (selected is then null)
    all: boolean; // every shell is shown (selected and selectedProject are then null)
    selectedTerm: string | null; // the shell of an agent session (the others are then null)
    onSelectAll: () => void;
    onSelectTerm: (term: string, name: string) => void; // Ctrl/⌘ held: opens it as a side tab
    onSelect: (card: string | null) => void;
    onSelectProject: (project: string) => void;
    recent: string | null; // the past session shown
    history: boolean; // All sessions is shown
    onSelectRecent: (s: ClaudeSession) => void;
    onSelectHistory: () => void;
  },
) {
  const { terms } = useTermDock();
  const [grouping, setGrouping] = useLocalStorage<Grouping>("trame:termGrouping", "project", enumCodec(GROUPINGS));
  // group headers folded (keyed by grouping:key)
  const [folded, setFolded] = useLocalStorage("trame:termFolded", new Set<string>(), SET_CODEC);
  const flip = (set: Set<string>, save: (v: Set<string>) => void, k: string) => {
    const next = new Set(set);
    if (!next.delete(k)) next.add(k);
    save(next);
  };
  const [menuFor, setMenuFor] = useState<string | null>(null); // the project right-clicked for a new terminal
  const [newOpen, setNewOpen] = useState(false);
  const [linkFor, setLinkFor] = useState<string | null>(null); // the shell to link to a card
  const [menu, setMenu] = useState<string | null>(null); // the agent row right-clicked
  const { live } = useAgents();
  const agentOf = new Map<string, Live>(live.map((l) => [l.a.session_id, l]));
  const cardOf = new Map(board?.sessions.map((s) => [s.id, s]));
  const knownProjects = new Set(board?.projects.map((p) => p.id));
  const termSessions = useTermSessions();
  // the hooks report model, step and question per card: an agent gets its shell's card's
  const liveOf = (x: TermSession) => {
    const c = terms[x.term]?.card;
    return c ? agentOf.get(c) : undefined;
  };
  const isWaiting = (x: TermSession) => !!x.waiting || liveOf(x)?.state === "waiting";
  const asking = termSessions.filter(isWaiting);
  const running = termSessions.filter((x) => !isWaiting(x)).sort((a, b) => seen(b) - seen(a));
  // an agent's project: its card's, else its shell's
  const projectOf = (x: TermSession) => {
    const t = terms[x.term];
    const p = (t?.card && cardOf.get(t.card)?.client_id) || t?.project;
    return p && knownProjects.has(p) ? p : null;
  };
  const groups = new Map<string | null, TermSession[]>();
  for (const x of running) {
    const k = grouping === "project" ? projectOf(x) : "all";
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  const keys = [...groups.keys()].sort((a, b) =>
    a === null ? 1 : b === null ? -1 : projectName(board, a).localeCompare(projectName(board, b))
  );
  const label = (key: string | null) => (key ? projectName(board, key).toUpperCase() : "NO PROJECT");
  // agents running in a terminal outside Trame: a card's presence with no shell here, waiting ones first
  const shelled = new Set(Object.values(terms).map((t) => t.card));
  const outside = live.filter((l) => cardOf.has(l.a.session_id) && !shelled.has(l.a.session_id)).sort((a, b) =>
    Number(b.state === "waiting") - Number(a.state === "waiting")
  );
  const selectedCard = selected ? cardOf.get(selected) : undefined;
  const everyShell = Object.values(terms);

  const closeShell = async (term: string) => {
    if (!(await appConfirm("Close this shell? The agent running in it stops.", "Close"))) return;
    await closeTerminal(term);
  };
  const row = (key: string, active: boolean, onClick: () => void, children: React.ReactNode) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      className={`flex w-full flex-col rounded-md px-2 py-1.5 text-left text-[12.5px] ${
        active ? "bg-active-row font-medium text-ink" : "text-ink-muted hover:text-ink-soft"
      }`}
    >
      {children}
    </button>
  );
  const dot = (waiting: boolean, working: boolean, done: boolean) =>
    done
      ? <span className="w-[7px] shrink-0 text-center text-[10px] leading-none text-live" title="done: no follow-ups">✓</span>
      : <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${waiting ? "bg-wait" : working ? "bg-live" : "bg-ink-faint"}`} />;
  // one agent running in a Trame shell
  const agentRow = (x: TermSession) => {
    const key = `term:${x.term}:${x.id}`;
    const l = liveOf(x);
    const waiting = isWaiting(x);
    const working = !waiting && (l?.state === "working" || x.busy);
    return (
      <div
        key={key}
        className={`relative ${waiting ? "rounded-md bg-wait/[0.14]" : ""}`}
        title="right-click: link to a card, close"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu(key);
        }}
      >
        {menu === key && (
          <Popover portal onClose={() => setMenu(null)} className="w-44">
            <MenuRow
              onClick={() => {
                setLinkFor(x.term);
                setMenu(null);
              }}
            >
              Link to card…
            </MenuRow>
            <MenuRow
              className="hover:text-blocked"
              onClick={() => {
                setMenu(null);
                void closeShell(x.term);
              }}
            >
              Close shell
            </MenuRow>
          </Popover>
        )}
        {row(key, selectedTerm === x.term, () => {
          onSelectTerm(x.term, sessionLabel(x));
          void revealTerminal(x.term);
        }, (
          <>
            <span className="flex w-full items-center gap-2" title={`${x.agent} · ${x.id}`}>
              {dot(waiting, working, !waiting && !working && x.done)}
              <span className="min-w-0 flex-1 truncate">{sessionLabel(x)}</span>
            </span>
            <AgentLine l={l} x={x} />
          </>
        ))}
      </div>
    );
  };
  // an agent running in a terminal outside Trame, known from its card's presence
  const outsideRow = (l: Live) => {
    const waiting = l.state === "waiting";
    return (
      <div key={`out:${l.a.session_id}`} className={waiting ? "rounded-md bg-wait/[0.14]" : "opacity-60 hover:opacity-100"}>
        {row(`out:${l.a.session_id}`, selected === l.a.session_id, () => onSelect(l.a.session_id), (
          <>
            <span className="flex w-full items-center gap-2">
              {dot(waiting, l.state === "working", false)}
              <span className="min-w-0 flex-1 truncate">{l.a.name ?? cardOf.get(l.a.session_id)?.title}</span>
              <span className="ml-auto shrink-0 text-ink-faint" title="it runs in a terminal outside Trame">↗</span>
            </span>
            <AgentLine l={l} />
          </>
        ))}
      </div>
    );
  };
  const gkey = (key: string | null) => `${grouping}:${key ?? ""}`;
  const agents = termSessions.length + outside.length;

  return (
    <nav aria-label="Running agents" className="flex flex-col gap-3">
      {asking.length > 0 && (
        <section className="flex flex-col gap-0.5">
          <div className={`px-2 pb-1 ${SECTION_LABEL} text-wait`}>NEEDS YOU · {asking.length}</div>
          {asking.map(agentRow)}
        </section>
      )}
      <div className="-mb-1 flex items-center px-2">
        <button
          type="button"
          onClick={onSelectAll}
          disabled={everyShell.length === 0}
          title="show every shell"
          className={`flex flex-1 items-center gap-1.5 text-left ${SECTION_LABEL} ${all ? "text-ink" : "hover:text-ink-soft"}`}
        >
          AGENTS
          {agents > 0 && <span>· {agents}</span>}
        </button>
        <button
          type="button"
          onClick={() => setNewOpen(true)}
          title="New terminal or agent (Ctrl+T)"
          aria-label="New terminal or agent"
          className="mr-1 flex h-5 w-5 items-center justify-center rounded text-[15px] leading-none text-ink-muted hover:bg-active-row hover:text-ink"
        >
          +
        </button>
        <GroupMenu value={grouping} options={GROUPING_LABEL} onChange={setGrouping} />
        {newOpen && (
          <NewTerminalDialog
            board={board}
            here={selectedCard ? { cwd: selectedCard.repo_path ?? null, card: selectedCard.id } : null}
            project={selectedProject ?? undefined}
            onClose={() => setNewOpen(false)}
            onOpened={(card, project) => (card ? onSelect(card) : project ? onSelectProject(project) : onSelect(null))}
          />
        )}
      </div>
      {agents === 0 && (
        <p className="px-2 text-[11.5px] leading-snug text-ink-muted">
          No agent running. Start one with + above (Ctrl+T), or resume one below.
        </p>
      )}
      {keys.map((key) => (
        <section key={key ?? "none"} className="flex flex-col gap-0.5">
          {grouping !== "none" && (
            <div className={`group/head relative flex items-center gap-1.5 px-2 pb-1 ${SECTION_LABEL}`}>
              <button
                type="button"
                className="group/fold flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-ink-soft"
                aria-expanded={!folded.has(gkey(key))}
                title={folded.has(gkey(key)) ? "show this group" : "fold this group"}
                onClick={() => flip(folded, setFolded, gkey(key))}
              >
                {key && <EntityIcon icon={board?.projects.find((p) => p.id === key)?.icon} size={14} />}
                <span className="truncate">{label(key)}</span>
                <span
                  aria-hidden="true"
                  className={`text-[10px] leading-none ${folded.has(gkey(key)) ? "" : "opacity-0 group-hover/fold:opacity-100"}`}
                >
                  {folded.has(gkey(key)) ? "▸" : "▾"}
                </span>
                <span className="ml-auto pr-1 tracking-normal tabular-nums text-ink-faint">{groups.get(key)!.length}</span>
              </button>
              {key && (
                <button
                  type="button"
                  onClick={() => setMenuFor(key)}
                  title="new terminal or agent in this project"
                  aria-label={`New terminal in ${label(key)}`}
                  className={`-my-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[15px] leading-none text-ink-muted hover:bg-active-row hover:text-ink ${
                    menuFor === key ? "" : "opacity-0 focus-visible:opacity-100 group-hover/head:opacity-100"
                  }`}
                >
                  +
                </button>
              )}
              {key && menuFor === key && (
                <NewTerminalDialog
                  board={board}
                  project={key}
                  onClose={() => setMenuFor(null)}
                  onOpened={(card, project) => (card ? onSelect(card) : project ? onSelectProject(project) : onSelect(null))}
                />
              )}
            </div>
          )}
          {!folded.has(gkey(key)) && groups.get(key)!.map(agentRow)}
        </section>
      ))}
      {outside.length > 0 && (
        <section className="flex flex-col gap-0.5">
          <div className="mx-2 mb-1 border-t border-dashed border-line" />
          <div className={`flex items-center px-2 pb-1 ${SECTION_LABEL}`} title="agents running in a terminal outside Trame">
            OUTSIDE TRAME
            <span className="ml-auto tracking-normal tabular-nums">{outside.length}</span>
          </div>
          {outside.map(outsideRow)}
        </section>
      )}
      <RecentList board={board} selected={recent} history={history} onSelect={onSelectRecent} onHistory={onSelectHistory} />
      {linkFor && (
        <LinkCardDialog
          board={board}
          term={linkFor}
          card={terms[linkFor]?.card ?? null}
          onClose={() => setLinkFor(null)}
          onLinked={(c) => c && onSelect(c)}
        />
      )}
    </nav>
  );
}

const projectName = (board: BoardData | null, id: string) => board?.projects.find((p) => p.id === id)?.name ?? "";
const seen = (x: TermSession) => x.updated_at ?? x.started_at ?? 0;

// under an agent's name: its model and state, how long, then what it does (or asks) on a second line;
// `l` is its card's presence from the hooks, `x` what Trame reads from the process itself
function AgentLine({ l, x }: { l?: Live; x?: TermSession }) {
  if (!l && !x) return null;
  const waiting = l?.state === "waiting" || !!x?.waiting;
  const working = !waiting && (l?.state === "working" || !!x?.busy);
  const done = !waiting && !working && !!x?.done;
  const detail = waiting ? l?.a.question ?? x?.waiting ?? "waiting for input" : working ? l?.a.step : undefined;
  const model = shortModel(l?.a.model);
  return (
    <span className="flex w-full flex-col pl-[15px] pt-0.5 text-[11px]">
      <span className="flex w-full items-center gap-1.5 text-ink-faint">
        <AgentIcon a={l?.a ?? { harness: x!.agent, icon: null }} />
        <span className="min-w-0 flex-1 truncate" title={l?.a.model ?? undefined}>
          {model && `${model} · `}
          {waiting ? <span className="text-wait">needs you</span> : working ? "working" : done ? "done" : "idle"}
        </span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums">
          {l ? <Elapsed since={l.a.since} state={l.state} /> : x && seen(x) > 0 && age(seen(x))}
        </span>
      </span>
      {detail && (
        <span className={`truncate pl-5 ${waiting ? "text-ink-soft" : "text-ink-faint"}`} title={detail}>
          {detail}
        </span>
      )}
    </span>
  );
}

const shortModel = (m?: string | null) => (m ? m.match(/opus|sonnet|haiku|fable/i)?.[0].toLowerCase() ?? m.replace(/^claude-/, "") : null);

// how long ago, coarse: 4m, 2h, 3d
const age = (since: number) => {
  const m = Math.max(1, Math.round((Date.now() - since) / 60_000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};
