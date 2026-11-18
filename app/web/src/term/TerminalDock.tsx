import { useEffect, useRef, useState } from "react";
import { AgentIcon } from "../agents/agents";
import type { BoardData, Project } from "../api";
import { projectFor } from "./project-for";
import { appConfirm, EntityIcon, IconButton, MenuRow, Popover, PresenceDot, useLocalStorage } from "../ui/ui";
import { needsYou } from "./attention";
import { ChevronIcon, MaximizeIcon, PlusIcon, SidebarIcon, SplitDownIcon, SplitRightIcon } from "../ui/icons";
import { NewTerminalDialog } from "./NewTerminalDialog";
import { TerminalView } from "./TerminalView";
import {
  closeTab,
  closeTerminal,
  type DropSide,
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
  groups,
  isGroup,
  type PaneNode,
  resizeSplit,
  type SplitDir,
  type TermTab,
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
    const boardProject = (ids: string[]) =>
      ids.map((id) => terms[id]?.project).find((p) => p && board?.projects.some((x) => x.id === p)) ?? null;
    // one agent session's shell: the tabs of the sidebar group it sits in, like TermCards lists them
    const lead = scope!.term ? terms[scope!.term] : undefined;
    const card = lead ? (lead.card && onBoard(lead.card) ? lead.card : null) : scope!.card;
    const scopeProject = lead ? (card ? null : boardProject([scope!.term!])) : scope!.project;
    const cards = tabCards(t, terms);
    if (card !== null) return cards.includes(card);
    // no card: shells whose card isn't on this board, by project like TermCards lists them
    if (cards.some(onBoard)) return false;
    return boardProject(leaves(t.root)) === scopeProject;
  };
  const tabs = scope ? allTabs.filter(inScope) : allTabs;
  const active = tabs.some((t) => t.id === dock.active) ? dock.active : tabs[0]?.id ?? null;
  const open = !!scope || dock.open;
  const full = !!scope || (open && dock.max);
  const [height, setHeight] = useLocalStorage<number>("trame:termHeight", 300, HEIGHT_CODEC);
  const resize = useRef<{ y: number; h: number } | null>(null);
  const current = tabs.find((t) => t.id === active);
  const canSplit = !!current && groups(current.root).length < MAX_PANES;
  // the New terminal dialog (+, ⌘T, the empty view), optionally with an agent preselected
  const [newTerm, setNewTerm] = useState<{ agent?: string; cwd?: string | null } | null>(null);
  // its "Here" is the folder the focused shell is in now
  const openNew = async (agent?: string) =>
    setNewTerm({ agent, cwd: current ? await liveCwd(current.focus) : null });
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
      style={open && !full ? { height } : undefined}
      // ⌘T / Ctrl+T new tab (Ctrl+T no longer reaches the shell), ⌘D / ⌘⇧D split like iTerm and Ghostty, Ctrl+( / Ctrl+), Ctrl+Shift+E and Ctrl+Shift+←/→ (tabs) like Konsole, before the shell sees the key
      onKeyDownCapture={(e) => {
        const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
        const run = (f: () => void) => {
          e.preventDefault();
          e.stopPropagation();
          f();
        };
        if ((e.metaKey || e.ctrlKey) && !(e.metaKey && e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "t") run(() => void openNew());
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
                onDragEnd={() => {
                  clearTimeout(hoverTimer.current);
                  setTermDrag(null);
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
                  title={project ? `${project.name} · ${lead?.cwd}` : lead?.cwd}
                  className="flex items-center gap-1.5"
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
                  <span className={exited ? "opacity-50" : ""}>{name}</span>
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
            title="new terminal or agent (⌘T, Ctrl+T)"
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
            <span>{scope.card ? "No terminal for this card yet." : scope.all ? "No terminals yet." : "No other shells."}</span>
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
// a split's divider: where it sits, the split's own rect, and the path to that split from the tab root
type Divider = { dir: SplitDir; split: Rect; ratio: number; path: string };
// each split gives `ratio` of its space to `a`
// a pane's shells all take its rect; only its active one is shown
function layout(n: PaneNode, r: Rect, panes: [string, Rect, boolean][], lines: Divider[], path = "") {
  if (isGroup(n)) {
    for (const term of n.terms) panes.push([term, r, term === n.active]);
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
const at = (r: Rect) => ({ left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` });

// a tab's shells, absolutely placed so splitting never remounts (and replays) an existing one
const SIDE_ZONE: Record<DropSide, React.CSSProperties> = {
  left: { left: 0, top: 0, width: "50%", height: "100%" },
  right: { right: 0, top: 0, width: "50%", height: "100%" },
  top: { left: 0, top: 0, width: "100%", height: "50%" },
  bottom: { left: 0, bottom: 0, width: "100%", height: "50%" },
};
// the edge of the pane nearest the pointer
const sideAt = (e: React.DragEvent): DropSide => {
  const r = e.currentTarget.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  const near: [DropSide, number][] = [["left", x], ["right", 1 - x], ["top", y], ["bottom", 1 - y]];
  return near.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
};

function Panes(
  { tabs, shown, zoomed, onZoom, drag }: {
    tabs: TermTab[];
    shown: string | null; // the tab on screen, null when the dock is closed
    zoomed: string | null;
    onZoom: (tab: string, term: string) => void;
    drag: TermDrag | null;
  },
) {
  const [hover, setHover] = useState<{ id: string; side: DropSide } | null>(null);
  const panes: { id: string; r: Rect; up: boolean; tab: TermTab; n: number; zoom: string | null }[] = [];
  let lines: Divider[] = [];
  for (const tab of tabs) {
    const mine: [string, Rect, boolean][] = [];
    const tabLines: Divider[] = [];
    layout(tab.root, { x: 0, y: 0, w: 100, h: 100 }, mine, tabLines);
    const zoom = mine.some(([id]) => id === zoomed) ? zoomed : null;
    const n = groups(tab.root).length;
    for (const [id, r, up] of mine) panes.push({ id, r, up, tab, n, zoom });
    if (tab.id === shown && !zoom) lines = tabLines;
  }
  // stable order by id: React moves nothing when a tree changes shape or a shell changes tab
  panes.sort((a, b) => a.id.localeCompare(b.id));
  return (
    <>
      {panes.map(({ id, r, up, tab, n, zoom }) => {
        const visible = tab.id === shown && (up || zoom === id);
        // a tab dragged onto itself, or a card's own tab, takes no drop
        const dropping = drag && visible && !(drag.kind === "term" && drag.id === id) &&
          !(drag.kind === "tab" && drag.id === tab.id) && !(drag.kind === "card" && drag.tab === tab.id);
        return (
          <div
            key={id}
            className={`absolute flex flex-col ${n > 1 && !zoom && tab.focus !== id ? "opacity-80" : ""} ${
              !visible || (zoom && zoom !== id) ? "invisible" : ""
            }`}
            style={at(zoom === id ? { x: 0, y: 0, w: 100, h: 100 } : r)}
          >
            {n > 1 && (
              <PaneHeader
                id={id}
                live={visible && (!zoom || zoom === id)}
                focused={tab.focus === id}
                zoomed={zoom === id}
                onZoom={() => onZoom(tab.id, id)}
              />
            )}
            <div className="min-h-0 flex-1">
              <TerminalView id={id} visible={visible} focused={tab.focus === id} onFocus={() => focusPane(tab.id, id)} />
            </div>
            {dropping && (
              <div
                className="absolute inset-0 z-20"
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  const side = sideAt(e);
                  if (hover?.id !== id || hover.side !== side) setHover({ id, side });
                }}
                onDragLeave={() => setHover(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  const side = sideAt(e);
                  if (drag.kind === "card") {
                    if (drag.tab) mergeTab(drag.tab, tab.id, id, side);
                    else void openTerminalAt({ cwd: drag.cwd, card: drag.id }, { tab: tab.id, term: id, side });
                  } else if (drag.kind === "tab") mergeTab(drag.id, tab.id, id, side);
                  else moveTerm(drag.id, tab.id, id, side);
                  setHover(null);
                  setTermDrag(null);
                }}
              >
                {hover?.id === id && (
                  <div className="pointer-events-none absolute border-2 border-copper bg-copper/15" style={SIDE_ZONE[hover.side]} />
                )}
              </div>
            )}
          </div>
        );
      })}
      {shown && lines.map((d) => <SplitDivider key={`${shown}:${d.path}`} tab={shown} d={d} />)}
    </>
  );
}

const MIN_PANE_PX = 80;
// a split's line; dragging it previews the new position and resizes the panes once, on release
function SplitDivider({ tab, d }: { tab: string; d: Divider }) {
  const [ghost, setGhost] = useState<number | null>(null);
  const box = useRef<DOMRect | null>(null);
  const row = d.dir === "row";
  const ratioAt = (e: React.PointerEvent) => {
    const b = box.current!;
    const px = row ? (b.width * d.split.w) / 100 : (b.height * d.split.h) / 100;
    const start = row ? b.left + (b.width * d.split.x) / 100 : b.top + (b.height * d.split.y) / 100;
    const min = Math.min(0.5, MIN_PANE_PX / px);
    return Math.min(1 - min, Math.max(min, ((row ? e.clientX : e.clientY) - start) / px));
  };
  const ratio = ghost ?? d.ratio;
  const pos = row ? d.split.x + d.split.w * ratio : d.split.y + d.split.h * ratio;
  const line: React.CSSProperties = row
    ? { left: `${pos}%`, top: `${d.split.y}%`, height: `${d.split.h}%` }
    : { top: `${pos}%`, left: `${d.split.x}%`, width: `${d.split.w}%` };
  return (
    <>
      <div className={`pointer-events-none absolute z-10 ${row ? "w-px" : "h-px"} ${ghost === null ? "bg-line" : "bg-copper"}`} style={line} />
      <div
        role="separator"
        aria-orientation={row ? "vertical" : "horizontal"}
        title="drag to resize · double-click to even out"
        className={`absolute z-10 ${row ? "-ml-[3px] w-[7px] cursor-col-resize" : "-mt-[3px] h-[7px] cursor-row-resize"}`}
        style={line}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          box.current = (e.currentTarget.offsetParent as HTMLElement).getBoundingClientRect();
          e.currentTarget.setPointerCapture(e.pointerId);
          setGhost(ratioAt(e));
        }}
        onPointerMove={(e) => ghost !== null && setGhost(ratioAt(e))}
        onPointerUp={(e) => {
          if (ghost === null) return;
          resizeSplit(tab, d.path, ratioAt(e));
          setGhost(null);
        }}
        onPointerCancel={() => setGhost(null)}
        onDoubleClick={() => resizeSplit(tab, d.path, 0.5)}
      />
    </>
  );
}

// a split pane's title bar, like Konsole's: "folder : process", maximize and close; drag it onto a pane to move it
function PaneHeader(
  { id, live, focused, zoomed, onZoom }: { id: string; live: boolean; focused: boolean; zoomed: boolean; onZoom: () => void },
) {
  const { terms } = useTermDock();
  const [now, setNow] = useState<TermNow | null>(null);
  useEffect(() => {
    if (!live) return;
    let done = false;
    const load = () => void termNow(id).then((n) => !done && setNow(n));
    load();
    const t = setInterval(load, 2000);
    return () => {
      done = true;
      clearInterval(t);
    };
  }, [id, live]);
  const cwd = now?.cwd ?? terms[id]?.cwd ?? null;
  const folder = cwd ? cwd.replace(/\/+$/, "").split("/").pop() || "/" : terms[id]?.title;
  const session = useTermSessions().find((x) => x.term === id && x.named);
  const title = [session?.name ?? folder, now?.process].filter(Boolean).join(" : ");
  const running = useTermSessions().find((x) => x.term === id);
  const agent = running?.agent;
  const why = needsYou([running], useUnseenTerms());
  return (
    <div
      draggable
      title={cwd ? `${cwd} · drag onto a pane to move this shell there` : "drag onto a pane to move this shell there"}
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-trame-term", id);
        e.dataTransfer.effectAllowed = "move";
        setTermDrag({ kind: "term", id });
      }}
      onDragEnd={() => setTermDrag(null)}
      className={`flex h-6 shrink-0 cursor-grab items-center gap-0.5 border-b border-line pl-14 pr-1 text-[11px] ${
        why ? "bg-wait/15 text-wait" : focused ? "text-ink" : "text-ink-faint"
      }`}
    >
      <span className="flex min-w-0 flex-1 items-center justify-center gap-1.5">
        {agent && <AgentIcon a={{ harness: agent, icon: null }} />}
        <span className="truncate">{title}</span>
        {why && (
          <span title={why} className="flex">
            <PresenceDot state="waiting" />
          </span>
        )}
      </span>
      <IconButton
        tone="close"
        className="px-1"
        title={zoomed ? "restore the split (Ctrl+Shift+E)" : "maximize this pane (Ctrl+Shift+E)"}
        aria-label={zoomed ? "Restore split" : "Maximize pane"}
        onClick={onZoom}
      >
        <MaximizeIcon size={12} restore={zoomed} />
      </IconButton>
      <IconButton
        tone="close"
        className="px-1"
        title="close this pane (ends its process)"
        aria-label={`Close ${title}`}
        onClick={() => void closeTerminal(id)}
      >
        ×
      </IconButton>
    </div>
  );
}
