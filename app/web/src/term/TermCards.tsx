import type { BoardData, Session } from "../api";
import { AgentIcon, Elapsed, type Live, useAgents } from "../agents/agents";
import { EntityIcon, SECTION_LABEL, StatusDot } from "../ui/ui";
import { useTermDock } from "./term-api";

// The Terminals view's sidebar column: cards with shells or a live agent, grouped by project
// (Orca's project → branch list, with cards); `selected` stays listed even without either.
export function TermCards(
  { board, selected, onSelect }: {
    board: BoardData | null;
    selected: string | null;
    onSelect: (card: string | null) => void;
  },
) {
  const { terms } = useTermDock();
  const { live } = useAgents();
  const agentOf = new Map<string, Live>(live.map((l) => [l.a.session_id, l]));
  const shells = new Map<string | null, { count: number; running: number }>();
  for (const t of Object.values(terms)) {
    const n = shells.get(t.card) ?? { count: 0, running: 0 };
    shells.set(t.card, { count: n.count + 1, running: n.running + (t.exited ? 0 : 1) });
  }
  const cards = (board?.sessions ?? []).filter((s) => shells.has(s.id) || agentOf.has(s.id) || s.id === selected);
  const groups = new Map<string | null, Session[]>();
  for (const s of cards) groups.set(s.client_id, [...(groups.get(s.client_id) ?? []), s]);
  const projects = [...groups.keys()].sort((a, b) =>
    a === null ? 1 : b === null ? -1 : projectName(board, a).localeCompare(projectName(board, b))
  );
  // shells whose card was deleted or isn't on this board count as plain shells
  const known = new Set(board?.sessions.map((s) => s.id));
  const orphans = [...shells].filter(([card]) => card === null || !known.has(card));
  const plain = orphans.reduce((n, [, v]) => n + v.count, 0);

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
      {cards.length === 0 && plain === 0 && (
        <p className="px-2 text-[11.5px] leading-snug text-ink-muted">
          No terminals yet. Open one from a card with Open in agent → Trame terminal.
        </p>
      )}
      {projects.map((client) => (
        <section key={client ?? "none"} className="flex flex-col gap-0.5">
          <div className={`flex items-center gap-1.5 px-2 pb-1 ${SECTION_LABEL}`}>
            {client && <EntityIcon icon={board?.projects.find((p) => p.id === client)?.icon} size={12} />}
            {client ? projectName(board, client).toUpperCase() : "NO PROJECT"}
          </div>
          {groups.get(client)!.map((s) =>
            row(s.id, s.id === selected, () => onSelect(s.id), (
              <>
                <span className="flex w-full items-center gap-2">
                  <StatusDot status={s.status} size={7} />
                  <span className="min-w-0 flex-1 truncate" title={s.title}>{s.title}</span>
                  {count(shells.get(s.id))}
                </span>
                <AgentLine l={agentOf.get(s.id)} />
              </>
            ))
          )}
        </section>
      ))}
      {plain > 0 && (
        <section className="flex flex-col gap-0.5">
          <div className={`px-2 pb-1 ${SECTION_LABEL}`}>OTHER</div>
          {row("plain", selected === null, () => onSelect(null), (
            <span className="flex w-full items-center gap-2">
              <span className="w-[7px] text-center text-ink-faint">·</span>
              <span className="flex-1">Shells without a card</span>
              {count({ count: plain, running: orphans.reduce((n, [, v]) => n + v.running, 0) })}
            </span>
          ))}
        </section>
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
