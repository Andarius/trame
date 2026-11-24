import { useState } from "react";
import type { BoardData, ClaudeSession } from "../api";
import { RecentList } from "../agents/RecentList";
import { AgentIcon, Elapsed, type Live, useAgents } from "../agents/agents";
import { GroupMenu } from "../ui/GroupMenu";
import { FolderIcon } from "../ui/icons";
import { appConfirm, BOOL_CODEC, EntityIcon, enumCodec, MenuRow, Popover, SECTION_LABEL, SET_CODEC, useLocalStorage } from "../ui/ui";
import { LinkCardDialog } from "./LinkCardDialog";
import { NewTerminalDialog } from "./NewTerminalDialog";
import { closeTerminal, revealTerminal, sessionLabel, type TermSession, useTermDock, useTermSessions } from "./term-api";

// by project with a folder per repo, by project and repo, by project (the repo on each agent's line), or not at all
const GROUPINGS = ["tree", "paths", "project", "none"] as const;
type Grouping = typeof GROUPINGS[number];
const GROUPING_LABEL: Record<Grouping, string> = {
  tree: "Project › repo",
  paths: "Project / repo",
  project: "Project",
  none: "No grouping",
};
const SPACINGS = ["comfortable", "compact"] as const;
type Spacing = typeof SPACINGS[number];
const SPACING_LABEL: Record<Spacing, string> = { comfortable: "Comfortable", compact: "Compact" };
// plain shells (no agent in them): a folded section at the bottom, or not listed at all
const SHELLS = ["show", "hide"] as const;
type Shells = typeof SHELLS[number];
const SHELLS_LABEL: Record<Shells, string> = { show: "Folded section", hide: "Hidden" };
// what the menu's preview draws when no agent runs
const SAMPLE = [
  { name: "invoice-export", project: "Acme", repo: "api", what: "sonnet · working", working: true },
  { name: "landing-copy", project: "Acme", repo: "web", what: "idle", working: false },
  { name: "cluster-upgrade", project: "Atlas", repo: "infra", what: "opus · working", working: true },
];

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
  const [grouping, setGrouping] = useLocalStorage<Grouping>("trame:termGrouping", "tree", enumCodec(GROUPINGS));
  const [spacing, setSpacing] = useLocalStorage<Spacing>("trame:termSpacing", "comfortable", enumCodec(SPACINGS));
  const [shells, setShells] = useLocalStorage<Shells>("trame:termShells", "show", enumCodec(SHELLS));
  const [shellsOpen, setShellsOpen] = useLocalStorage("trame:termShellsOpen", false, BOOL_CODEC);
  const gap = spacing === "compact" ? "gap-0" : "gap-1";
  const byProject = grouping !== "none";
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
  // a project's agents by repo: their card's, else the folder their shell started in; a worktree counts as its repo
  const repoOf = (x: TermSession) => {
    const t = terms[x.term];
    return repoName((t?.card && cardOf.get(t.card)?.repo_path) || t?.cwd || null);
  };
  // one section per project, or per project and repo with "Project / repo"
  type Group = { key: string; project: string | null; repo: string | null; xs: TermSession[] };
  const groups = new Map<string, Group>();
  for (const x of running) {
    const project = byProject ? projectOf(x) : null;
    const repo = grouping === "paths" ? repoOf(x) : null;
    const key = byProject ? `${project ?? ""}/${repo ?? ""}` : "all";
    const g = groups.get(key) ?? { key, project, repo, xs: [] };
    g.xs.push(x);
    groups.set(key, g);
  }
  const last = (a: string | null, b: string | null, cmp: (a: string, b: string) => number) =>
    a === b ? 0 : a === null ? 1 : b === null ? -1 : cmp(a, b);
  const sections = [...groups.values()].sort((a, b) =>
    last(a.project, b.project, (x, y) => projectName(board, x).localeCompare(projectName(board, y))) ||
    last(a.repo, b.repo, (x, y) => x.localeCompare(y))
  );
  const byRepo = (xs: TermSession[]) => {
    const m = new Map<string | null, TermSession[]>();
    for (const x of xs) m.set(repoOf(x), [...(m.get(repoOf(x)) ?? []), x]);
    return [...m].sort(([a], [b]) => last(a, b, (x, y) => x.localeCompare(y)));
  };
  const label = (project: string | null) => (project ? projectName(board, project).toUpperCase() : "NO PROJECT");
  // agents running in a terminal outside Trame: a card's presence with no shell here, waiting ones first
  const shelled = new Set(Object.values(terms).map((t) => t.card));
  const outside = live.filter((l) => cardOf.has(l.a.session_id) && !shelled.has(l.a.session_id)).sort((a, b) =>
    Number(b.state === "waiting") - Number(a.state === "waiting")
  );
  const selectedCard = selected ? cardOf.get(selected) : undefined;
  const everyShell = Object.values(terms);
  // shells with no agent in them, running ones first
  const agentTerms = new Set(termSessions.map((x) => x.term));
  const plain = everyShell.filter((t) => !agentTerms.has(t.id)).sort((a, b) => Number(a.exited) - Number(b.exited));

  const closeShell = async (term: string) => {
    if (!(await appConfirm("Close this shell? The agent running in it stops.", "Close"))) return;
    await closeTerminal(term);
  };
  const row = (key: string, active: boolean, onClick: () => void, children: React.ReactNode) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      className={`flex w-full flex-col rounded-md px-2 ${spacing === "compact" ? "py-1" : "py-2"} text-left text-[12.5px] ${
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
            <AgentLine l={l} x={x} repo={grouping === "project" || grouping === "none" ? repoOf(x) : null} />
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
  // a shell with no agent in it: its title, and the folder it started in
  const shellRow = (t: (typeof plain)[number]) => (
    <div
      key={`shell:${t.id}`}
      className={t.exited ? "opacity-50 hover:opacity-100" : ""}
      title="right-click: link to a card, close"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu(`shell:${t.id}`);
      }}
    >
      {menu === `shell:${t.id}` && (
        <Popover portal onClose={() => setMenu(null)} className="w-44">
          <MenuRow
            onClick={() => {
              setLinkFor(t.id);
              setMenu(null);
            }}
          >
            Link to card…
          </MenuRow>
          <MenuRow
            className="hover:text-blocked"
            onClick={() => {
              setMenu(null);
              void closeTerminal(t.id);
            }}
          >
            Close shell
          </MenuRow>
        </Popover>
      )}
      {row(`shell:${t.id}`, selectedTerm === t.id, () => {
        onSelectTerm(t.id, t.title);
        void revealTerminal(t.id);
      }, (
        <span className="flex w-full items-center gap-2" title={t.cwd}>
          <span className="w-[7px] shrink-0 text-center font-mono text-[10px] leading-none text-ink-faint">$</span>
          <span className="min-w-0 flex-1 truncate">{t.title}</span>
          <span className="shrink-0 truncate text-[11px] text-ink-faint">{t.exited ? "exited" : repoName(t.cwd) === t.title ? "" : repoName(t.cwd)}</span>
        </span>
      ))}
    </div>
  );
  const gkey = (key: string | null) => `${grouping}:${key ?? ""}`;
  const agents = termSessions.length + outside.length;
  // the sliders menu's picture of the list: the first agents (else a sample) as `g` and `space` lay them out
  const preview = (g: Grouping, more: Record<string, string>) => {
    const real = running.slice(0, 3).map((x) => {
      const working = liveOf(x)?.state === "working" || x.busy;
      return {
        name: sessionLabel(x),
        project: projectOf(x) ? projectName(board, projectOf(x)!) : "No project",
        repo: repoOf(x) ?? "",
        what: [shortModel(liveOf(x)?.a.model), working ? "working" : x.done ? "done" : "idle"].filter(Boolean).join(" · "),
        working,
      };
    });
    const xs = real.length ? real : SAMPLE;
    const roomy = more.spacing !== "compact";
    const item = (x: typeof xs[number], repoOnLine: boolean) => (
      <div key={x.name} className={`flex flex-col ${roomy ? "py-1" : "py-px"}`}>
        <span className="flex items-center gap-1.5 truncate text-[11.5px] text-ink-soft">
          <span className={`h-[5px] w-[5px] shrink-0 rounded-full ${x.working ? "bg-live" : "bg-ink-faint"}`} />
          {x.name}
        </span>
        <span className="truncate pl-[11px] text-[10px] text-ink-faint">{repoOnLine && x.repo ? `${x.repo} · ${x.what}` : x.what}</span>
      </div>
    );
    const head = (t: string, sub?: string) => (
      <div className={`truncate pt-1 text-[9.5px] tracking-[0.08em] text-ink-faint ${roomy ? "pb-0.5" : ""}`}>
        {t.toUpperCase()}
        {sub && <span className="tracking-normal text-ink-muted">{` / ${sub}`}</span>}
      </div>
    );
    const shellsHead = more.shells === "show" && (
      <div className="mt-1.5 flex items-center gap-1 border-t border-line pt-1.5 text-[9.5px] tracking-[0.08em] text-ink-faint">
        SHELLS · {plain.length || 2} <span className="ml-auto">▸</span>
      </div>
    );
    if (g === "none") return <div className="flex flex-col">{xs.map((x) => item(x, true))}{shellsHead}</div>;
    const by = new Map<string, typeof xs>();
    for (const x of xs) {
      const k = g === "paths" ? `${x.project}\u0000${x.repo}` : x.project;
      by.set(k, [...(by.get(k) ?? []), x]);
    }
    return (
      <div className="flex flex-col">
        {[...by.values()].map((ys) => (
          <div key={`${ys[0].project}/${g === "paths" ? ys[0].repo : ""}`}>
            {head(ys[0].project, g === "paths" ? ys[0].repo : undefined)}
            {g === "tree"
              ? [...new Set(ys.map((y) => y.repo))].map((r) => (
                <div key={r}>
                  <div className="flex items-center gap-1 pt-0.5 text-[10.5px] text-ink-faint"><FolderIcon size={10} />{r}</div>
                  <div className="ml-[5px] border-l border-line pl-1.5">{ys.filter((y) => y.repo === r).map((y) => item(y, false))}</div>
                </div>
              ))
              : ys.map((y) => item(y, g === "project"))}
          </div>
        ))}
        {shellsHead}
      </div>
    );
  };

  return (
    <nav aria-label="Running agents" className="flex flex-col gap-3">
      {asking.length > 0 && (
        <section className={`flex flex-col ${gap}`}>
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
        <GroupMenu
          value={grouping}
          options={GROUPING_LABEL}
          onChange={setGrouping}
          more={[{
            key: "spacing",
            label: "ROW SPACING",
            value: spacing,
            options: SPACING_LABEL,
            onChange: (v) => setSpacing(v as Spacing),
          }, {
            key: "shells",
            label: "PLAIN SHELLS",
            value: shells,
            options: SHELLS_LABEL,
            onChange: (v) => setShells(v as Shells),
          }]}
          preview={preview}
        />
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
      {sections.map(({ key, project, repo, xs }) => (
        <section key={key} className={`flex flex-col ${gap}`}>
          {grouping !== "none" && (
            <div className={`group/head relative flex items-center gap-1.5 px-2 pb-1 ${SECTION_LABEL}`}>
              <button
                type="button"
                className="group/fold flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-ink-soft"
                aria-expanded={!folded.has(gkey(key))}
                title={folded.has(gkey(key)) ? "show this group" : "fold this group"}
                onClick={() => flip(folded, setFolded, gkey(key))}
              >
                {project && <EntityIcon icon={board?.projects.find((p) => p.id === project)?.icon} size={14} />}
                <span className="truncate">
                  {label(project)}
                  {repo && <span className="normal-case tracking-normal text-ink-soft">{` / ${repo}`}</span>}
                </span>
                <span
                  aria-hidden="true"
                  className={`text-[10px] leading-none ${folded.has(gkey(key)) ? "" : "opacity-0 group-hover/fold:opacity-100"}`}
                >
                  {folded.has(gkey(key)) ? "▸" : "▾"}
                </span>
                <span className="ml-auto pr-1 tracking-normal tabular-nums text-ink-faint">{xs.length}</span>
              </button>
              {project && (
                <button
                  type="button"
                  onClick={() => setMenuFor(key)}
                  title="new terminal or agent in this project"
                  aria-label={`New terminal in ${label(project)}`}
                  className={`-my-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[15px] leading-none text-ink-muted hover:bg-active-row hover:text-ink ${
                    menuFor === key ? "" : "opacity-0 focus-visible:opacity-100 group-hover/head:opacity-100"
                  }`}
                >
                  +
                </button>
              )}
              {project && menuFor === key && (
                <NewTerminalDialog
                  board={board}
                  project={project}
                  onClose={() => setMenuFor(null)}
                  onOpened={(card, project) => (card ? onSelect(card) : project ? onSelectProject(project) : onSelect(null))}
                />
              )}
            </div>
          )}
          {!folded.has(gkey(key)) && (grouping === "tree"
            ? byRepo(xs).map(([r, rs]) =>
              r === null ? rs.map(agentRow) : (
                <div key={r} className={`flex flex-col ${gap}`}>
                  <div className="flex items-center gap-1.5 px-2 pt-0.5 text-[11.5px] text-ink-faint" title={`agents in ${r}`}>
                    <FolderIcon size={12} />
                    <span className="min-w-0 flex-1 truncate">{r}</span>
                  </div>
                  <div className={`ml-[13px] flex flex-col ${gap} border-l border-line pl-1`}>{rs.map(agentRow)}</div>
                </div>
              )
            )
            : xs.map(agentRow))}
        </section>
      ))}
      {outside.length > 0 && (
        <section className={`flex flex-col ${gap}`}>
          <div className="mx-2 mb-1 border-t border-dashed border-line" />
          <div className={`flex items-center px-2 pb-1 ${SECTION_LABEL}`} title="agents running in a terminal outside Trame">
            OUTSIDE TRAME
            <span className="ml-auto tracking-normal tabular-nums">{outside.length}</span>
          </div>
          {outside.map(outsideRow)}
        </section>
      )}
      {shells === "show" && plain.length > 0 && (
        <section className={`flex flex-col ${gap}`}>
          <button
            type="button"
            className={`group/fold flex items-center gap-1.5 px-2 pb-1 text-left ${SECTION_LABEL} hover:text-ink-soft`}
            aria-expanded={shellsOpen}
            title={shellsOpen ? "fold the shells" : "show the shells with no agent in them"}
            onClick={() => setShellsOpen(!shellsOpen)}
          >
            SHELLS
            <span aria-hidden="true" className={`text-[10px] leading-none ${shellsOpen ? "opacity-0 group-hover/fold:opacity-100" : ""}`}>
              {shellsOpen ? "▾" : "▸"}
            </span>
            <span className="ml-auto pr-1 tracking-normal tabular-nums text-ink-faint">{plain.length}</span>
          </button>
          {shellsOpen && plain.map(shellRow)}
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

// the repo a folder belongs to, by name: a worktree <repo>/.scratch/<wt> (or .worktrees/, .claude/worktrees/) is <repo>
const repoName = (path: string | null) => {
  if (!path) return null;
  const root = path.replace(/\/+$/, "").replace(/\/(\.scratch|\.worktrees|\.claude\/worktrees)\/[^/]+$/, "");
  return root.split("/").pop() || null;
};

const projectName = (board: BoardData | null, id: string) => board?.projects.find((p) => p.id === id)?.name ?? "";
const seen = (x: TermSession) => x.updated_at ?? x.started_at ?? 0;

// under an agent's name: its model and state, how long, then what it does (or asks) on a second line;
// `l` is its card's presence from the hooks, `x` what Trame reads from the process itself
function AgentLine({ l, x, repo }: { l?: Live; x?: TermSession; repo?: string | null }) {
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
          {repo && `${repo} · `}
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
