import { useEffect, useRef, useState } from "react";
import { AgentIcon, useAgents } from "../agents/agents";
import type { BoardData, Project } from "../api";
import { projectFor } from "./project-for";
import { appConfirm, EntityIcon, IconButton, MenuRow, Popover, PresenceDot, useLocalStorage } from "../ui/ui";
import { needsYou } from "./attention";
import { ChevronIcon, MaximizeIcon, PlusIcon, PopOutIcon, SidebarIcon, SplitDownIcon, SplitRightIcon } from "../ui/icons";
import { moveIn } from "./move-in";
import { NewTerminalDialog } from "./NewTerminalDialog";
import { TerminalView } from "./TerminalView";
import {
  closeTab,
  closeTerminal,
  type DropSide,
  droppedOutside,
  focusPane,
  leaves,
  liveCwd,
  seeTerm,
  termNow,
  useTermSessions,
  useUnseenTerms,
  mergeTab,
  MAX_PANES,
  moveTerm,
  popOut,
  groups,
  isGroup,
  joinPane,
  type PaneGroup,
  type PaneNode,
  resizeSplit,
  type SplitDir,
  type TermTab,
  FIND_TERMINAL,
  openTerminal,
  openTerminalAt,
  selectTab,
  setDockMax,
  setDockOpen,
  setTermDrag,
  splitTerminal,
  tabCards,
  type TermAgent,
  type TermDrag,
  type TermNow,
  termAgents,
  useTermDock,
} from "./term-api";

function ProjectMark({ project }: { project: Project | null }) {
  if (project?.icon) return <EntityIcon icon={project.icon} size={14} />;
  if (project?.color) return <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: project.color }} />;
  return null;
}

const HEIGHT_CODEC = { parse: (r: string) => Math.max(120, Number(r) || 300), stringify: String };

// the card's project, else the shell's own, else the project of whichever card works in that folder
const projectOf = (
  board: BoardData | null | undefined,
  card: string | null | undefined,
  cwd: string | undefined,
  project?: string | null,
) => {
  const client = (card ? board?.sessions.find((s) => s.id === card)?.client_id : null) ?? project;
  return (client && board?.projects.find((p) => p.id === client)) || projectFor(board, cwd);
};

// The Terminals view narrows the dock to one card's tabs, a project's shells, plain ones, or keeps all of them.
export type DockScope = { all?: boolean; term?: string | null; card: string | null; project: string | null; cwd: string | null };

