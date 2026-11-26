import { useEffect, useState } from "react";
import type { BoardData, ClaudeSession } from "../api";
import { RecentList } from "../agents/RecentList";
import { AgentRuns } from "../agents/AgentRuns";
import { AgentIcon, Elapsed, type Live, useAgents } from "../agents/agents";
import { GroupMenu } from "../ui/GroupMenu";
import { FolderIcon, PinIcon, PlusIcon, PopOutIcon } from "../ui/icons";
import { appConfirm, BOOL_CODEC, EntityIcon, enumCodec, MenuRow, Popover, SECTION_LABEL, SET_CODEC, useLocalStorage } from "../ui/ui";
import { LinkCardDialog } from "./LinkCardDialog";
import { NewTerminalDialog } from "./NewTerminalDialog";
import { type Advice, closeTerminal, popOutGroup, repoName, showGroupPopout, type Fork, interruptTerminal, openTerminal, revealTerminal, type Subagent, termAdvices, termForks, termSubagents, sessionLabel, type TermSession, useTermDock, useTermSessions } from "./term-api";

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
// working agents' rows: a tinted background, or none
const TINTS = ["live", "copper", "off"] as const;
type Tint = typeof TINTS[number];
const TINT_LABEL: Record<Tint, string> = { live: "Green", copper: "Copper", off: "Off" };
const TINT_BG: Record<Tint, string> = { live: "rounded-md bg-live/[0.10]", copper: "rounded-md bg-copper/[0.12]", off: "" };
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
    agentRun,
    onSelectAgent,
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
    agentRun: string | null; // the agent-view run shown
    onSelectAgent: (run: string) => void;
  },
) {
  const { terms: dockTerms, out } = useTermDock();
  // projects whose agents are in a window of their own (TermGroupPopout)
  const popped = new Set(Object.values(out).flatMap((o) => (o.group ? [o.group] : [])));
  const [grouping, setGrouping] = useLocalStorage<Grouping>("trame:termGrouping", "tree", enumCodec(GROUPINGS));
  const [spacing, setSpacing] = useLocalStorage<Spacing>("trame:termSpacing", "comfortable", enumCodec(SPACINGS));
  const [tint, setTint] = useLocalStorage<Tint>("trame:termRunningTint", "live", enumCodec(TINTS));
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
  // agents kept at the top of the list, by session id
  const [pinned, setPinned] = useLocalStorage("trame:termPinned", new Set<string>(), SET_CODEC);
  // "<agent session>\n<follow-up>" → the shell started on it
  const [started, setStarted] = useLocalStorage<Record<string, string>>("trame:termFollowStarted", {}, FOLLOW_CODEC);
  const [menuFor, setMenuFor] = useState<string | null>(null); // the project right-clicked for a new terminal
  const [newOpen, setNewOpen] = useState(false);
  const [linkFor, setLinkFor] = useState<string | null>(null); // the shell to link to a card
  const [menu, setMenu] = useState<string | null>(null); // the agent row right-clicked
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | undefined>(); // where it was right-clicked
  const { live } = useAgents();
  const agentOf = new Map<string, Live>(live.map((l) => [l.a.session_id, l]));
  const cardOf = new Map(board?.sessions.map((s) => [s.id, s]));
  const knownProjects = new Set(board?.projects.map((p) => p.id));
  const termSessions = useTermSessions();
  // a shell opened before its agent's card existed: linked through the agent's session id
  const byAgent = new Map([
    ...(board?.sessions.flatMap((s): [string, string][] => (s.claude_id ? [[s.claude_id, s.id]] : [])) ?? []),
    ...live.flatMap((l): [string, string][] => (l.a.agent_id ? [[l.a.agent_id, l.a.session_id]] : [])),
  ]);
  const terms = { ...dockTerms };
  for (const x of termSessions) {
    const t = terms[x.term], c = byAgent.get(x.id);
    if (t && !t.card && c) terms[x.term] = { ...t, card: c };
  }
  // `/fork` background sessions, under the agent they came from; stopped ones and those attached in a shell left out
  const [forks, setForks] = useState<Fork[]>([]);
  useEffect(() => {
    const load = () => !document.hidden && termForks().then(setForks).catch(() => {});
    load();
    const t = setInterval(load, FORKS_POLL_MS);
    return () => clearInterval(t);
  }, []);
  // `/advices` runs, under the agent that asked them
  const [advices, setAdvices] = useState<Advice[]>([]);
  useEffect(() => {
    const load = () => !document.hidden && termAdvices().then(setAdvices).catch(() => {});
    load();
    const t = setInterval(load, FORKS_POLL_MS);
    return () => clearInterval(t);
  }, []);
  const advicesOf = new Map<string, Advice[]>();
  for (const a of [...advices].sort((a, b) => (b.asked_at ?? 0) - (a.asked_at ?? 0))) {
    advicesOf.set(a.session, [...(advicesOf.get(a.session) ?? []), a]);
  }
  // the subagents of the Claude sessions in shells, running ones first
  const claudeIds = termSessions.filter((x) => x.agent === "claude").map((x) => x.id).sort().join(",");
  const [subs, setSubs] = useState<Subagent[]>([]);
  useEffect(() => {
    if (!claudeIds) return setSubs([]);
    const load = () => !document.hidden && termSubagents(claudeIds.split(",")).then(setSubs).catch(() => {});
    load();
    const t = setInterval(load, SUBAGENTS_POLL_MS);
    return () => clearInterval(t);
  }, [claudeIds]);
  const subsOf = new Map<string, Subagent[]>();
  for (const a of [...subs].sort((a, b) => Number(a.done) - Number(b.done) || (b.updated_at ?? 0) - (a.updated_at ?? 0))) {
    subsOf.set(a.session, [...(subsOf.get(a.session) ?? []), a]);
  }
  const inShell = new Set(termSessions.map((x) => x.id));
  const forksOf = new Map<string, Fork[]>();
  for (const f of forks) {
    if (f.state === "stopped" || inShell.has(f.id) || (f.state === "done" && sinceMs(f.updated_at) > FORK_DONE_MS)) continue;
    forksOf.set(f.parent, [...(forksOf.get(f.parent) ?? []), f]);
  }
  // the hooks report model, step and question per card: an agent gets its shell's card's
  const liveOf = (x: TermSession) => {
    const c = terms[x.term]?.card;
    return c ? agentOf.get(c) : undefined;
  };
  const isWaiting = (x: TermSession) => !!x.waiting || liveOf(x)?.state === "waiting";
  // each follow-up an agent was started on, by its shell: that agent's state is the item's progress
  const followUps = (x: TermSession): FollowUp[] =>
    (x.follow_ups ?? []).map((item) => {
      const term = started[`${x.id}\n${item}`];
      if (!term) return { item, state: "todo" };
      const shell = terms[term];
      const agent = termSessions.find((s) => s.term === term);
      if (!shell || shell.exited || agent?.done) return { item, state: "done" };
      const state = !agent ? "started" : isWaiting(agent) ? "waiting" : agent.busy ? "running" : "started";
      return { item, state, term };
    });
  // agents in their project's own window are listed there, not here
  const inWindow = (x: TermSession) => !!out[x.term]?.group;
  const asking = termSessions.filter((x) => !inWindow(x) && isWaiting(x));
  const running = termSessions.filter((x) => !inWindow(x) && !isWaiting(x)).sort((a, b) => seen(b) - seen(a));
  const pins = running.filter((x) => pinned.has(x.id));
  // idle agents whose follow-ups have waited over a day, above the groups
  const leftOver = running.filter((x) => !pinned.has(x.id) && !x.busy && liveOf(x)?.state !== "working" && isLeftOver(x, openCount(followUps(x))));
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
    if (pinned.has(x.id) || leftOver.includes(x)) continue;
    const project = byProject ? projectOf(x) : null;
    const repo = grouping === "paths" ? repoOf(x) : null;
    const key = byProject ? `${project ?? ""}/${repo ?? ""}` : "all";
    const g = groups.get(key) ?? { key, project, repo, xs: [] };
    g.xs.push(x);
    groups.set(key, g);
  }
  // a project whose agents are in their own window keeps its header, pointing there
  if (byProject && grouping !== "paths") {
    for (const project of popped) {
      const key = `${project}/`;
      if (!groups.has(key) && knownProjects.has(project)) groups.set(key, { key, project, repo: null, xs: [] });
    }
  }
  const windowed = (project: string) => termSessions.filter((x) => inWindow(x) && out[x.term]?.group === project).length;
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
  const agentRow = (x: TermSession, flat = false) => {
    const key = `term:${x.term}:${x.id}`;
    const l = liveOf(x);
    const fu = followUps(x);
    const waiting = isWaiting(x);
    const working = !waiting && (l?.state === "working" || x.busy);
    return (
      <div
        key={key}
        className={`group/row relative ${waiting ? "rounded-md bg-wait/[0.14]" : working ? TINT_BG[tint] : ""}`}
        title="right-click: pin, fork, stop, link to a card, close"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuAt({ x: e.clientX, y: e.clientY });
          setMenu(key);
        }}
      >
        {menu === key && (
          <Popover portal point={menuAt} onClose={() => setMenu(null)} className="w-44">
            <MenuRow
              onClick={() => {
                flip(pinned, setPinned, x.id);
                setMenu(null);
              }}
            >
              {pinned.has(x.id) ? "Unpin" : "Pin to top"}
            </MenuRow>
            {x.agent === "claude" && (
              <MenuRow
                title="a new agent in a new shell that starts from this conversation"
                onClick={() => {
                  setMenu(null);
                  const t = terms[x.term];
                  void openTerminal({
                    cwd: t?.cwd,
                    card: t?.card ?? null,
                    project: t?.project ?? null,
                    title: `${sessionLabel(x)} (fork)`,
                    command: `claude --resume ${x.id} --fork-session`,
                  });
                }}
              >
                Fork
              </MenuRow>
            )}
            {working && (
              <MenuRow
                title="stop its current turn, as Esc would; the shell stays"
                onClick={() => {
                  setMenu(null);
                  void interruptTerminal(x.term);
                }}
              >
                Stop
              </MenuRow>
            )}
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
              {/* room for the pin button */}
              <span className="w-4 shrink-0" />
            </span>
            <AgentLine l={l} x={x} fu={fu} repo={flat || grouping === "project" || grouping === "none" ? repoOf(x) : null} />
          </>
        ))}
        {selectedTerm === x.term && !x.busy && fu.length > 0 && (
          <ul aria-label="Follow-ups" className="ml-[19px] flex flex-col pb-0.5">
            {fu.map(({ item, state, term }) => (
              <li key={item}>
                <button
                  type="button"
                  title={term ? `show the agent on it: ${item}` : state === "done" ? `done: ${item}` : `start an agent on it: ${item}`}
                  disabled={state === "done"}
                  onClick={async () => {
                    if (term) return void revealTerminal(term);
                    const info = await openTerminal({
                      cwd: terms[x.term]?.cwd,
                      card: terms[x.term]?.card ?? null,
                      project: terms[x.term]?.project ?? null,
                      title: item,
                      command: `${x.agent} ${shellQuote(item)}`,
                    });
                    setStarted((m) => ({ ...m, [`${x.id}\n${item}`]: info.id }));
                  }}
                  className={`group/fu flex w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-left text-[11.5px] ${
                    state === "done" ? "text-ink-faint line-through" : "text-ink-muted hover:bg-active-row hover:text-ink-soft"
                  }`}
                >
                  {state === "todo"
                    ? <span aria-hidden="true" className="mx-[1.5px] h-[9px] w-[9px] shrink-0 rounded-[2px] border border-current opacity-70" />
                    : <ForkState state={state === "started" ? "idle" : state} />}
                  <span className="min-w-0 flex-1 truncate">{item}</span>
                  {state !== "done" && (
                    <span className="shrink-0 text-[10.5px] text-copper no-underline opacity-0 group-hover/fu:opacity-100">
                      {term ? "show ▸" : "start ▸"}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        {(forksOf.get(x.id) ?? []).sort((a, b) => forkRank(a) - forkRank(b)).map((f) => forkRow(f, x))}
        {(subsOf.get(x.id) ?? []).map((a) => subRow(a, x))}
        {(advicesOf.get(x.id) ?? []).map((a) => adviceRow(a, x))}
        <button
          type="button"
          onClick={() => flip(pinned, setPinned, x.id)}
          title={pinned.has(x.id) ? "unpin" : "pin to the top"}
          aria-label={pinned.has(x.id) ? `Unpin ${sessionLabel(x)}` : `Pin ${sessionLabel(x)}`}
          aria-pressed={pinned.has(x.id)}
          className={`absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded hover:bg-active-row ${
            pinned.has(x.id) ? "text-copper" : "text-ink-faint opacity-0 hover:text-ink focus-visible:opacity-100 group-hover/row:opacity-100"
          }`}
        >
          <PinIcon size={12} />
        </button>
      </div>
    );
  };
  // a `/fork` of `x` running in the background: a click attaches to it in a new shell
  const forkRow = (f: Fork, x: TermSession) => {
    const t = terms[x.term];
    const label = f.intent || f.name || f.job;
    const state = f.state === "blocked" ? "waiting" : f.state ?? "running";
    return (
      <button
        key={`fork:${f.job}`}
        type="button"
        title={`${f.name ?? label} · background fork, ${state} · click to attach (claude attach ${f.job})`}
        onClick={() =>
          void openTerminal({
            cwd: f.cwd ?? t?.cwd,
            card: t?.card ?? null,
            project: t?.project ?? null,
            title: label,
            command: `claude attach ${f.job}`,
          })}
        className="ml-[19px] flex w-[calc(100%-19px)] items-center gap-1.5 rounded-md px-2 py-0.5 text-left text-[11.5px] text-ink-muted hover:bg-active-row hover:text-ink-soft"
      >
        <ForkState state={state} />
        <AgentIcon a={{ harness: x.agent, icon: null }} />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="shrink-0 font-mono text-[10.5px] text-ink-faint">{f.updated_at ? age(Date.parse(f.updated_at)) : ""}</span>
      </button>
    );
  };
  // a subagent of `x`: what it was asked, its type and model on hover; how long it has run, or since it finished
  const subRow = (a: Subagent, x: TermSession) => (
    <div
      key={`sub:${a.id}`}
      title={[a.kind, a.model, a.done ? "finished" : "running"].filter(Boolean).join(" · ")}
      className="ml-[19px] flex w-[calc(100%-19px)] items-center gap-1.5 px-2 py-0.5 text-[11.5px] text-ink-muted"
    >
      <ForkState state={a.done ? "done" : "running"} />
      <AgentIcon a={{ harness: x.agent, icon: null }} />
      <span className="min-w-0 flex-1 truncate">{a.description ?? a.kind ?? "subagent"}</span>
      {a.model && <span className="shrink-0 font-mono text-[10px] text-ink-faint/70">{a.model}</span>}
      <span className="shrink-0 font-mono text-[10.5px] text-ink-faint">{subAge(a)}</span>
    </div>
  );
  // an `/advices` run `x` asked: a click shows the answers (or follows the advisors while they run) in a new shell
  const adviceRow = (a: Advice, x: TermSession) => {
    const t = terms[x.term];
    const failed = a.advisors.filter((v) => v.status === "failed").map((v) => v.name);
    return (
      <button
        key={`adv:${a.run}`}
        type="button"
        title={`/advices · ${a.advisors.map((v) => `${v.name} ${v.status}`).join(", ")} · click to read the answers`}
        onClick={() =>
          void openTerminal({
            cwd: a.dir,
            card: t?.card ?? null,
            project: t?.project ?? null,
            title: `advices: ${a.question}`,
            command: a.done ? "less answers/*.md" : "tail -f raw/*.log",
          })}
        className="ml-[19px] flex w-[calc(100%-19px)] items-center gap-1.5 rounded-md px-2 py-0.5 text-left text-[11.5px] text-ink-muted hover:bg-active-row hover:text-ink-soft"
      >
        <ForkState state={a.done ? (failed.length ? "failed" : "done") : "running"} />
        <span className="flex shrink-0 items-center -space-x-[3px]">
          {a.advisors.map((v) => (
            <span key={v.name} title={`${v.name} ${v.status}`} className={`inline-flex ${v.status === "failed" ? "opacity-35 grayscale" : ""}`}>
              <AgentIcon a={{ harness: ADVISOR_HARNESS[v.name] ?? v.name, icon: null }} />
            </span>
          ))}
        </span>
        <span className="min-w-0 flex-1 truncate">{a.question}</span>
        <span className="shrink-0 font-mono text-[10.5px] text-ink-faint">{a.asked_at ? age(a.asked_at) : ""}</span>
      </button>
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
        setMenuAt({ x: e.clientX, y: e.clientY });
        setMenu(`shell:${t.id}`);
      }}
    >
      {menu === `shell:${t.id}` && (
        <Popover portal point={menuAt} onClose={() => setMenu(null)} className="w-44">
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
      <div key={x.name} className={`flex flex-col ${roomy ? "py-1" : "py-px"} ${x.working ? `px-1 ${TINT_BG[(more.tint as Tint) ?? "live"]}` : ""}`}>
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
          {asking.map((x) => agentRow(x))}
        </section>
      )}
      {leftOver.length > 0 && (
        <section className={`flex flex-col ${gap}`} aria-label="Left over">
          <div className={`px-2 pb-1 ${SECTION_LABEL}`} title="idle agents whose follow-ups have waited over a day">
            LEFT OVER · {leftOver.length}
          </div>
          {leftOver.map((x) => agentRow(x, true))}
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
            key: "tint",
            label: "RUNNING AGENTS",
            value: tint,
            options: TINT_LABEL,
            onChange: (v) => setTint(v as Tint),
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
            onAgent={onSelectAgent}
          />
        )}
      </div>
      {agents === 0 && (
        <p className="px-2 text-[11.5px] leading-snug text-ink-muted">
          No agent running. Start one with + above (Ctrl+T), or resume one below.
        </p>
      )}
      {pins.length > 0 && (
        <section className={`flex flex-col ${gap}`} aria-label="Pinned">
          <div className={`flex items-center gap-1.5 px-2 pb-1 ${SECTION_LABEL}`}>
            <PinIcon size={12} />
            PINNED
            <span className="ml-auto pr-1 tracking-normal tabular-nums text-ink-faint">{pins.length}</span>
          </div>
          {pins.map((x) => agentRow(x, true))}
        </section>
      )}
      {sections.map(({ key, project, repo, xs }) => (
        <section key={key} className={`flex flex-col ${gap}`}>
          {grouping !== "none" && (
            <div className={`group/head relative mb-0.5 flex items-center gap-1.5 rounded-md bg-well px-2 py-1 ${SECTION_LABEL}`}>
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
                <span className="ml-auto pr-1 tracking-normal tabular-nums text-ink-faint">{xs.length + (project ? windowed(project) : 0)}</span>
              </button>
              {project && !popped.has(project) && grouping !== "paths" && (
                <button
                  type="button"
                  onClick={() => popOutGroup(project, termSessions.filter((x) => projectOf(x) === project).map((x) => x.term))}
                  title="move this project's agents to a window of their own"
                  aria-label={`Open ${label(project)} in its own window`}
                  className="-my-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-muted opacity-0 hover:bg-active-row hover:text-ink focus-visible:opacity-100 group-hover/head:opacity-100"
                >
                  <PopOutIcon size={12} />
                </button>
              )}
              {project && (
                <button
                  type="button"
                  onClick={() => setMenuFor(key)}
                  title="new terminal or agent in this project"
                  aria-label={`New terminal in ${label(project)}`}
                  className={`-my-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-muted hover:bg-active-row hover:text-ink ${
                    menuFor === key ? "" : "opacity-0 focus-visible:opacity-100 group-hover/head:opacity-100"
                  }`}
                >
                  <PlusIcon size={12} />
                </button>
              )}
              {project && menuFor === key && (
                <NewTerminalDialog
                  board={board}
                  project={project}
                  onClose={() => setMenuFor(null)}
                  onOpened={(card, project) => (card ? onSelect(card) : project ? onSelectProject(project) : onSelect(null))}
            onAgent={onSelectAgent}
                />
              )}
            </div>
          )}
          {project && popped.has(project) && (
            <button
              type="button"
              onClick={() => showGroupPopout(project)}
              title="show the window holding this project's agents"
              className="mx-2 flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11.5px] text-ink-muted hover:bg-active-row hover:text-ink-soft"
            >
              <PopOutIcon size={12} />
              {windowed(project)} in their own window · show
            </button>
          )}
          {!folded.has(gkey(key)) && !(project && popped.has(project)) && (grouping === "tree"
            ? byRepo(xs).map(([r, rs]) =>
              r === null ? rs.map((x) => agentRow(x)) : (
                <div key={r} className={`flex flex-col ${gap}`}>
                  <div className="flex items-center gap-1.5 px-2 pt-0.5 text-[11.5px] text-ink-faint" title={`agents in ${r}`}>
                    <FolderIcon size={12} />
                    <span className="min-w-0 flex-1 truncate">{r}</span>
                  </div>
                  <div className={`ml-[13px] flex flex-col ${gap} border-l border-line pl-1`}>{rs.map((x) => agentRow(x))}</div>
                </div>
              )
            )
            : xs.map((x) => agentRow(x)))}
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
      <AgentRuns selected={agentRun} onSelect={onSelectAgent} />
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

const FORKS_POLL_MS = 10_000;
const SUBAGENTS_POLL_MS = 5_000;
const subAge = (a: Subagent) => {
  const at = a.done ? a.updated_at : a.started_at;
  return at ? age(at) : "";
};
const FORK_DONE_MS = 12 * 3600_000; // a finished fork stays listed this long
// waiting on you first, then working, then finished
const forkRank = (f: Fork) => (f.state === "blocked" ? 0 : f.state === "done" ? 2 : 1);
const sinceMs = (iso: string | null) => (iso ? Date.now() - Date.parse(iso) : Infinity);
// the harness logo for an `/advices` advisor
const ADVISOR_HARNESS: Record<string, string> = { fable: "claude", "vibe-large": "vibe", gemini: "agy" };


// a fork's or advice run's state: a spinner while it runs, a check once done, a cross if it failed, a question mark when it waits on you
function ForkState({ state }: { state: string }) {
  const cls = "h-3 w-3 shrink-0";
  if (state === "done") {
    return (
      <svg viewBox="0 0 12 12" className={`${cls} text-live`} fill="none" stroke="currentColor" strokeWidth="1.3" aria-label="done">
        <circle cx="6" cy="6" r="5" />
        <path d="M3.8 6.1l1.5 1.5 2.9-3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (state === "failed") {
    return (
      <svg viewBox="0 0 12 12" className={`${cls} text-blocked`} fill="none" stroke="currentColor" strokeWidth="1.3" aria-label="an advisor failed">
        <circle cx="6" cy="6" r="5" />
        <path d="M4.3 4.3l3.4 3.4M7.7 4.3l-3.4 3.4" strokeLinecap="round" />
      </svg>
    );
  }
  if (state === "idle") {
    return (
      <svg viewBox="0 0 12 12" className={`${cls} text-ink-soft`} fill="none" stroke="currentColor" strokeWidth="1.3" aria-label="started, idle">
        <circle cx="6" cy="6" r="5" />
        <path d="M6 1a5 5 0 0 1 0 10z" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (state === "waiting") {
    return (
      <svg viewBox="0 0 12 12" className={`${cls} text-wait`} fill="none" stroke="currentColor" strokeWidth="1.3" aria-label="waiting">
        <circle cx="6" cy="6" r="5" />
        <path d="M4.6 4.7a1.4 1.4 0 1 1 1.9 1.3c-.4.2-.5.4-.5.8" strokeLinecap="round" />
        <circle cx="6" cy="8.6" r=".4" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 12 12" className={`${cls} animate-spin text-wait`} fill="none" stroke="currentColor" strokeWidth="1.5" aria-label={state}>
      <path d="M6 1a5 5 0 1 1-5 5" strokeLinecap="round" />
    </svg>
  );
}

const projectName = (board: BoardData | null, id: string) => board?.projects.find((p) => p.id === id)?.name ?? "";
const seen = (x: TermSession) => x.updated_at ?? x.started_at ?? 0;
const LEFT_OVER_MS = 24 * 3600_000;
// open follow-ups, untouched for over a day
const isLeftOver = (x: TermSession, open: number) => open > 0 && seen(x) > 0 && Date.now() - seen(x) > LEFT_OVER_MS;
// a follow-up and the agent started on it, if any: "started" is idle without having finished
type FollowUp = { item: string; state: "todo" | "running" | "waiting" | "started" | "done"; term?: string };
const openCount = (fu: FollowUp[]) => fu.filter((f) => f.state !== "done").length;
const FOLLOW_CODEC = {
  parse: (r: string) => Object.fromEntries(Object.entries(JSON.parse(r) as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>,
  stringify: (v: Record<string, string>) => JSON.stringify(v),
};
const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

// one notch per follow-up: done, under way, not started
function FollowBar({ fu }: { fu: FollowUp[] }) {
  const tone = (f: FollowUp) =>
    f.state === "done" ? "bg-live" : f.state === "todo" ? "bg-ink-faint/35" : "bg-wait";
  return (
    <span aria-label={`${fu.length - openCount(fu)} of ${fu.length} done`} className="inline-flex items-center gap-[2px]">
      {fu.map((f) => <span key={f.item} className={`h-[5px] w-[7px] rounded-[1px] ${tone(f)}`} />)}
    </span>
  );
}

// under an agent's name: its model and state, how long, then what it does (or asks) on a second line;
// `l` is its card's presence from the hooks, `x` what Trame reads from the process itself
function AgentLine({ l, x, fu = [], repo }: { l?: Live; x?: TermSession; fu?: FollowUp[]; repo?: string | null }) {
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
          {waiting
            ? <span className="text-wait">needs you</span>
            : x?.asleep
            ? <span title="restored at launch: opening its tab resumes it">not resumed</span>
            : working
            ? "working"
            : done
            ? "done"
            : x && fu.length
            ? (
              <span
                title={fu.map((f) => `${f.state === "done" ? "✓" : f.state === "todo" ? "☐" : "…"} ${f.item}`).join("\n")}
                className={`inline-flex items-center gap-1.5 ${
                  isLeftOver(x, openCount(fu)) ? "rounded-full border border-wait/45 px-1.5 text-wait" : "text-ink-soft"
                }`}
              >
                {openCount(fu) ? `${openCount(fu)} left` : "all done"}
                {fu.some((f) => f.state !== "todo") && <FollowBar fu={fu} />}
              </span>
            )
            : "idle"}
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
