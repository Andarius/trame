import { useState } from "react";
import type { BoardData, ClaudeSession, Session } from "../api";
import { RecentList } from "../agents/RecentList";
import { AgentIcon, Elapsed, type Live, useAgents } from "../agents/agents";
import { GroupMenu } from "../ui/GroupMenu";
import { EntityIcon, enumCodec, SECTION_LABEL, StatusDot, useLocalStorage } from "../ui/ui";
import { LinkCardDialog } from "./LinkCardDialog";
import { NewTerminalDialog } from "./NewTerminalDialog";
import { revealTerminal, sessionLabel, setTermDrag, tabCards, type TermDrag, type TermSession, useTermDock, useTermSessions } from "./term-api";

const GROUPINGS = ["project", "status", "none"] as const;
type Grouping = typeof GROUPINGS[number];
const GROUPING_LABEL: Record<Grouping, string> = { project: "Project", status: "Status", none: "No grouping" };

// The Terminals view's sidebar column: cards with shells or a live agent, grouped by project, status or not at all
// (Orca's project → branch list, with cards); `selected` stays listed even without either.
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
    onSelectTerm: (term: string) => void;
    onSelect: (card: string | null) => void;
    onSelectProject: (project: string) => void;
    recent: string | null; // the past session shown
    history: boolean; // All sessions is shown
    onSelectRecent: (s: ClaudeSession) => void;
    onSelectHistory: () => void;
  },
) {
  const { terms, tabs, active } = useTermDock();
  const [grouping, setGrouping] = useLocalStorage<Grouping>("trame:termGrouping", "project", enumCodec(GROUPINGS));
  const [menuFor, setMenuFor] = useState<string | null>(null); // the project right-clicked for a new terminal
  const [newOpen, setNewOpen] = useState(false);
  const [linkFor, setLinkFor] = useState<string | null>(null); // the shell right-clicked to link to a card
  const { live } = useAgents();
  const agentOf = new Map<string, Live>(live.map((l) => [l.a.session_id, l]));
  type Count = { count: number; running: number };
  const add = <K,>(m: Map<K, Count>, k: K, exited: boolean) => {
    const n = m.get(k) ?? { count: 0, running: 0 };
    m.set(k, { count: n.count + 1, running: n.running + (exited ? 0 : 1) });
  };
  // a shell counts for its card; without one on this board, for its project; else it is plain
  const known = new Set(board?.sessions.map((s) => s.id));
  const knownProjects = new Set(board?.projects.map((p) => p.id));
  const shells = new Map<string, Count>();
  const projectShells = new Map<string, Count>();
  const plainShells: Count = { count: 0, running: 0 };
  // agents asking you something: listed once, on top, out of their groups
  const termSessions = useTermSessions();
  const asking = termSessions.filter((x) => x.waiting);
  const askingCards = live.filter((l) => l.state === "waiting" && known.has(l.a.session_id));
  const askingCard = new Set([
    ...askingCards.map((l) => l.a.session_id),
    ...asking.map((x) => terms[x.term]?.card).filter((c): c is string => !!c && known.has(c)),
  ]);
  // agent sessions in shells no card on this board holds: one entry each
  const cardless = termSessions.filter((x) => {
    const card = terms[x.term]?.card;
    return !(card && known.has(card));
  });
  const loose = cardless.filter((x) => !x.waiting);
  // a shell running one of those sessions is listed by its session row, not counted again as a project or plain shell
  const sessionShells = new Set(cardless.map((x) => x.term));
  for (const t of Object.values(terms)) {
    if (t.card && known.has(t.card)) add(shells, t.card, t.exited);
    else if (sessionShells.has(t.id)) continue;
    else if (t.project && knownProjects.has(t.project)) add(projectShells, t.project, t.exited);
    else {
      plainShells.count++;
      if (!t.exited) plainShells.running++;
    }
  }
  // grouped by project, a session in a project's shell sits under that project, not OTHER
  const looseProject = (x: TermSession) => {
    const p = terms[x.term]?.project;
    return grouping === "project" && p && knownProjects.has(p) ? p : null;
  };
  const other = loose.filter((x) => !looseProject(x));
  const cards = (board?.sessions ?? []).filter((s) =>
    (shells.has(s.id) || agentOf.has(s.id) || s.id === selected) && !askingCard.has(s.id)
  );
  const keyOf = (s: Session) => grouping === "project" ? s.client_id : grouping === "status" ? s.status : "all";
  const groups = new Map<string | null, Session[]>();
  for (const s of cards) groups.set(keyOf(s), [...(groups.get(keyOf(s)) ?? []), s]);
  // a project gets its group for its shells, or for an agent session running in one of them
  const shellProjects = [...projectShells.keys(), ...loose.map(looseProject).filter((p): p is string => !!p)];
  if (grouping === "project") for (const p of shellProjects) if (!groups.has(p)) groups.set(p, []);
  const statusRank = (k: string) => board?.statuses.find((st) => st.key === k)?.sort_key ?? k;
  const keys = [...groups.keys()].sort((a, b) =>
    a === null ? 1 : b === null ? -1 : grouping === "status"
      ? statusRank(a).localeCompare(statusRank(b))
      : projectName(board, a).localeCompare(projectName(board, b))
  );
  const label = (key: string | null) =>
    grouping === "status"
      ? (board?.statuses.find((st) => st.key === key)?.label ?? key ?? "").toUpperCase()
      : key ? projectName(board, key).toUpperCase() : "NO PROJECT";
  // the card's tab to drag onto the panes: the shown one when it has it
  const tabOf = (card: string) => {
    const own = tabs.filter((t) => tabCards(t, terms).includes(card));
    return (own.find((t) => t.id === active) ?? own[0])?.id;
  };
  const plain = plainShells.count;
  // the + starts in the selected card's repo, or the selected project
  const selectedCard = selected ? board?.sessions.find((s) => s.id === selected) : undefined;
  const everyShell = Object.values(terms);
  // right-clicking a group of shells links the focused one when it is in the group, else its only one
  const focused = tabs.find((t) => t.id === active)?.focus;
  const linkable = (inGroup: (t: (typeof everyShell)[number]) => boolean) => {
    const group = everyShell.filter(inGroup);
    const target = group.find((t) => t.id === focused) ?? (group.length === 1 ? group[0] : undefined);
    return target
      ? (e: React.MouseEvent) => {
        e.preventDefault();
        setLinkFor(target.id);
      }
      : undefined;
  };
  const plainShell = (t: (typeof everyShell)[number]) =>
    !(t.card && known.has(t.card)) && !(t.project && knownProjects.has(t.project));
  const projectRow = (p: string, label: string) => (
    <div key={`project:${p}`} onContextMenu={linkable((t) => !(t.card && known.has(t.card)) && t.project === p)}>
      {row(`project:${p}`, selectedProject === p, () => onSelectProject(p), (
        <span className="flex w-full items-center gap-2">
          <span className="w-[7px] text-center text-ink-faint">·</span>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {count(projectShells.get(p))}
        </span>
      ))}
    </div>
  );

  const row = (key: string, active: boolean, onClick: () => void, children: React.ReactNode, drag?: TermDrag) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      draggable={!!drag}
      title={drag ? "drag into the terminal area: beside a pane, or onto the empty view" : undefined}
      onDragStart={drag
        ? (e) => {
          e.dataTransfer.setData("application/x-trame-card", drag.id);
          e.dataTransfer.effectAllowed = "move";
          setTermDrag(drag);
        }
        : undefined}
      onDragEnd={drag ? () => setTermDrag(null) : undefined}
      className={`flex w-full flex-col rounded-md px-2 py-1.5 text-left text-[12.5px] ${
        active ? "bg-active-row font-medium text-ink" : "text-ink-muted hover:text-ink-soft"
      }`}
    >
      {children}
    </button>
  );
  // laid out like a card row: what it is, then the agent line
  const sessionRow = (x: TermSession) => (
    <div
      key={`term:${x.term}:${x.id}`}
      title="right-click: link to a card"
      onContextMenu={(e) => {
        e.preventDefault();
        setLinkFor(x.term);
      }}
    >
      {row(`term:${x.term}:${x.id}`, selectedTerm === x.term, () => {
      onSelectTerm(x.term);
      void revealTerminal(x.term);
    }, (
      <>
        <span className="flex w-full items-center gap-2" title={`${x.agent} · ${x.id}`}>
          <span
            className={`h-[7px] w-[7px] shrink-0 rounded-full ${x.waiting ? "bg-wait" : x.busy ? "bg-live" : "bg-ink-faint"}`}
          />
          <span className="min-w-0 flex-1 truncate">{sessionLabel(x)}</span>
        </span>
        <span className={`flex w-full items-center gap-1.5 pl-[15px] pt-0.5 text-[11px] ${x.waiting ? "text-wait" : "text-ink-faint"}`}>
          <AgentIcon a={{ harness: x.agent, icon: null }} />
          <span className="min-w-0 flex-1 truncate">
            {x.waiting ? `needs you: ${x.waiting}` : x.busy ? "working" : "idle"}
          </span>
          {x.started_at && <span className="shrink-0 font-mono text-[10px] tabular-nums">{age(x.started_at)}</span>}
        </span>
      </>
    ))}
    </div>
  );
  const count = (n?: { count: number; running: number }) =>
    n && (
      <span
        className={`ml-auto shrink-0 text-[10.5px] tabular-nums ${n.running ? "text-live" : "text-ink-faint"}`}
        title={`${n.running} running of ${n.count}`}
      >
        ›_ {n.count}
      </span>
    );

  return (
    <nav aria-label="Cards with terminals" className="flex flex-col gap-3">
      {(asking.length > 0 || askingCards.length > 0) && (
        <section className="flex flex-col gap-0.5">
          <div className={`px-2 pb-1 ${SECTION_LABEL} text-wait`}>NEEDS YOU · {asking.length + askingCards.length}</div>
          {askingCards.map((l) => {
            const s = board!.sessions.find((x) => x.id === l.a.session_id)!;
            return row(`ask:${s.id}`, s.id === selected, () => onSelect(s.id), (
              <>
                <span className="flex w-full items-center gap-2">
                  <StatusDot status={s.status} size={7} />
                  <span className="min-w-0 flex-1 truncate" title={s.title}>{s.title}</span>
                  {count(shells.get(s.id))}
                </span>
                <AgentLine l={l} />
              </>
            ));
          })}
          {asking.filter((x) => !askingCards.some((l) => l.a.session_id === terms[x.term]?.card)).map(sessionRow)}
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
          RUNNING
          {everyShell.length > 0 && count({ count: everyShell.length, running: everyShell.filter((t) => !t.exited).length })}
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
      {cards.length === 0 && plain === 0 && projectShells.size === 0 && loose.length === 0 && (
        <p className="px-2 text-[11.5px] leading-snug text-ink-muted">
          Nothing running. Start one with + above (Ctrl+T), or resume one below.
        </p>
      )}
      {keys.map((key) => (
        <section key={key ?? "none"} className="flex flex-col gap-0.5">
          {grouping !== "none" && (
            <div
              className={`relative flex items-center gap-1.5 px-2 pb-1 ${SECTION_LABEL}`}
              title={grouping === "project" && key ? "right-click: new terminal in this project" : undefined}
              onContextMenu={grouping === "project" && key
                ? (e) => {
                  e.preventDefault();
                  setMenuFor(key);
                }
                : undefined}
            >
              {grouping === "project" && key && <EntityIcon icon={board?.projects.find((p) => p.id === key)?.icon} size={14} />}
              {label(key)}
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
          {grouping === "project" && key && projectShells.has(key) && projectRow(key, "Project shells")}
          {key && loose.filter((x) => looseProject(x) === key).map(sessionRow)}
          {groups.get(key)!.map((s) => {
            return (
              <div key={s.id} onContextMenu={linkable((t) => t.card === s.id)}>
                {row(s.id, s.id === selected, () => onSelect(s.id), (
                  <>
                    <span className="flex w-full items-center gap-2">
                      <StatusDot status={s.status} size={7} />
                      <span className="min-w-0 flex-1 truncate" title={s.title}>{s.title}</span>
                      {count(shells.get(s.id))}
                    </span>
                    <AgentLine l={agentOf.get(s.id)} />
                  </>
                ), { kind: "card", id: s.id, tab: tabOf(s.id) ?? null, cwd: s.repo_path ?? null })}
              </div>
            );
          })}
        </section>
      ))}
      {(plain > 0 || other.length > 0 || (grouping !== "project" && projectShells.size > 0)) && (
        <section className="flex flex-col gap-0.5">
          <div className={`px-2 pb-1 ${SECTION_LABEL}`}>OTHER</div>
          {grouping !== "project" && [...projectShells.keys()].map((p) => projectRow(p, `${projectName(board, p)} shells`))}
          {other.map(sessionRow)}
          {plain > 0 && (
            <div onContextMenu={linkable(plainShell)}>
              {row("plain", selected === null && !selectedProject && !all && !selectedTerm, () => onSelect(null), (
                <span className="flex w-full items-center gap-2">
                  <span className="w-[7px] text-center text-ink-faint">·</span>
                  <span className="flex-1">Shells without a card</span>
                  {count(plainShells)}
                </span>
              ))}
            </div>
          )}
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

// the card's live agent under its title: what it runs, or that it waits for you
function AgentLine({ l }: { l: Live | undefined }) {
  if (!l) return null;
  const waiting = l.state === "waiting";
  return (
    <span className={`flex w-full items-center gap-1.5 pl-[15px] pt-0.5 text-[11px] ${waiting ? "text-wait" : "text-ink-faint"}`}>
      <AgentIcon a={l.a} />
      <span className="min-w-0 flex-1 truncate" title={l.a.question ?? l.a.step ?? undefined}>
        {waiting ? `needs you: ${l.a.question ?? "waiting for input"}` : l.a.model ?? l.a.harness}
      </span>
      <span className="shrink-0 font-mono text-[10px] tabular-nums">
        <Elapsed since={l.a.since} state={l.state} />
      </span>
    </span>
  );
}

// how long ago, coarse: 4m, 2h, 3d
const age = (since: number) => {
  const m = Math.max(1, Math.round((Date.now() - since) / 60_000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};
