import { useEffect, useRef, useState } from "react";
import { AgentIcon } from "../agents/agents";
import type { BoardData, Project } from "../api";
import { projectFor } from "./project-for";
import { EntityIcon, IconButton, useLocalStorage } from "../ui/ui";
import { NewTerminalDialog } from "./NewTerminalDialog";
import { TerminalView } from "./TerminalView";
import {
  closeTab,
  closeTerminal,
  type DropSide,
  focusPane,
  leaves,
  mergeTab,
  MAX_PANES,
  moveTerm,
  type PaneNode,
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
  termAgents,
  useTermDock,
} from "./term-api";

function ProjectMark({ project }: { project: Project | null }) {
  if (project?.icon) return <EntityIcon icon={project.icon} size={12} />;
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

// The Terminals view narrows the dock to one card's tabs, or (no card) a project's shells, or plain ones.
export type DockScope = { card: string | null; project: string | null; cwd: string | null };

// Bottom panel of embedded terminals: a tab strip that stays when collapsed, shells kept mounted.
// With a `scope` it is the Terminals view's center instead: always open, full size, one card's tabs.
// Both are the same mounted component, so moving between them never remounts (and replays) a shell.
export default function TerminalDock(
  { board, scope, onScope }: {
    board?: BoardData | null;
    scope?: DockScope | null;
    onScope?: (card: string | null, project: string | null) => void; // show another card's or project's shells
  },
) {
  const dock = useTermDock();
  const { terms, tabs: allTabs } = dock;
  const inScope = (t: TermTab) => {
    const cards = tabCards(t, terms);
    if (scope!.card !== null) return cards.includes(scope!.card);
    // no card: shells whose card isn't on this board, by project like TermCards lists them
    if (cards.some((c) => board?.sessions.some((s) => s.id === c))) return false;
    const project = leaves(t.root).map((id) => terms[id]?.project).find((p) => p && board?.projects.some((x) => x.id === p));
    return (project ?? null) === scope!.project;
  };
  const tabs = scope ? allTabs.filter(inScope) : allTabs;
  const active = tabs.some((t) => t.id === dock.active) ? dock.active : tabs[0]?.id ?? null;
  const open = !!scope || dock.open;
  const full = !!scope || (open && dock.max);
  const [height, setHeight] = useLocalStorage<number>("trame:termHeight", 300, HEIGHT_CODEC);
  const resize = useRef<{ y: number; h: number } | null>(null);
  const current = tabs.find((t) => t.id === active);
  const canSplit = !!current && leaves(current.root).length < MAX_PANES;
  // the New terminal dialog (+, ⌘T, the empty view), optionally with an agent preselected
  const [newTerm, setNewTerm] = useState<{ agent?: string } | null>(null);
  // a tab or a shell being dragged onto the panes (Konsole-style layout)
  const drag = dock.drag;
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [agents, setAgents] = useState<TermAgent[] | null>(null);
  // fetched with the dock: finding them runs the user's shell profile (~2s)
  useEffect(() => {
    void termAgents().then(setAgents);
  }, []);
  const lead = current ? terms[current.focus] : null;
  const cwd = lead?.cwd ?? scope?.cwd ?? null;
  const card = scope ? scope.card : lead?.card ?? null;
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
      // ⌘D / ⌘⇧D split like iTerm and Ghostty, before the shell sees the key
      onKeyDownCapture={(e) => {
        if (e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "t") {
          e.preventDefault();
          e.stopPropagation();
          setNewTerm({});
        } else if (e.metaKey && !e.altKey && !e.ctrlKey && e.key.toLowerCase() === "d") {
          e.preventDefault();
          e.stopPropagation();
          void splitTerminal(e.shiftKey ? "col" : "row");
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
      <div className="flex h-8 shrink-0 items-center gap-1 px-2 text-xs">
        <span className="pr-1 text-[11px] font-medium text-ink-muted">Terminal</span>
        <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
          {tabs.map((t) => {
            const panes = leaves(t.root);
            const lead = terms[t.focus];
            const project = projectOf(board, lead?.card, lead?.cwd, lead?.project);
            const exited = panes.every((p) => terms[p]?.exited);
            return (
              <div
                key={t.id}
                draggable
                title="drag onto a pane to split it with this tab"
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/x-trame-tab", t.id);
                  e.dataTransfer.effectAllowed = "move";
                  setTermDrag({ kind: "tab", id: t.id });
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
                className={`group flex shrink-0 cursor-grab items-center gap-1 rounded-md px-2 py-0.5 ${
                  t.id === active && open ? "bg-tab-active text-ink" : "text-ink-muted hover:text-ink-soft"
                } ${drag?.kind === "tab" && drag.id === t.id ? "opacity-50" : ""}`}
              >
                <button
                  type="button"
                  title={project ? `${project.name} · ${lead?.cwd}` : lead?.cwd}
                  className="flex items-center gap-1.5"
                  onClick={() => (t.id === active && open && !scope ? setDockOpen(false) : selectTab(t.id))}
                >
                  <ProjectMark project={project} />
                  <span className={exited ? "opacity-50" : ""}>{lead?.title}</span>
                  {panes.length > 1 && <span className="pl-1 text-[10px] text-ink-faint">{panes.length}</span>}
                </button>
                <IconButton
                  tone="close"
                  aria-label={`Close ${lead?.title}`}
                  title={panes.length > 1 ? "close the tab (ends its processes)" : "close (ends the process)"}
                  className="opacity-0 group-hover:opacity-100"
                  onClick={() => void closeTab(t.id)}
                >
                  ×
                </IconButton>
              </div>
            );
          })}
        </div>
        <div className="relative shrink-0">
          <IconButton
            tone="close"
            className="px-1.5"
            title="new terminal or agent (⌘T)"
            aria-label="New terminal or agent"
            onClick={() => setNewTerm({})}
          >
            +
          </IconButton>
        </div>
        <div className="flex-1" />
        {canSplit && (
          <>
            <IconButton tone="close" className="px-1" title="split right (⌘D)" aria-label="Split right" onClick={() => void splitTerminal("row")}>
              ◫
            </IconButton>
            <IconButton tone="close" className="px-1" title="split down (⌘⇧D)" aria-label="Split down" onClick={() => void splitTerminal("col")}>
              ⊟
            </IconButton>
          </>
        )}
        {!scope && (
        <>
        <IconButton
          tone="close"
          className="px-1"
          title={full ? "restore (Ctrl+Shift+`)" : "fill the view (Ctrl+Shift+`)"}
          aria-label={full ? "Restore terminal" : "Maximize terminal"}
          onClick={() => setDockMax(!full)}
        >
          {full ? "⤡" : "⤢"}
        </IconButton>
        <IconButton
          tone="close"
          className="px-1"
          title={open ? "hide (Ctrl+`)" : "show (Ctrl+`)"}
          aria-label={open ? "Hide terminal" : "Show terminal"}
          onClick={() => setDockOpen(!open)}
        >
          {open ? "▾" : "▴"}
        </IconButton>
        </>
        )}
      </div>
      <div className={`relative min-h-0 flex-1 bg-block ${open ? "" : "hidden"}`}>
        {scope && tabs.length === 0 && (
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
            <span>{scope.card ? "No terminal for this card yet." : "No other shells."}</span>
            <div className="flex gap-2">
              <button type="button" className="rounded-md border border-line px-3 py-1.5 hover:text-ink" onClick={() => setNewTerm({ agent: "shell" })}>
                New terminal
              </button>
              {agents?.map((a) => (
                <button
                  key={a.command}
                  type="button"
                  className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 hover:text-ink"
                  onClick={() => setNewTerm({ agent: a.command })}
                >
                  <AgentIcon a={{ harness: a.command, icon: null }} />
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {/* every tab stays mounted, in or out of scope: hiding never detaches a shell */}
        {allTabs.map((t) => (
          <div key={t.id} className={`absolute inset-0 ${open && t.id === active ? "" : "invisible"}`}>
            <Panes
              tab={t}
              shown={open && t.id === active}
              drag={drag && !(drag.kind === "tab" && drag.id === t.id) && !(drag.kind === "card" && drag.tab === t.id)
                ? drag
                : null}
            />
          </div>
        ))}
      </div>
    </section>
    {newTerm && (
      <NewTerminalDialog
        board={board ?? null}
        here={{ cwd, card, project: scope?.project ?? lead?.project ?? null }}
        agent={newTerm.agent}
        onClose={() => setNewTerm(null)}
        onOpened={(c, p) => {
          if (scope && (c !== scope.card || (!c && p !== scope.project))) onScope?.(c, p);
        }}
      />
    )}
    </>
  );
}

type Rect = { x: number; y: number; w: number; h: number }; // percent of the tab body
// splits halve their space; dividers sit on the split line
function layout(n: PaneNode, r: Rect, panes: [string, Rect][], lines: Rect[]) {
  if ("term" in n) {
    panes.push([n.term, r]);
    return;
  }
  if (n.dir === "row") {
    const w = r.w / 2;
    layout(n.a, { ...r, w }, panes, lines);
    layout(n.b, { ...r, x: r.x + w, w }, panes, lines);
    lines.push({ ...r, x: r.x + w, w: 0 });
  } else {
    const h = r.h / 2;
    layout(n.a, { ...r, h }, panes, lines);
    layout(n.b, { ...r, y: r.y + h, h }, panes, lines);
    lines.push({ ...r, y: r.y + h, h: 0 });
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
  { tab, shown, drag }: { tab: TermTab; shown: boolean; drag: TermDrag | null },
) {
  const { terms } = useTermDock();
  const [hover, setHover] = useState<{ id: string; side: DropSide } | null>(null);
  const panes: [string, Rect][] = [];
  const lines: Rect[] = [];
  layout(tab.root, { x: 0, y: 0, w: 100, h: 100 }, panes, lines);
  const split = panes.length > 1;
  // stable order by id: React moves nothing when the tree changes shape
  panes.sort(([a], [b]) => a.localeCompare(b));
  return (
    <>
      {panes.map(([id, r]) => (
        <div
          key={id}
          className={`group/pane absolute ${split && tab.focus !== id ? "opacity-80" : ""}`}
          style={at(r)}
        >
          <TerminalView id={id} visible={shown} focused={tab.focus === id} onFocus={() => focusPane(tab.id, id)} />
          {drag && shown && !(drag.kind === "term" && drag.id === id) && (
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
          {split && (
            <IconButton
              tone="close"
              className="absolute right-1.5 top-1 z-10 px-1 text-xs opacity-0 group-hover/pane:opacity-100"
              title="close this pane (ends its process)"
              aria-label={`Close ${terms[id]?.title ?? "pane"}`}
              onClick={() => void closeTerminal(id)}
            >
              ×
            </IconButton>
          )}
        </div>
      ))}
      {lines.map((r, i) => (
        <div
          key={i}
          className={`absolute bg-line ${r.w === 0 ? "w-px" : "h-px"}`}
          style={r.w === 0 ? { left: `${r.x}%`, top: `${r.y}%`, height: `${r.h}%` } : { left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%` }}
        />
      ))}
    </>
  );
}
