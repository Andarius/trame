import { useMemo } from "react";
import type { BoardData } from "../api";
import { AgentIcon, Elapsed, useAgents } from "../agents/agents";
import { setTermDrag, useTermDock } from "../term/term-api";
import { PrIcon, TerminalIcon } from "../ui/icons";
import { EntityIcon, FoldLabel, SECTION_LABEL, SET_CODEC, StatusDot, useFold, useLocalStorage } from "../ui/ui";
import { type CardNode, type StoryNode, workingNow } from "./working-now";

type Open = {
  onOpenSession: (id: string) => void;
  onOpenTerminals: (card: string) => void;
  onOpenPage: (id: string) => void;
};

const harnessLabel = (h: string) => (h.startsWith("claude") ? "Claude" : h === "codex" ? "Codex" : h);
const row = "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-[4px] text-left hover:bg-active-row";
// children line up under their parent's title; the guide line runs under the parent's icon
const storyNest = "ml-[34px] border-l border-line pl-[5px]";
const cardNest = "ml-[11px] border-l border-line pl-[3px]";

// a live agent's dot: green while working, yellow while it waits for you
function LiveDot({ state }: { state: "working" | "waiting" }) {
  return (
    <span
      className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${state === "waiting" ? "bg-wait" : "bg-live"}`}
      style={{ boxShadow: `0 0 0 3px color-mix(in srgb, var(--color-${state === "waiting" ? "wait" : "live"}) 22%, transparent)` }}
    />
  );
}

function CardRow({ node, fork, open }: { node: CardNode; fork?: boolean; open: Open }) {
  const { card, agent, shells, forks } = node;
  const link = agent?.a.links[0];
  return (
    <li>
      <button type="button" className={row} title={card.title} onClick={() => open.onOpenSession(card.id)}>
        {fork && <span className="w-3 shrink-0 text-center text-[11px] text-copper" title="fork">⑂</span>}
        {agent ? <LiveDot state={agent.state} /> : <StatusDot status={card.status} size={7} />}
        <span className="truncate text-[12.5px] text-ink">{card.title}</span>
        {card.pr_url && <span className="ml-auto text-ink-muted" title="has a PR"><PrIcon /></span>}
      </button>
      {(agent || shells.length > 0 || forks.length > 0) && (
        <ul className={cardNest}>
          {agent && (
            <li>
              <button
                type="button"
                className={`${row} ${agent.state === "waiting" ? "bg-wait/[0.08]" : ""}`}
                title={agent.a.question ?? agent.a.step ?? undefined}
                onClick={() => (link ? open.onOpenPage(link.page_id) : open.onOpenSession(card.id))}
              >
                <AgentIcon a={agent.a} />
                <span className={`truncate text-[11.5px] ${agent.state === "waiting" ? "italic text-ink-soft" : "text-ink-muted"}`}>
                  {agent.state === "waiting"
                    ? `needs you: ${agent.a.question ?? "waiting for input"}`
                    : `${harnessLabel(agent.a.harness)}${agent.a.model ? ` · ${agent.a.model}` : ""}`}
                </span>
                <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-ink-faint">
                  <Elapsed since={agent.a.since} state={agent.state} />
                </span>
              </button>
            </li>
          )}
          {forks.map((f) => <CardRow key={f.card.id} node={f} fork open={open} />)}
          {shells.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className={row}
                draggable={!s.exited}
                title="drag onto a terminal pane to split it"
                onClick={() => open.onOpenTerminals(card.id)}
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/x-trame-term", s.id);
                  e.dataTransfer.effectAllowed = "move";
                  setTermDrag({ kind: "term", id: s.id });
                }}
                onDragEnd={() => setTermDrag(null)}
              >
                <span className="text-ink-muted"><TerminalIcon /></span>
                <span className={`truncate text-[11.5px] ${s.exited ? "text-ink-faint" : "text-ink-muted"}`}>{s.title}</span>
                {s.exited && <span className="ml-auto shrink-0 text-[10px] text-ink-faint">exited</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function StoryRow({ story, collapsed, toggle, open }: { story: StoryNode; collapsed: boolean; toggle: () => void; open: Open }) {
  const waiting = story.cards.some(function busy(n): boolean {
    return n.agent?.state === "waiting" || n.forks.some(busy);
  });
  return (
    <li>
      <div className={`${row} group`}>
        <button type="button" className="w-3 shrink-0 text-[9px] text-ink-faint" aria-label={collapsed ? "Expand" : "Collapse"} onClick={toggle}>
          {collapsed ? "▸" : "▾"}
        </button>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          disabled={!story.id}
          onClick={() => story.id && open.onOpenPage(story.id)}
        >
          {story.project?.icon ? <EntityIcon icon={story.project.icon} size={14} /> : <span className="w-3.5 text-center text-[12px] text-ink-muted">◇</span>}
          <span className="truncate text-[12.5px] font-semibold text-ink">{story.title}</span>
          {collapsed && waiting && <LiveDot state="waiting" />}
        </button>
        {story.project && <span className="shrink-0 text-[10.5px] text-ink-faint">{story.project.name}</span>}
      </div>
      {!collapsed && (
        <ul className={storyNest}>
          {story.cards.map((n) => <CardRow key={n.card.id} node={n} open={open} />)}
        </ul>
      )}
    </li>
  );
}

// What runs now, nested like Claude Code's session list: story → card → agent, forks, shells.
export function WorkingNow({ board, ...open }: { board: BoardData | null } & Open) {
  const { live } = useAgents();
  const { terms } = useTermDock();
  const tree = useMemo(() => (board ? workingNow(board, live, Object.values(terms)) : []), [board, live, terms]);
  const [collapsed, setCollapsed] = useLocalStorage("trame:workingCollapsed", new Set<string>(), SET_CODEC);
  const [folded, setFolded] = useFold("working");
  if (tree.length === 0) return null;
  return (
    <nav aria-label="Working now" className="flex flex-col">
      <div className={`flex px-2 pb-1.5 pt-4 ${SECTION_LABEL}`}>
        <FoldLabel folded={folded} onToggle={() => setFolded((f) => !f)}>WORKING NOW</FoldLabel>
      </div>
      {!folded && (
      <ul className="flex flex-col">
        {tree.map((s) => {
          const key = s.id ?? "none";
          return (
            <StoryRow
              key={key}
              story={s}
              collapsed={collapsed.has(key)}
              toggle={() => {
                const next = new Set(collapsed);
                if (!next.delete(key)) next.add(key);
                setCollapsed(next);
              }}
              open={open}
            />
          );
        })}
      </ul>
      )}
    </nav>
  );
}