// Bottom panel of embedded terminals: a tab strip that stays when collapsed, shells kept mounted.
// With a `scope` it is the Terminals view's center instead: always open, full size, one card's tabs.
// Both are the same mounted component, so moving between them never remounts (and replays) a shell.
export default function TerminalDock(
  { board, scope, onScope, details = null, onToggleDetails, cover, onUncover }: {
    board?: BoardData | null;
    scope?: DockScope | null;
    onScope?: (card: string | null, project: string | null) => void; // show another card's or project's shells
    details?: boolean | null; // the docked card details are shown; null = no card in scope
    onToggleDetails?: () => void;
    cover?: React.ReactNode; // shown over the panes (a past session, All sessions); the tabs stay above it
    onUncover?: (term: string) => void; // a tab clicked while covered: show that shell's group
  },
) {
  const dock = useTermDock();
  const { terms, tabs: allTabs } = dock;
  // a shell running a /rename-d agent session is called by that name, and shows the agent's icon
  const sessions = useTermSessions();
  const named = new Map(sessions.filter((x) => x.named).map((x) => [x.term, x.name]));
  const agentIn = new Map(sessions.map((x) => [x.term, x.agent]));
  const sessionIn = new Map(sessions.map((x) => [x.term, x]));
  const unseen = useUnseenTerms();
  const inScope = (t: TermTab) => {
    if (scope!.all) return true;
    if (scope!.term && leaves(t.root).includes(scope!.term)) return true;
    const onBoard = (c: string) => !!board?.sessions.some((s) => s.id === c);
    const known = (p: string | null | undefined) => (p && board?.projects.some((x) => x.id === p) ? p : null);
    const cardProject = (c: string | null | undefined) => known(board?.sessions.find((s) => s.id === c)?.client_id);
    // a shell's project: its card's, else the one it was opened for (as TermCards groups them)
    const projectOf = (id: string) => cardProject(terms[id]?.card) ?? known(terms[id]?.project);
    const lead = scope!.term ? terms[scope!.term] : undefined;
    const card = lead ? (lead.card && onBoard(lead.card) ? lead.card : null) : scope!.card;
    // a project's agent or card: every tab of that project, so projects don't share one strip
    const project = lead ? projectOf(scope!.term!) : card ? cardProject(card) : known(scope!.project);
    // a card with no shell yet keeps its own empty strip, with its start buttons
    const bare = !lead && card !== null && !allTabs.some((x) => tabCards(x, terms).includes(card));
    if (project && !bare) return leaves(t.root).some((id) => projectOf(id) === project);
    // no project: the card's tabs, else the shells with no card on this board and no project
    const cards = tabCards(t, terms);
    if (card !== null) return cards.includes(card);
    if (cards.some(onBoard)) return false;
    return leaves(t.root).every((id) => !projectOf(id));
  };
  const tabs = scope ? allTabs.filter(inScope) : allTabs;
  // the scoped card's Claude runs in a terminal outside Trame: offer to move it here
  const { live } = useAgents();
  const scopeCard = scope?.card ? board?.sessions.find((s) => s.id === scope.card) : undefined;
  const outside = scopeCard?.claude_id && live.some((l) => l.a.session_id === scopeCard.id) ? scopeCard : null;
  const [moveError, setMoveError] = useState<string | null>(null);
  const moveHere = async () => {
    setMoveError(null);
    try {
      await moveIn({ session: outside!.claude_id!, card: outside!.id, title: `Claude · ${outside!.title}` });
    } catch (e) {
      setMoveError(e instanceof Error ? e.message : String(e));
    }
  };
  const active = tabs.some((t) => t.id === dock.active) ? dock.active : tabs[0]?.id ?? null;
  const open = !!scope || dock.open;
  const full = !!scope || (open && dock.max);
  const [height, setHeight] = useLocalStorage<number>("trame:termHeight", 300, HEIGHT_CODEC);
  const resize = useRef<{ y: number; h: number } | null>(null);
  const current = tabs.find((t) => t.id === active);
  const canSplit = !!current && groups(current.root).length < MAX_PANES;
  // the New terminal dialog (+, ⌘T, the empty view), optionally with an agent preselected
  // `into`: ⌘T opens it as a tab of the focused pane, + as a new dock tab
  const [newTerm, setNewTerm] = useState<{ agent?: string; cwd?: string | null; into?: boolean } | null>(null);
  // its "Here" is the folder the focused shell is in now
  const openNew = async (agent?: string, into = false) =>
    setNewTerm({ agent, cwd: current ? await liveCwd(current.focus) : null, into });
  // the pane filling its tab (Konsole's Ctrl+Shift+E), the others kept mounted behind it
  const [zoomed, setZoomed] = useState<string | null>(null);
  const split = (dir: "row" | "col") => {
    setZoomed(null);
    void splitTerminal(dir);
  };
  // a tab or a shell being dragged onto the panes (Konsole-style layout)
  const drag = dock.drag;
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // the tab right-clicked: close the others, or those to its left or right
  const [tabMenu, setTabMenu] = useState<string | null>(null);
  const closeTabs = async (ids: string[]) => {
    const n = ids.length;
    if (!(await appConfirm(`Close ${n} tab${n === 1 ? "" : "s"}? Agents running in them stop.`, "Close"))) return;
    for (const id of ids) await closeTab(id);
  };
  // the tab shown before the current one: dragging the current tab drops it beside that one
  const [last, setLast] = useState<string | null>(null);
  const shownTab = useRef(active);
  useEffect(() => {
    if (active && active !== shownTab.current) setLast(shownTab.current);
    shownTab.current = active;
  }, [active]);
  const [agents, setAgents] = useState<TermAgent[] | null>(null);
  // fetched with the dock: finding them runs the user's shell profile (~2s)
  useEffect(() => {
    void termAgents().then(setAgents);
  }, []);
  // the focused pane of the shown tab, in a focused window, has been seen
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const on = () => setWindowFocused(document.hasFocus());
    addEventListener("focus", on);
    addEventListener("blur", on);
    return () => {
      removeEventListener("focus", on);
      removeEventListener("blur", on);
    };
  }, []);
  const seen = open && windowFocused ? current?.focus : undefined;
  useEffect(() => {
    if (seen) seeTerm(seen);
  }, [seen, unseen]);
  const lead = current ? terms[current.focus] : null;
  const cwd = lead?.cwd ?? scope?.cwd ?? null;
  const card = scope && !scope.all ? scope.card : lead?.card ?? null;
  const onDrag = (e: React.PointerEvent) => {
    if (!resize.current) return;
    const max = innerHeight - 120;
    setHeight(Math.min(max, Math.max(120, resize.current.h + resize.current.y - e.clientY)));
  };

  return (
    <>
    <section
      className={`relative flex flex-col bg-panel ${full ? "min-h-0 flex-1" : "shrink-0 border-t border-line"}`}
      style={open && !full ? { height, maxHeight: "calc(100vh - 120px)" } : undefined}
      // ⌘⇧P / Ctrl+Shift+P jump to a terminal, ⌘T / Ctrl+T new tab (Ctrl+T no longer reaches the shell), ⌘D / ⌘⇧D split like iTerm and Ghostty, Ctrl+( / Ctrl+), Ctrl+Shift+E and Ctrl+Shift+←/→ (tabs) like Konsole, before the shell sees the key
      onKeyDownCapture={(e) => {
        const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
        const run = (f: () => void) => {
          e.preventDefault();
          e.stopPropagation();
          f();
        };
        if ((e.metaKey || e.ctrlKey) && !(e.metaKey && e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "t") run(() => void openNew(undefined, true));
        else if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.code === "KeyP") run(() => dispatchEvent(new Event(FIND_TERMINAL)));
        else if (e.metaKey && !e.altKey && !e.ctrlKey && e.key.toLowerCase() === "d") run(() => split(e.shiftKey ? "col" : "row"));
        else if (ctrl && e.key === "(") run(() => split("row"));
        else if (ctrl && e.key === ")") run(() => split("col"));
        else if (ctrl && e.shiftKey && e.code === "KeyE" && current) {
          run(() =>
            groups(current.root).length > 1
              ? setZoomed(zoomed === current.focus ? null : current.focus)
              : !scope && setDockMax(!full)
          );
        } else if (ctrl && e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight") && tabs.length > 1) {
          const at = tabs.findIndex((t) => t.id === active);
          const next = tabs[(at + (e.key === "ArrowLeft" ? -1 : 1) + tabs.length) % tabs.length];
          run(() => selectTab(next.id));
        }
      }}
      // the shell owns the keyboard: Escape, ⌘P, ⌘Enter must not reach the app's window handlers
      onKeyDown={(e) => {
        if (!(e.ctrlKey && (e.key === "`" || e.key === "~"))) e.stopPropagation();
      }}
    >
      {open && !full && (
        <div
          className="absolute -top-1 left-0 right-0 z-10 h-2 cursor-row-resize"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            resize.current = { y: e.clientY, h: height };
          }}
          onPointerMove={onDrag}
          onPointerUp={() => (resize.current = null)}
        />
      )}
      <div className="flex h-9 shrink-0 items-center gap-1 px-2 text-xs">
        <span className="pr-1 text-[11px] font-medium text-ink-muted">{scope ? "Agents" : "Terminal"}</span>
        {/* scrollbar hidden: it overlays the tab labels; the wheel scrolls the strip sideways */}
        <div
          className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          onWheel={(e) => {
            if (e.deltaX === 0) e.currentTarget.scrollLeft += e.deltaY;
          }}
        >
          {tabs.map((t, i) => {
            const panes = leaves(t.root);
            const lead = terms[t.focus];
            const name = named.get(t.focus) ?? panes.map((p) => named.get(p)).find(Boolean) ?? lead?.title;
            const agent = agentIn.get(t.focus) ?? panes.map((p) => agentIn.get(p)).find(Boolean);
            const project = projectOf(board, lead?.card, lead?.cwd, lead?.project);
            const exited = panes.every((p) => terms[p]?.exited);
            const why = needsYou(panes.map((p) => sessionIn.get(p)), unseen);
            return (
              <div
                key={t.id}
                draggable
                onContextMenu={(e) => {
                  e.preventDefault();
                  setTabMenu(t.id);
                }}
                title="drag onto a pane to split it with this tab"
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/x-trame-tab", t.id);
                  e.dataTransfer.effectAllowed = "move";
                  setTermDrag({ kind: "tab", id: t.id });
                  // a tab can't split with itself: show another one to drop onto, after the drag image is taken
                  if (t.id === active) {
                    const other = tabs.find((x) => x.id === last && x.id !== t.id) ?? tabs.find((x) => x.id !== t.id);
                    if (other) setTimeout(() => selectTab(other.id), 0);
                  }
                }}
                // dropped outside the window: its focused shell gets a window of its own
                onDragEnd={(e) => {
                  clearTimeout(hoverTimer.current);
                  setTermDrag(null);
                  if (droppedOutside(e.nativeEvent)) popOut(t.focus);
                }}
                // hovering another tab while dragging shows it, to drop into its panes
                onDragEnter={() => {
                  clearTimeout(hoverTimer.current);
                  if (drag && !(drag.kind === "tab" && drag.id === t.id)) {
                    hoverTimer.current = setTimeout(() => selectTab(t.id), 400);
                  }
                }}
                onDragLeave={() => clearTimeout(hoverTimer.current)}
                className={`group flex shrink-0 cursor-grab items-center gap-1 rounded-md px-2.5 py-1 text-[13px] ${
                  why
                    ? "bg-wait/15 text-wait"
                    : t.id === active && open && !cover
                    ? "bg-tab-active text-ink"
                    : "text-ink-muted hover:text-ink-soft"
                } ${drag?.kind === "tab" && drag.id === t.id ? "opacity-50" : ""}`}
              >
                <button
                  type="button"
                  title={[name, project ? `${project.name} · ${lead?.cwd}` : lead?.cwd].filter(Boolean).join("\n")}
                  className="flex min-w-0 items-center gap-1.5"
                  onClick={() => {
                    if (cover) onUncover?.(t.focus);
                    if (t.id === active && open && !scope) setDockOpen(false);
                    else selectTab(t.id);
                  }}
                >
                  {/* one mark: the project's, else the agent's */}
                  {project?.icon || project?.color || !agent
                    ? <ProjectMark project={project} />
                    : <AgentIcon a={{ harness: agent, icon: null }} />}
                  <span className={`max-w-56 truncate ${exited ? "opacity-50" : ""}`}>{name}</span>
                  {why && (
                    <span title={why} className="flex">
                      <PresenceDot state="waiting" />
                    </span>
                  )}
                  {panes.length > 1 && <span className="pl-1 text-[10px] text-ink-faint">{panes.length}</span>}
                </button>
                <IconButton
                  tone="close"
                  aria-label={`Close ${name}`}
                  title={panes.length > 1 ? "close the tab (ends its processes)" : "close (ends the process)"}
                  className="opacity-0 group-hover:opacity-100"
                  onClick={() => void closeTab(t.id)}
                >
                  ×
                </IconButton>
                {tabMenu === t.id && (
                  <Popover portal onClose={() => setTabMenu(null)} className="w-48">
                    {([
                      ["Close other tabs", tabs.filter((x) => x.id !== t.id)],
                      ["Close tabs to the left", tabs.slice(0, i)],
                      ["Close tabs to the right", tabs.slice(i + 1)],
                    ] as const).map(([label, group]) => (
                      <MenuRow
                        key={label}
                        disabled={group.length === 0}
                        className="hover:text-blocked disabled:opacity-40"
                        onClick={() => {
                          setTabMenu(null);
                          void closeTabs(group.map((x) => x.id));
                        }}
                      >
                        {label}
                      </MenuRow>
                    ))}
                  </Popover>
                )}
              </div>
            );
          })}
        </div>
        <div className="relative shrink-0">
          <IconButton
            tone="close"
            className="grid h-7 w-7 place-items-center rounded-md hover:bg-hover"
            title="new tab: terminal or agent"
            aria-label="New terminal or agent"
            onClick={() => void openNew()}
          >
            <PlusIcon />
          </IconButton>
        </div>
        <div className="flex-1" />
        {canSplit && (
          <>
            <IconButton tone="close" className="grid h-7 w-7 place-items-center rounded-md hover:bg-hover" title="split right (⌘D, Ctrl+()" aria-label="Split right" onClick={() => split("row")}>
              <SplitRightIcon />
            </IconButton>
            <IconButton tone="close" className="grid h-7 w-7 place-items-center rounded-md hover:bg-hover" title="split down (⌘⇧D, Ctrl+))" aria-label="Split down" onClick={() => split("col")}>
              <SplitDownIcon />
            </IconButton>
          </>
        )}
        {current && (
          <IconButton
            tone="close"
            className="grid h-7 w-7 place-items-center rounded-md hover:bg-hover"
            title="open the focused shell in its own window"
            aria-label="Pop out the focused shell"
            onClick={() => popOut(current.focus)}
          >
            <PopOutIcon />
          </IconButton>
        )}
        {scope && details !== null && (
          <IconButton
            tone="close"
            className="grid h-7 w-7 place-items-center rounded-md hover:bg-hover"
            title={`${details ? "hide" : "show"} the card's details (${navigator.platform.startsWith("Mac") ? "⌘⇧\\" : "Ctrl+Shift+\\"})`}
            aria-label={details ? "Hide card details" : "Show card details"}
            onClick={onToggleDetails}
          >
            <SidebarIcon right />
          </IconButton>
        )}
        {!scope && (
        <>
        <IconButton
          tone="close"
          className="grid h-7 w-7 place-items-center rounded-md hover:bg-hover"
          title={full ? "restore (Ctrl+Shift+`)" : "fill the view (Ctrl+Shift+`)"}
          aria-label={full ? "Restore terminal" : "Maximize terminal"}
          onClick={() => setDockMax(!full)}
        >
          <MaximizeIcon restore={full} />
        </IconButton>
        <IconButton
          tone="close"
          className="grid h-7 w-7 place-items-center rounded-md hover:bg-hover"
          title={open ? "hide (Ctrl+`)" : "show (Ctrl+`)"}
          aria-label={open ? "Hide terminal" : "Show terminal"}
          onClick={() => setDockOpen(!open)}
        >
          <ChevronIcon up={!open} />
        </IconButton>
        </>
        )}
      </div>
      <div className={`relative min-h-0 flex-1 bg-block ${open ? "" : "hidden"}`}>
        {cover && <div className="absolute inset-0 z-20 flex min-h-0 flex-col overflow-auto bg-panel">{cover}</div>}
        {scope && !cover && tabs.length === 0 && (
          <div
            className={`absolute inset-0 flex flex-col items-center justify-center gap-3 text-xs text-ink-muted ${
              drag?.kind === "card" ? "outline-2 -outline-offset-8 outline-dashed outline-copper/60" : ""
            }`}
            onDragOver={(e) => {
              if (drag?.kind !== "card") return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }}
            onDrop={(e) => {
              if (drag?.kind !== "card") return;
              e.preventDefault();
              setTermDrag(null);
              if (!drag.tab) void openTerminal({ cwd: drag.cwd, card: drag.id });
              onScope?.(drag.id, null);
            }}
          >
            {outside
              ? (
                <>
                  <span>Its Claude runs in a terminal outside Trame.</span>
                  <button
                    type="button"
                    className="rounded-md border border-copper/60 bg-copper/10 px-3 py-1.5 text-ink"
                    title="stop it in the other terminal and resume it in a tab here"
                    onClick={() => void moveHere()}
                  >
                    ↘ Move into Trame
                  </button>
                  {moveError && <span className="text-blocked">{moveError}</span>}
                  <span className="mt-2 text-ink-faint">or start something else</span>
                </>
              )
              : <span>{scope.card ? "No terminal for this card yet." : scope.all ? "No terminals yet." : "No other shells."}</span>}
            <div className="flex gap-2">
              <button type="button" className="rounded-md border border-line px-3 py-1.5 hover:text-ink" onClick={() => void openNew("shell")}>
                New terminal
              </button>
              {agents?.map((a) => (
                <button
                  key={a.command}
                  type="button"
                  className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 hover:text-ink"
                  onClick={() => void openNew(a.command)}
                >
                  <AgentIcon a={{ harness: a.command, icon: null }} />
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {drag?.kind === "tab" && (
          <div className="pointer-events-none absolute inset-x-0 top-4 z-30 mx-auto w-fit rounded-md border border-line bg-panel px-3 py-1.5 text-xs text-ink-muted shadow">
            {tabs.length > 1
              ? "Drop onto a pane to split it with this tab"
              : "Open a second tab to split it with this one"}
          </div>
        )}
        {/* every tab's shells in one list keyed by shell id: hiding or moving a shell to another tab never remounts it */}
        <Panes
          tabs={allTabs}
          shown={open ? active : null}
          zoomed={zoomed}
          onZoom={(tab, id) => {
            focusPane(tab, id);
            setZoomed(zoomed === id ? null : id);
          }}
          drag={drag}
        />
      </div>
    </section>
    {newTerm && (
      <NewTerminalDialog
        board={board ?? null}
        here={{ cwd: newTerm.cwd ?? cwd, card, project: scope?.project ?? lead?.project ?? null }}
        agent={newTerm.agent}
        into={newTerm.into && current ? { tab: current.id, term: current.focus } : null}
        onClose={() => setNewTerm(null)}
        onOpened={(c, p) => {
          // one agent session's view hides any other shell: switch to the new one's card or project
          if (scope && !scope.all && (scope.term || c !== scope.card || (!c && p !== scope.project))) onScope?.(c, p);
        }}
      />
    )}
    </>
  );
}

type Rect = { x: number; y: number; w: number; h: number }; // percent of the tab body
const FULL: Rect = { x: 0, y: 0, w: 100, h: 100 };
// a split's divider: where it sits, the split's own rect, and the path to that split from the tab root
type Divider = { dir: SplitDir; split: Rect; ratio: number; path: string };
// each split gives `ratio` of its space to `a`
function layout(n: PaneNode, r: Rect, panes: [PaneGroup, Rect][], lines: Divider[], path = "") {
  if (isGroup(n)) {
    panes.push([n, r]);
    return;
  }
  const ratio = n.ratio ?? 0.5;
  lines.push({ dir: n.dir, split: r, ratio, path });
  if (n.dir === "row") {
    const w = r.w * ratio;
    layout(n.a, { ...r, w }, panes, lines, path + "a");
    layout(n.b, { ...r, x: r.x + w, w: r.w - w }, panes, lines, path + "b");
  } else {
    const h = r.h * ratio;
    layout(n.a, { ...r, h }, panes, lines, path + "a");
    layout(n.b, { ...r, y: r.y + h, h: r.h - h }, panes, lines, path + "b");
  }
}
const STRIP_PX = 28;
// a rect in the tab body, optionally below its pane's tab strip
const at = (r: Rect, strip = false) => ({
  left: `${r.x}%`,
  top: strip ? `calc(${r.y}% + ${STRIP_PX}px)` : `${r.y}%`,
  width: `${r.w}%`,
  height: strip ? `calc(${r.h}% - ${STRIP_PX}px)` : `${r.h}%`,
});

// where a drop lands: an edge splits the pane, the middle adds tabs to it
type DropZone = DropSide | "center";
const ZONE: Record<DropZone, React.CSSProperties> = {
  left: { left: 0, top: 0, width: "50%", height: "100%" },
  right: { right: 0, top: 0, width: "50%", height: "100%" },
  top: { left: 0, top: 0, width: "100%", height: "50%" },
  bottom: { left: 0, bottom: 0, width: "100%", height: "50%" },
  center: { left: "25%", top: "25%", width: "50%", height: "50%" },
};
const zoneAt = (e: React.DragEvent): DropZone => {
  const r = e.currentTarget.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  if (Math.abs(x - 0.5) < 0.25 && Math.abs(y - 0.5) < 0.25) return "center";
  const near: [DropSide, number][] = [["left", x], ["right", 1 - x], ["top", y], ["bottom", 1 - y]];
  return near.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
};

// every tab's shells, absolutely placed so splitting or moving never remounts (and replays) one
function Panes(
  { tabs, shown, zoomed, onZoom, drag }: {
    tabs: TermTab[];
    shown: string | null; // the tab on screen, null when the dock is closed
    zoomed: string | null; // a shell whose pane fills its tab
    onZoom: (tab: string, term: string) => void;
    drag: TermDrag | null;
  },
) {
  const [hover, setHover] = useState<{ id: string; zone: DropZone } | null>(null);
  const shells: { id: string; r: Rect; strip: boolean; up: boolean; tab: TermTab }[] = [];
  const strips: { g: PaneGroup; r: Rect; tab: TermTab; zoomed: boolean }[] = [];
  let lines: Divider[] = [];
  for (const tab of tabs) {
    const mine: [PaneGroup, Rect][] = [];
    const tabLines: Divider[] = [];
    layout(tab.root, FULL, mine, tabLines);
    const zg = zoomed ? mine.find(([g]) => g.terms.includes(zoomed))?.[0] : undefined;
    // a lone shell stays bare; 2+ panes or tabs get strips
    const strip = mine.length > 1 || mine[0][0].terms.length > 1;
    for (const [g, r] of mine) {
      const rect = zg === g ? FULL : r;
      const hidden = !!zg && zg !== g;
      for (const id of g.terms) shells.push({ id, r: rect, strip, up: id === g.active && !hidden, tab });
      if (strip && tab.id === shown && !hidden) strips.push({ g, r: rect, tab, zoomed: zg === g });
    }
    if (tab.id === shown && !zg) lines = tabLines;
  }
  // stable order by id: React moves nothing when a tree changes shape or a shell changes tab or pane
  shells.sort((a, b) => a.id.localeCompare(b.id));
  const shellsOf = (tabId: string) => {
    const t = tabs.find((x) => x.id === tabId);
    return t ? leaves(t.root) : [];
  };
  const drop = (zone: DropZone, tab: TermTab, id: string) => {
    if (!drag) return;
    if (drag.kind === "card" && !drag.tab) {
      const at = { tab: tab.id, term: id };
      if (zone === "center") void openTerminal({ cwd: drag.cwd, card: drag.id }, at);
      else void openTerminalAt({ cwd: drag.cwd, card: drag.id }, { ...at, side: zone });
      return;
    }
    // a whole tab: the dragged one, or the card's
    const src = drag.kind === "card" ? drag.tab : drag.kind === "tab" ? drag.id : null;
    if (zone === "center") joinPane(src ? shellsOf(src) : [drag.id], tab.id, id);
    else if (src) mergeTab(src, tab.id, id, zone);
    else moveTerm(drag.id, tab.id, id, zone);
  };
  return (
    <>
      {shells.map(({ id, r, strip, up, tab }) => {
        const visible = tab.id === shown && up;
        // a tab dragged onto itself, or a card's own tab, takes no drop
        const dropping = drag && visible && !(drag.kind === "term" && drag.id === id) &&
          !(drag.kind === "tab" && drag.id === tab.id) && !(drag.kind === "card" && drag.tab === tab.id);
        return (
          <div key={id} className={`absolute flex flex-col ${visible ? "" : "invisible"}`} style={at(r, strip)}>
            <div className="min-h-0 flex-1">
              <TerminalView id={id} visible={visible} focused={tab.focus === id} onFocus={() => focusPane(tab.id, id)} />
            </div>
            {dropping && (
              <div
                className="absolute inset-0 z-20"
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  const zone = zoneAt(e);
                  if (hover?.id !== id || hover.zone !== zone) setHover({ id, zone });
                }}
                onDragLeave={() => setHover(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  drop(zoneAt(e), tab, id);
                  setHover(null);
                  setTermDrag(null);
                }}
              >
                {hover?.id === id && (
                  <div className="pointer-events-none absolute border-2 border-copper bg-copper/15" style={ZONE[hover.zone]} />
                )}
              </div>
            )}
          </div>
        );
      })}
      {strips.map(({ g, r, tab, zoomed }) => (
        <PaneStrip key={g.group} g={g} tab={tab} zoomed={zoomed} onZoom={() => onZoom(tab.id, g.active)} style={at(r)} />
      ))}
      {shown && lines.map((d) => <SplitDivider key={`${shown}:${d.path}`} tab={shown} d={d} />)}
    </>
  );
}

const MIN_PANE_PX = 80;
// a split's line; dragging it resizes the panes live (shells hear the new size once the drag settles)
function SplitDivider({ tab, d }: { tab: string; d: Divider }) {
  const [dragging, setDragging] = useState(false);
  const box = useRef<DOMRect | null>(null);
  const frame = useRef(0);
  const row = d.dir === "row";
  const ratioAt = (e: React.PointerEvent) => {
    const b = box.current!;
    const px = row ? (b.width * d.split.w) / 100 : (b.height * d.split.h) / 100;
    const start = row ? b.left + (b.width * d.split.x) / 100 : b.top + (b.height * d.split.y) / 100;
    const min = Math.min(0.5, MIN_PANE_PX / px);
    return Math.min(1 - min, Math.max(min, ((row ? e.clientX : e.clientY) - start) / px));
  };
  // one layout update per frame, however fast the pointer moves
  const moveTo = (ratio: number) => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => resizeSplit(tab, d.path, ratio));
  };
  const pos = row ? d.split.x + d.split.w * d.ratio : d.split.y + d.split.h * d.ratio;
  const line: React.CSSProperties = row
    ? { left: `${pos}%`, top: `${d.split.y}%`, height: `${d.split.h}%` }
    : { top: `${pos}%`, left: `${d.split.x}%`, width: `${d.split.w}%` };
  return (
    <>
      <div
        role="separator"
        aria-orientation={row ? "vertical" : "horizontal"}
        title="drag to resize · double-click to even out"
        className={`peer absolute z-20 ${row ? "-ml-[3px] w-[7px] cursor-col-resize" : "-mt-[3px] h-[7px] cursor-row-resize"}`}
        style={line}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          box.current = (e.currentTarget.offsetParent as HTMLElement).getBoundingClientRect();
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
        }}
        onPointerMove={(e) => dragging && moveTo(ratioAt(e))}
        onPointerUp={(e) => {
          if (!dragging) return;
          moveTo(ratioAt(e));
          setDragging(false);
        }}
        onPointerCancel={() => setDragging(false)}
        onDoubleClick={() => resizeSplit(tab, d.path, 0.5)}
      />
      {/* the separator, like Orca's: a visible line, copper while hovered or dragged */}
      <div
        className={`pointer-events-none absolute z-10 ${row ? "-ml-px w-[2px]" : "-mt-px h-[2px]"} ${
          dragging ? "bg-copper" : "bg-chipline peer-hover:bg-copper/60"
        }`}
        style={line}
      />
    </>
  );
}

