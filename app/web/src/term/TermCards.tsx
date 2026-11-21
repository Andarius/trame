import { useState } from "react";
import type { BoardData, ClaudeSession, Session } from "../api";
import { RecentList } from "../agents/RecentList";
import { AgentIcon, Elapsed, type Live, useAgents } from "../agents/agents";
import { GroupMenu } from "../ui/GroupMenu";
import { appConfirm, BOOL_CODEC, EntityIcon, enumCodec, MenuRow, Popover, SECTION_LABEL, SET_CODEC, StatusDot, useLocalStorage } from "../ui/ui";
import { LinkCardDialog } from "./LinkCardDialog";
import { NewTerminalDialog } from "./NewTerminalDialog";
import { bundle } from "./together";
import { closeTerminal, revealTerminal, sessionLabel, setTermDrag, tabCards, type TermDrag, type TermSession, useTermDock, useTermSessions } from "./term-api";

const GROUPINGS = ["project", "status", "none"] as const;
type Grouping = typeof GROUPINGS[number];
const GROUPING_LABEL: Record<Grouping, string> = { project: "Project", status: "Status", none: "No grouping" };
// grouped by project: a header per project and repo ("Soren / track-backend"), or a coloured edge per project
const PROJECT_STYLES = ["paths", "edge"] as const;
type ProjectStyle = typeof PROJECT_STYLES[number];
const PROJECT_STYLE_LABEL: Record<ProjectStyle, string> = { paths: "Project / repo headers", edge: "Coloured project edge" };

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
    onSelectTerm: (term: string, name: string) => void; // Ctrl/⌘ held: opens it as a side tab
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
  const [projectStyle, setProjectStyle] = useLocalStorage<ProjectStyle>("trame:termProjectStyle", "paths", enumCodec(PROJECT_STYLES));
  // agents waiting on you listed once on top, out of their groups
  const [pinAsking, setPinAsking] = useLocalStorage("trame:termPinAsking", true, BOOL_CODEC);
  // group headers folded, and groups showing their idle cards (keyed by grouping:key)
  const [folded, setFolded] = useLocalStorage("trame:termFolded", new Set<string>(), SET_CODEC);
  const [idleOpen, setIdleOpen] = useLocalStorage("trame:termIdleOpen", new Set<string>(), SET_CODEC);
  const flip = (set: Set<string>, save: (v: Set<string>) => void, k: string) => {
    const next = new Set(set);
    if (!next.delete(k)) next.add(k);
    save(next);
  };
  const [menuFor, setMenuFor] = useState<string | null>(null); // the project right-clicked for a new terminal
  const [repoMenu, setRepoMenu] = useState<{ project: string; path: string } | null>(null); // a repo's + clicked
  const [newOpen, setNewOpen] = useState(false);
  const [linkFor, setLinkFor] = useState<string | null>(null); // the shell to link to a card
  // the row right-clicked: the shell it can link to a card, the shells it can close
  const [menu, setMenu] = useState<{ key: string; link?: string; close: string[]; what: string } | null>(null);
  const [marked, setMarked] = useState<string[]>([]); // cards Shift-clicked, to close their shells at once
  const [anchor, setAnchor] = useState<string | null>(null); // where a Shift-click range starts
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
  // agent sessions in shells no card on this board holds: one entry each
  const cardless = termSessions.filter((x) => {
    const card = terms[x.term]?.card;
    return !(card && known.has(card));
  });
  const seen = (x: TermSession) => x.updated_at ?? x.started_at ?? 0;
  const loose = cardless.filter((x) => !(pinAsking && x.waiting)).sort((a, b) => seen(b) - seen(a));
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
  // a card whose agent waits in a terminal outside Trame stays in OUTSIDE TRAME, flagged there
  const askingCards = live.filter((l) => l.state === "waiting" && known.has(l.a.session_id) && shells.has(l.a.session_id));
  const askingCard = new Set([
    ...askingCards.map((l) => l.a.session_id),
    ...asking.map((x) => terms[x.term]?.card).filter((c): c is string => !!c && known.has(c)),
  ]);
  // grouped by project, a session in a project's shell sits under that project, not OTHER
  const looseProject = (x: TermSession) => {
    const p = terms[x.term]?.project;
    return grouping === "project" && p && knownProjects.has(p) ? p : null;
  };
  const other = loose.filter((x) => !looseProject(x));
  const cards = (board?.sessions ?? []).filter((s) =>
    (shells.has(s.id) || agentOf.has(s.id) || s.id === selected) && !(pinAsking && askingCard.has(s.id))
  ).sort((a, b) => b.last_touched.localeCompare(a.last_touched));
  // cards whose agent runs in a terminal outside Trame get their own section, at the bottom
  const isOutside = (s: Session) => !shells.has(s.id) && agentOf.has(s.id);
  // the ones waiting for you first
  const outside = cards.filter(isOutside).sort((a, b) =>
    Number(agentOf.get(b.id)?.state === "waiting") - Number(agentOf.get(a.id)?.state === "waiting")
  );
  const keyOf = (s: Session) => grouping === "project" ? s.client_id : grouping === "status" ? s.status : "all";
  const groups = new Map<string | null, Session[]>();
  for (const s of cards.filter((s) => !isOutside(s))) groups.set(keyOf(s), [...(groups.get(keyOf(s)) ?? []), s]);
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
  const shellsOf = (inGroup: (t: (typeof everyShell)[number]) => boolean) => everyShell.filter(inGroup);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  // right-click: link the group's focused shell (else its only one) to a card, or close the group's shells
  const menuOn = (key: string, group: (typeof everyShell)[number][], what?: string) => {
    const link = what ? undefined : group.find((t) => t.id === focused) ?? (group.length === 1 ? group[0] : undefined);
    if (group.length === 0) return undefined;
    return (e: React.MouseEvent) => {
      e.preventDefault();
      setMenu({ key, link: link?.id, close: group.map((t) => t.id), what: what ?? plural(group.length, "shell") });
    };
  };
  const menuAt = (key: string) =>
    menu?.key === key && (
      <Popover portal onClose={() => setMenu(null)} className="w-44">
        {menu.link && (
          <MenuRow
            onClick={() => {
              setLinkFor(menu.link!);
              setMenu(null);
            }}
          >
            Link to card…
          </MenuRow>
        )}
        <MenuRow
          className="hover:text-blocked"
          onClick={() => {
            const { close, what } = menu;
            setMenu(null);
            void closeShells(close, what);
          }}
        >
          Close {menu.close.length === 1 ? "shell" : "shells"}
        </MenuRow>
      </Popover>
    );
  const plainShell = (t: (typeof everyShell)[number]) =>
    !(t.card && known.has(t.card)) && !(t.project && knownProjects.has(t.project));
  const projectRow = (p: string, label: string) => (
    <div
      key={`project:${p}`}
      className="relative"
      onContextMenu={menuOn(`project:${p}`, shellsOf((t) => !(t.card && known.has(t.card)) && t.project === p))}
    >
      {menuAt(`project:${p}`)}
      {row(`project:${p}`, selectedProject === p, () => onSelectProject(p), (
        <span className="flex w-full items-center gap-2">
          <span className="w-[7px] text-center text-ink-faint">·</span>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {count(projectShells.get(p))}
        </span>
      ))}
    </div>
  );

  // a group's cards without a live agent fold into one row, unless shown or one is selected or marked
  const gkey = (key: string | null) => `${grouping}:${key ?? ""}`;
  const isIdle = (s: Session) => !agentOf.has(s.id) && s.id !== selected && !marked.includes(s.id);
  const shownOf = (key: string | null) => {
    if (folded.has(gkey(key))) return [];
    const all = groups.get(key)!;
    return idleOpen.has(gkey(key)) ? all : all.filter((s) => !isIdle(s));
  };
  // grouped by project, its listed repos split its cards; cards in none of them come first
  const repoGroups = (key: string | null, list: Session[]) => {
    const repos = grouping === "project" && key ? board?.projects.find((p) => p.id === key)?.repos ?? [] : [];
    const ids = new Set(repos.map((r) => r.id));
    const of = (s: Session) => (s.repo_id && ids.has(s.repo_id) ? s.repo_id : null);
    return [
      { repo: null, list: list.filter((s) => of(s) === null) },
      ...repos.map((repo) => ({ repo, list: list.filter((s) => of(s) === repo.id) })),
    ].filter((g) => g.list.length > 0);
  };
  // where a row belongs: its project and, when it sits in one of the project's repos, that repo
  const projectOf = (id: string | null | undefined) => (id ? board?.projects.find((p) => p.id === id) : undefined);
  const repoName = (project: string | null | undefined, repo: string | null | undefined) =>
    repo ? projectOf(project)?.repos?.find((r) => r.id === repo)?.name ?? null : null;
  // a cardless session's repo: the project repo holding its shell's folder
  const looseRepo = (x: TermSession, project: string | null) => {
    const cwd = terms[x.term]?.cwd;
    if (!project || !cwd) return null;
    const inside = (projectOf(project)?.repos ?? []).filter((r) => r.path && (cwd === r.path || cwd.startsWith(`${r.path}/`)));
    return inside.sort((a, b) => b.path!.length - a.path!.length)[0]?.id ?? null;
  };
  const sessionProject = (x: TermSession) => {
    const card = terms[x.term]?.card;
    return (card && board?.sessions.find((s) => s.id === card)?.client_id) || terms[x.term]?.project || null;
  };
  // not grouped by project, each row says where it belongs
  const showWhere = grouping !== "project";
  // grouped by project with the coloured edge, each row names its repo on the right
  const repoTags = grouping === "project" && projectStyle === "edge";
  const where = (project: string | null | undefined, repo: string | null) => {
    const p = projectOf(project);
    if (!p) return null;
    return (
      <span className="flex w-full min-w-0 items-center gap-1 pl-[15px] pt-0.5 text-[11px] text-ink-faint">
        <EntityIcon icon={p.icon} size={11} />
        <span className="shrink-0">{p.name}</span>
        {repo && (
          <>
            <span>›</span>
            <span className="min-w-0 truncate text-ink-muted">{repo}</span>
          </>
        )}
      </span>
    );
  };
  const tag = (repo: string | null) => repoTags && repo && (
    <span className="min-w-0 max-w-[35%] truncate text-[11px] font-normal text-ink-faint" title={repo}>{repo}</span>
  );

  // listed card rows, top to bottom, for Shift-click ranges
  const order = [
    ...keys.flatMap((k) => repoGroups(k, shownOf(k)).flatMap((g) => g.list.map((s) => s.id))),
    ...outside.map((s) => s.id),
  ];
  const picked = marked.filter((id) => order.includes(id));
  // Shift: a range from the last clicked card; Ctrl/⌘+Shift: one more or less; Ctrl/⌘ alone: a side tab (App)
  const clickCard = (e: React.MouseEvent, id: string) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
      const base = picked.length === 0 && selected && order.includes(selected) ? [selected] : picked;
      setMarked(base.includes(id) ? base.filter((x) => x !== id) : [...base, id]);
      setAnchor(id);
    } else if (e.shiftKey) {
      const from = order.indexOf(anchor ?? selected ?? id);
      const to = order.indexOf(id);
      const [a, b] = from < 0 ? [to, to] : [Math.min(from, to), Math.max(from, to)];
      setMarked([...new Set([...picked, ...order.slice(a, b + 1)])]);
    } else {
      setMarked([]);
      setAnchor(id);
      onSelect(id);
    }
  };
  const closeShells = async (ids: string[], what: string) => {
    if (!(await appConfirm(`Close ${what}? Agents running in them stop.`, "Close"))) return;
    setMarked([]);
    for (const id of ids) await closeTerminal(id);
  };
  const markedShells = () => shellsOf((t) => !!t.card && picked.includes(t.card));
  const closeMarked = () => {
    const ids = markedShells().map((t) => t.id);
    return closeShells(ids, `${plural(ids.length, "shell")} of ${plural(picked.length, "card")}`);
  };

  const row = (
    key: string,
    active: boolean,
    onClick: (e: React.MouseEvent) => void,
    children: React.ReactNode,
    drag?: TermDrag,
    mark?: boolean,
  ) => (
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
      } ${mark ? "ring-1 ring-inset ring-copper/60 bg-copper/10" : ""}`}
    >
      {children}
    </button>
  );
  // laid out like a card row: what it is, then the agent line
  const sessionRow = (x: TermSession, pinned = false) => (
    <div
      key={`term:${x.term}:${x.id}`}
      className="relative"
      title="right-click: link to a card, close"
      onContextMenu={menuOn(`term:${x.term}:${x.id}`, shellsOf((t) => t.id === x.term))}
    >
      {menuAt(`term:${x.term}:${x.id}`)}
      {row(`term:${x.term}:${x.id}`, selectedTerm === x.term, () => {
      onSelectTerm(x.term, sessionLabel(x));
      void revealTerminal(x.term);
    }, (
      <>
        <span className="flex w-full items-center gap-2" title={`${x.agent} · ${x.id}`}>
          {x.done && !x.busy && !x.waiting
            ? <span className="w-[7px] shrink-0 text-center text-[10px] leading-none text-live" title="done: no follow-ups">✓</span>
            : (
              <span
                className={`h-[7px] w-[7px] shrink-0 rounded-full ${x.waiting ? "bg-wait" : x.busy ? "bg-live" : "bg-ink-faint"}`}
              />
            )}
          <span className="min-w-0 flex-1 truncate">{sessionLabel(x)}</span>
          {tag(repoName(sessionProject(x), looseRepo(x, sessionProject(x))))}
        </span>
        <span className={`flex w-full items-center gap-1.5 pl-[15px] pt-0.5 text-[11px] ${x.waiting ? "text-wait" : x.done && !x.busy ? "text-live/80" : "text-ink-faint"}`}>
          <AgentIcon a={{ harness: x.agent, icon: null }} />
          <span className="min-w-0 flex-1 truncate">
            {x.waiting ? `needs you: ${x.waiting}` : x.busy ? "working" : x.done ? "done" : "idle"}
          </span>
          {seen(x) > 0 && <span className="shrink-0 font-mono text-[10px] tabular-nums" title="last update">{age(seen(x))}</span>}
        </span>
        {(showWhere || pinned) && where(sessionProject(x), repoName(sessionProject(x), looseRepo(x, sessionProject(x))))}
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

  const cardRow = (s: Session, dim = false) => (
    <div
      key={s.id}
      className={`relative ${dim ? "opacity-60 hover:opacity-100" : ""}`}
      onContextMenu={picked.length > 1 && picked.includes(s.id)
        ? menuOn(s.id, markedShells(), `${plural(markedShells().length, "shell")} of ${plural(picked.length, "card")}`)
        : menuOn(s.id, shellsOf((t) => t.card === s.id))}
    >
      {menuAt(s.id)}
      {row(s.id, s.id === selected, (e) => clickCard(e, s.id), (
        <>
          <span className="flex w-full items-center gap-2">
            <StatusDot status={s.status} size={7} />
            <span className="min-w-0 flex-1 truncate" title={s.title}>{s.title}</span>
            {tag(repoName(s.client_id, s.repo_id))}
            {count(shells.get(s.id)) ?? (isOutside(s) && <Outside />)}
          </span>
          <AgentLine l={agentOf.get(s.id)} />
          {showWhere && where(s.client_id, repoName(s.client_id, s.repo_id))}
        </>
      ), { kind: "card", id: s.id, tab: tabOf(s.id) ?? null, cwd: s.repo_path ?? null }, picked.includes(s.id))}
    </div>
  );

  // a project-grouping header: folds its rows; + opens New terminal there (in the repo, for a repo's header)
  const head = (fold: string, title: React.ReactNode, n: number, project: string, repoPath?: string | null) => (
    <div
      key={`head:${fold}`}
      className={`group/head relative flex items-center gap-1.5 px-2 pb-1 ${SECTION_LABEL}`}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuFor(project);
      }}
    >
      <button
        type="button"
        className="group/fold flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-ink-soft"
        aria-expanded={!folded.has(fold)}
        title={folded.has(fold) ? "show this group" : "fold this group"}
        onClick={() => flip(folded, setFolded, fold)}
      >
        {title}
        <span aria-hidden="true" className={`text-[10px] leading-none ${folded.has(fold) ? "" : "opacity-0 group-hover/fold:opacity-100"}`}>
          {folded.has(fold) ? "▸" : "▾"}
        </span>
        <span className="ml-auto pr-1 tracking-normal tabular-nums text-ink-faint">{n || ""}</span>
      </button>
      <button
        type="button"
        onClick={() => (repoPath ? setRepoMenu({ project, path: repoPath }) : setMenuFor(project))}
        title={repoPath ? "new terminal or agent in this repo" : "new terminal or agent in this project"}
        aria-label={`New terminal in ${fold}`}
        className="-my-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[15px] leading-none text-ink-muted opacity-0 hover:bg-active-row hover:text-ink focus-visible:opacity-100 group-hover/head:opacity-100"
      >
        +
      </button>
    </div>
  );
  // grouped by project: "Project / repo" headers, or one coloured edge per project with the repo on each row
  const projectSection = (key: string) => {
    const p = projectOf(key);
    const icon = <EntityIcon icon={p?.icon} size={14} />;
    const all = groups.get(key)!;
    const list = idleOpen.has(gkey(key)) ? all : all.filter((s) => !isIdle(s));
    const sessions = loose.filter((x) => looseProject(x) === key);
    const repos = p?.repos ?? [];
    const repoOf = (s: Session) => (s.repo_id && repos.some((r) => r.id === s.repo_id) ? s.repo_id : null);
    const rows = (repo: string | null) => [
      ...sessions.filter((x) => looseRepo(x, key) === repo).map((x) => sessionRow(x)),
      ...bundle(list.filter((s) => repoOf(s) === repo), (s) => tabOf(s.id)).map((b) =>
        b.length === 1 ? cardRow(b[0]) : (
          <div
            key={`tab:${b[0].id}`}
            title="these cards' shells share one terminal tab"
            className="ml-1 flex flex-col rounded-l-sm border-l-2 border-copper/70 pl-1"
          >
            {b.map((s) => cardRow(s))}
          </div>
        )
      ),
    ];
    const shellsRow = projectShells.has(key) && projectRow(key, "Project shells");
    const idle = all.some(isIdle) && (
      <button
        type="button"
        className="mx-2 flex items-center gap-1.5 rounded-md border border-line px-2 py-0.5 text-left text-[11px] text-ink-faint hover:text-ink-soft"
        title="cards with shells but no live agent"
        onClick={() => flip(idleOpen, setIdleOpen, gkey(key))}
      >
        <span className="flex-1">{idleOpen.has(gkey(key)) ? "Hide idle cards" : `${all.filter(isIdle).length} idle`}</span>
        <span>{idleOpen.has(gkey(key)) ? "▴" : "›"}</span>
      </button>
    );
    const dialogs = (
      <>
        {menuFor === key && (
          <NewTerminalDialog
            board={board}
            project={key}
            onClose={() => setMenuFor(null)}
            onOpened={(card, project) => (card ? onSelect(card) : project ? onSelectProject(project) : onSelect(null))}
          />
        )}
        {repoMenu?.project === key && (
          <NewTerminalDialog
            board={board}
            project={key}
            folder={repoMenu.path}
            onClose={() => setRepoMenu(null)}
            onOpened={(card, project) => (card ? onSelect(card) : project ? onSelectProject(project) : onSelect(null))}
          />
        )}
      </>
    );
    const name = <span className="truncate normal-case tracking-normal text-[11.5px] text-ink-soft">{p?.name}</span>;
    if (projectStyle === "edge") {
      const body = [...rows(null), ...repos.flatMap((r) => rows(r.id))];
      return (
        <section key={key} className="flex flex-col gap-0.5">
          {head(gkey(key), <>{icon}{name}</>, body.length, key)}
          {!folded.has(gkey(key)) && (
            <div className="ml-2 flex flex-col gap-0.5 border-l-2 pl-1" style={{ borderColor: p?.color || edgeColor(key) }}>
              {shellsRow}
              {body}
              {idle}
            </div>
          )}
          {dialogs}
        </section>
      );
    }
    const bare = rows(null);
    const parts = repos.map((r) => ({ r, rows: rows(r.id) })).filter((x) => x.rows.length > 0);
    return (
      <section key={key} className="flex flex-col gap-0.5">
        {(bare.length > 0 || shellsRow || parts.length === 0) && head(gkey(key), <>{icon}{name}</>, bare.length, key)}
        {!folded.has(gkey(key)) && shellsRow}
        {!folded.has(gkey(key)) && bare}
        {parts.map(({ r, rows }) => {
          const fold = `${gkey(key)}/${r.id}`;
          return [
            head(
              fold,
              <>
                {icon}
                <span className="min-w-0 truncate normal-case tracking-normal text-[11.5px]">
                  <span className="text-ink-muted">{p?.name}</span>
                  <span className="text-ink-faint"> / </span>
                  <span className="text-ink">{r.name}</span>
                </span>
              </>,
              rows.length,
              key,
              r.path,
            ),
            !folded.has(fold) && rows,
          ];
        })}
        {idle}
        {dialogs}
      </section>
    );
  };

  return (
    <nav
      aria-label="Cards with terminals"
      className="flex flex-col gap-3"
      onKeyDown={(e) => {
        if (picked.length === 0) return;
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          void closeMarked();
        } else if (e.key === "Escape") setMarked([]);
      }}
    >
      {pinAsking && (asking.length > 0 || askingCards.length > 0) && (
        <section className="flex flex-col gap-0.5">
          <div className={`px-2 pb-1 ${SECTION_LABEL} text-wait`}>NEEDS YOU · {asking.length + askingCards.length}</div>
          {askingCards.map((l) => {
            const s = board!.sessions.find((x) => x.id === l.a.session_id)!;
            return row(`ask:${s.id}`, s.id === selected, () => onSelect(s.id), (
              <>
                <span className="flex w-full items-center gap-2">
                  <StatusDot status={s.status} size={7} />
                  <span className="min-w-0 flex-1 truncate" title={s.title}>{s.title}</span>
                  {count(shells.get(s.id)) ?? <Outside />}
                </span>
                <AgentLine l={l} />
                {where(s.client_id, repoName(s.client_id, s.repo_id))}
              </>
            ));
          })}
          {asking.filter((x) => !askingCards.some((l) => l.a.session_id === terms[x.term]?.card)).map((x) => sessionRow(x, true))}
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
          {everyShell.length > 0 && (
            <span title={`${everyShell.filter((t) => !t.exited).length} running of ${everyShell.length}`}>
              · {everyShell.length}
            </span>
          )}
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
        <GroupMenu value={grouping} options={GROUPING_LABEL} onChange={setGrouping}>
          <div className={`px-2 pb-1 pt-2 ${SECTION_LABEL}`}>PROJECTS AS</div>
          {PROJECT_STYLES.map((v) => (
            <MenuRow key={v} active={grouping === "project" && v === projectStyle} onClick={() => (setProjectStyle(v), setGrouping("project"))}>
              <span className="w-3 text-center">{grouping === "project" && v === projectStyle ? "✓" : ""}</span>
              <span className="flex-1">{PROJECT_STYLE_LABEL[v]}</span>
            </MenuRow>
          ))}
          <div className="my-1 h-px bg-line" />
          <MenuRow onClick={() => setPinAsking(!pinAsking)}>
            <span className="w-3 text-center">{pinAsking ? "✓" : ""}</span>
            <span className="flex-1">Pin “needs you” on top</span>
          </MenuRow>
        </GroupMenu>
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
      {picked.length > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-line px-2 py-1 text-[11.5px] text-ink-muted">
          <span className="flex-1">{picked.length} selected</span>
          <button type="button" className="rounded px-1.5 py-0.5 text-ink hover:bg-active-row" onClick={() => void closeMarked()} title="Delete">
            Close shells
          </button>
          <button type="button" className="rounded px-1 hover:bg-active-row hover:text-ink" aria-label="Clear selection" title="Esc" onClick={() => setMarked([])}>
            ✕
          </button>
        </div>
      )}
      {cards.length === 0 && plain === 0 && projectShells.size === 0 && loose.length === 0 && (
        <p className="px-2 text-[11.5px] leading-snug text-ink-muted">
          Nothing running. Start one with + above (Ctrl+T), or resume one below.
        </p>
      )}
      {keys.map((key) => grouping === "project" && key ? projectSection(key) : (
        <section key={key ?? "none"} className="flex flex-col gap-0.5">
          {grouping !== "none" && (
            <div
              className={`group/head relative flex items-center gap-1.5 px-2 pb-1 ${SECTION_LABEL}`}
              onContextMenu={grouping === "project" && key
                ? (e) => {
                  e.preventDefault();
                  setMenuFor(key);
                }
                : undefined}
            >
              <button
                type="button"
                className="group/fold flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-ink-soft"
                aria-expanded={!folded.has(gkey(key))}
                title={folded.has(gkey(key)) ? "show this group" : "fold this group"}
                onClick={() => flip(folded, setFolded, gkey(key))}
              >
                {grouping === "project" && key && <EntityIcon icon={board?.projects.find((p) => p.id === key)?.icon} size={14} />}
                <span className="truncate">{label(key)}</span>
                <span
                  aria-hidden="true"
                  className={`text-[10px] leading-none ${folded.has(gkey(key)) ? "" : "opacity-0 group-hover/fold:opacity-100"}`}
                >
                  {folded.has(gkey(key)) ? "▸" : "▾"}
                </span>
                <span className="ml-auto pr-1 tracking-normal tabular-nums text-ink-faint">{groups.get(key)!.length || ""}</span>
              </button>
              {grouping === "project" && key && (
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
          {!folded.has(gkey(key)) && (
            <>
              {grouping === "project" && key && projectShells.has(key) && projectRow(key, "Project shells")}
              {key && loose.filter((x) => looseProject(x) === key).map((x) => sessionRow(x))}
              {repoGroups(key, shownOf(key)).map((g) => [
                g.repo && (
                  <div
                    key={`repo:${g.repo.id}`}
                    className="group/repo flex items-center gap-1 px-2 pt-1 pl-4 text-[11px] text-ink-faint"
                    title={g.repo.path ?? `${g.repo.remote} · not checked out here`}
                  >
                    <span className="min-w-0 truncate">{g.repo.name}</span>
                    {g.repo.path && key && (
                      <button
                        type="button"
                        aria-label={`New terminal in ${g.repo.name}`}
                        className="ml-auto opacity-0 group-hover/repo:opacity-100 hover:text-ink focus-visible:opacity-100"
                        onClick={() => setRepoMenu({ project: key, path: g.repo!.path! })}
                      >
                        +
                      </button>
                    )}
                  </div>
                ),
                ...bundle(g.list, (s) => tabOf(s.id)).map((b) =>
                  b.length === 1 ? cardRow(b[0]) : (
                    <div
                      key={`tab:${b[0].id}`}
                      title="these cards' shells share one terminal tab"
                      className="ml-1 flex flex-col rounded-l-sm border-l-2 border-copper/70 pl-1"
                    >
                      {b.map((s) => cardRow(s))}
                    </div>
                  )
                ),
              ])}
              {key && repoMenu?.project === key && (
                <NewTerminalDialog
                  board={board}
                  project={key}
                  folder={repoMenu.path}
                  onClose={() => setRepoMenu(null)}
                  onOpened={(card, project) => (card ? onSelect(card) : project ? onSelectProject(project) : onSelect(null))}
                />
              )}
              {groups.get(key)!.some(isIdle) && (
                <button
                  type="button"
                  className="mx-2 flex items-center gap-1.5 rounded-md border border-line px-2 py-0.5 text-left text-[11px] text-ink-faint hover:text-ink-soft"
                  title="cards with shells but no live agent"
                  onClick={() => flip(idleOpen, setIdleOpen, gkey(key))}
                >
                  <span className="flex-1">
                    {idleOpen.has(gkey(key)) ? "Hide idle cards" : `${groups.get(key)!.filter(isIdle).length} idle`}
                  </span>
                  <span>{idleOpen.has(gkey(key)) ? "▴" : "›"}</span>
                </button>
              )}
            </>
          )}
        </section>
      ))}
      {(plain > 0 || other.length > 0 || (grouping !== "project" && projectShells.size > 0)) && (
        <section className="flex flex-col gap-0.5">
          <div className={`px-2 pb-1 ${SECTION_LABEL}`}>OTHER</div>
          {grouping !== "project" && [...projectShells.keys()].map((p) => projectRow(p, `${projectName(board, p)} shells`))}
          {other.map((x) => sessionRow(x))}
          {plain > 0 && (
            <div className="relative" onContextMenu={menuOn("plain", shellsOf(plainShell))}>
              {menuAt("plain")}
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
      {outside.length > 0 && (
        <section className="flex flex-col gap-0.5">
          <div className="mx-2 mb-1 border-t border-dashed border-line" />
          <div
            className={`flex items-center px-2 pb-1 ${SECTION_LABEL}`}
            title="cards whose agent runs in a terminal outside Trame"
          >
            OUTSIDE TRAME
            <span className="ml-auto tracking-normal tabular-nums">{outside.length}</span>
          </div>
          {outside.map((s) => cardRow(s, agentOf.get(s.id)?.state !== "waiting"))}
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

// a card listed for an agent running in a terminal outside Trame, not in one of its shells
function Outside() {
  return <span className="ml-auto shrink-0 text-ink-faint" title="its agent runs in a terminal outside Trame">↗</span>;
}

// a project without a colour still gets a stable edge colour of its own
const EDGES = ["#7bd88f", "#7aa7ff", "#c98a63", "#e5c07b", "#c792ea", "#4fd1c5"];
const edgeColor = (id: string) => EDGES[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % EDGES.length];

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
