import { useContext } from "react";
import type { BoardData, DueTodo } from "../api";
import { DUE_TONE_CLS, dueLabel, dueTone, focusBlock } from "../ui/due";
import { GroupMenu } from "../ui/GroupMenu";
import { EntityIcon, enumCodec, SECTION_LABEL, useLocalStorage } from "../ui/ui";
import { TreeCardsCtx } from "./sidebar-tree";

const GROUPINGS = ["none", "project", "when"] as const;
type Grouping = typeof GROUPINGS[number];
const GROUPING_LABEL: Record<Grouping, string> = { none: "No grouping", project: "Project", when: "When" };
const WHEN_LABEL = { late: "LATE", soon: "NEXT 3 DAYS", later: "LATER" } as const;
const TONE_TEXT = { late: "text-blocked", soon: "text-wait", later: "text-ink-faint" } as const;

// the todo's project: its card's, else its page's or the nearest ancestor's
function projectOf(board: BoardData | null, d: DueTodo): string | null {
  const card = d.card_id ? board?.sessions.find((s) => s.id === d.card_id) : null;
  if (card?.client_id) return card.client_id;
  const pages = new Map(board?.pages.map((p) => [p.id, p]));
  for (let p = pages.get(d.page_id), seen = 0; p && seen < 32; p = p.parent_id ? pages.get(p.parent_id) : undefined, seen++) {
    if (p.client_id) return p.client_id;
    if (p.kind === "project") return p.id;
  }
  return null;
}

// The workspace sidebar's DUE section: dated todos, soonest first, optionally grouped by project or by when
export function DueList(
  { due, board, onOpenPage }: { due: DueTodo[]; board: BoardData | null; onOpenPage: (id: string) => void },
) {
  const treeCards = useContext(TreeCardsCtx);
  const [grouping, setGrouping] = useLocalStorage<Grouping>("trame:dueGrouping", "none", enumCodec(GROUPINGS));
  const lateCount = due.filter((d) => dueTone(d.due) === "late").length;
  const projectName = (id: string) => board?.projects.find((p) => p.id === id)?.name ?? "";

  const keyOf = (d: DueTodo) => grouping === "project" ? projectOf(board, d) : grouping === "when" ? dueTone(d.due) : "all";
  const groups = new Map<string | null, DueTodo[]>();
  for (const d of due) groups.set(keyOf(d), [...(groups.get(keyOf(d)) ?? []), d]);
  const keys = [...groups.keys()];
  if (grouping === "project") {
    keys.sort((a, b) => (a === null ? 1 : b === null ? -1 : projectName(a).localeCompare(projectName(b))));
  } else if (grouping === "when") {
    const order = Object.keys(WHEN_LABEL);
    keys.sort((a, b) => order.indexOf(a!) - order.indexOf(b!));
  }

  const row = (d: DueTodo) => {
    const tone = dueTone(d.due);
    return (
      <button
        type="button"
        key={`${d.page_id}:${d.block_id ?? d.text}`}
        onClick={() => {
          if (d.block_id) focusBlock(d.block_id);
          if (d.card_id) treeCards.open(d.card_id);
          else onOpenPage(d.page_id);
        }}
        title={`${d.text} — ${d.page_title}`}
        className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 rounded-md px-2 py-[5px] text-left hover:bg-active-row"
      >
        <span className={TONE_TEXT[tone]}>⚑</span>
        <span className="truncate text-[13px] text-ink">{d.text}</span>
        <span className={`whitespace-nowrap text-[11px] tabular-nums ${TONE_TEXT[tone]}`}>{dueLabel(d.due)}</span>
      </button>
    );
  };

  return (
    <nav aria-label="Due todos" className="group/due flex flex-col gap-0.5">
      <div className={`flex items-center gap-1 px-2 pb-1.5 pt-4 ${SECTION_LABEL}`}>
        DUE
        <GroupMenu
          value={grouping}
          options={GROUPING_LABEL}
          onChange={setGrouping}
          className="ml-auto opacity-0 focus-within:opacity-100 group-hover/due:opacity-100"
        />
        <span
          className={`rounded-full px-1.5 text-[10.5px] tracking-normal tabular-nums ${
            lateCount ? DUE_TONE_CLS.late : DUE_TONE_CLS.later
          }`}
        >
          {lateCount ? `${lateCount} late · ${due.length}` : due.length}
        </span>
      </div>
      {keys.map((key) => (
        <div key={key ?? "none"} className="flex flex-col gap-0.5">
          {grouping !== "none" && (
            <div className="flex items-center gap-1.5 px-2 pb-0.5 pt-1.5 text-[10px] font-medium tracking-[0.08em] text-ink-faint">
              {grouping === "project" && key && <EntityIcon icon={board?.projects.find((p) => p.id === key)?.icon} size={14} />}
              {grouping === "when"
                ? WHEN_LABEL[key as keyof typeof WHEN_LABEL]
                : key ? projectName(key).toUpperCase() : "NO PROJECT"}
            </div>
          )}
          {groups.get(key)!.map(row)}
        </div>
      ))}
    </nav>
  );
}