// a pane's tab strip, like Orca's: its shells, then new tab, splits and maximize
function PaneStrip(
  { g, tab, zoomed, onZoom, style }: { g: PaneGroup; tab: TermTab; zoomed: boolean; onZoom: () => void; style: React.CSSProperties },
) {
  const { terms } = useTermDock();
  const focused = g.terms.includes(tab.focus);
  const split = (dir: SplitDir) => {
    focusPane(tab.id, g.active);
    void splitTerminal(dir);
  };
  const icon = "grid h-6 w-6 place-items-center rounded-md hover:bg-hover";
  return (
    <div className="absolute z-10 flex items-center border-b border-line bg-panel pr-1" style={{ ...style, height: STRIP_PX }}>
      <div className="flex h-full min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none]">
        {g.terms.map((id) => (
          <ShellTab key={id} id={id} tab={tab.id} shown={id === g.active} focused={focused && id === g.active} />
        ))}
      </div>
      <IconButton
        tone="close"
        className={icon}
        title="new terminal in this pane"
        aria-label="New terminal in this pane"
        onClick={() =>
          void liveCwd(g.active).then((cwd) =>
            openTerminal({ cwd, card: terms[g.active]?.card ?? null }, { tab: tab.id, term: g.active })
          )}
      >
        <PlusIcon />
      </IconButton>
      <IconButton tone="close" className={icon} title="split right" aria-label="Split right" onClick={() => split("row")}>
        <SplitRightIcon />
      </IconButton>
      <IconButton tone="close" className={icon} title="split down" aria-label="Split down" onClick={() => split("col")}>
        <SplitDownIcon />
      </IconButton>
      <IconButton tone="close" className={icon} title="open in its own window" aria-label="Pop out" onClick={() => popOut(g.active)}>
        <PopOutIcon size={12} />
      </IconButton>
      <IconButton
        tone="close"
        className={icon}
        title={zoomed ? "restore the split (Ctrl+Shift+E)" : "maximize this pane (Ctrl+Shift+E)"}
        aria-label={zoomed ? "Restore split" : "Maximize pane"}
        onClick={onZoom}
      >
        <MaximizeIcon size={12} restore={zoomed} />
      </IconButton>
    </div>
  );
}

// one shell in a pane's strip: "folder : process" (live while shown), its agent and whether it waits on you;
// drag it onto a pane to move it there
function ShellTab({ id, tab, shown, focused }: { id: string; tab: string; shown: boolean; focused: boolean }) {
  const { terms } = useTermDock();
  const [now, setNow] = useState<TermNow | null>(null);
  useEffect(() => {
    if (!shown) return;
    let done = false;
    const load = () => void termNow(id).then((n) => !done && setNow(n));
    load();
    const t = setInterval(load, 2000);
    return () => {
      done = true;
      clearInterval(t);
    };
  }, [id, shown]);
  const cwd = now?.cwd ?? terms[id]?.cwd ?? null;
  const folder = cwd ? cwd.replace(/\/+$/, "").split("/").pop() || "/" : terms[id]?.title;
  const sessions = useTermSessions();
  const running = sessions.find((x) => x.term === id);
  const title = [(running?.named && running.name) || folder, shown && now?.process].filter(Boolean).join(" : ");
  const why = needsYou([running], useUnseenTerms());
  return (
    <div
      draggable
      title={`${cwd ? `${cwd} · ` : ""}drag onto a pane to move this shell there, or out of the window to give it its own`}
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-trame-term", id);
        e.dataTransfer.effectAllowed = "move";
        setTermDrag({ kind: "term", id });
      }}
      onDragEnd={(e) => {
        setTermDrag(null);
        if (droppedOutside(e.nativeEvent)) popOut(id);
      }}
      onClick={() => focusPane(tab, id)}
      className={`group flex max-w-56 shrink-0 cursor-pointer items-center gap-1.5 pl-2.5 pr-1 text-[12px] ${
        why ? "text-wait" : shown ? "text-ink" : "text-ink-faint hover:text-ink-soft"
      } ${focused ? "shadow-[inset_0_-2px_0_var(--color-copper)]" : ""}`}
    >
      {running?.agent && <AgentIcon a={{ harness: running.agent, icon: null }} />}
      <span className="truncate">{title}</span>
      {why && (
        <span title={why} className="flex">
          <PresenceDot state="waiting" />
        </span>
      )}
      <IconButton
        tone="close"
        className={`px-1 ${shown ? "" : "invisible group-hover:visible"}`}
        title="close (ends the process)"
        aria-label={`Close ${title}`}
        onClick={(e) => {
          e.stopPropagation();
          void closeTerminal(id);
        }}
      >
        ×
      </IconButton>
    </div>
  );
}
