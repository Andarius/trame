import { type MouseEvent, useContext, useEffect, useState } from "react";
import { setMark, todayMark } from "../../../../core/todo-marks.ts";
import { type BoardData, type DueTodo, getPage, resumeCommand, updatePage } from "../api";
import { openTerminal } from "../term/term-api";
import { DUE_TONE_CLS, dueLabel, dueTone, focusBlock, refreshDue } from "../ui/due";
import { GroupMenu } from "../ui/GroupMenu";
import { clearSelection, EntityIcon, enumCodec, FoldLabel, IconButton, SECTION_LABEL, useFold, useLocalStorage } from "../ui/ui";
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

const rowKey = (d: DueTodo) => `${d.page_id}:${d.block_id ?? d.text}`;
const ACTION = "whitespace-nowrap rounded-md px-1.5 py-0.5 text-[12px] text-ink-muted hover:bg-hover hover:text-ink disabled:opacity-40";

// ticks the selected todos on their pages, stamped like a click in the editor
async function markDone(todos: DueTodo[]) {
  const byPage = new Map<string, Set<string>>();
  for (const d of todos) if (d.block_id) byPage.set(d.page_id, (byPage.get(d.page_id) ?? new Set()).add(d.block_id));
  await Promise.all([...byPage].map(async ([pageId, ids]) => {
    const page = await getPage(pageId);
    const content = page.content.map((b) =>
      b.type === "todo" && !b.done && ids.has(b.id ?? "")
        ? { ...b, done: true, text: setMark(b.text, "completed_at", todayMark()) }
        : b
    );
    await updatePage(pageId, { content });
  }));
}

// The workspace sidebar's DUE section: dated todos, soonest first, optionally grouped by project or by when
export function DueList(
  { due, board, onOpenPage, onOpenTerminals }: {
    due: DueTodo[];
    board: BoardData | null;
    onOpenPage: (id: string) => void;
    onOpenTerminals: (card: string) => void;
  },
) {
  const treeCards = useContext(TreeCardsCtx);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [grouping, setGrouping] = useLocalStorage<Grouping>("trame:dueGrouping", "none", enumCodec(GROUPINGS));
  const [folded, setFolded] = useFold("due");
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

  // rendered order, so a Shift range follows what's on screen
  const ordered = keys.flatMap((k) => groups.get(k)!);
  const picked = ordered.filter((d) => selected.has(rowKey(d)));
  const cards = [...new Set(picked.flatMap((d) => (d.card_id ? [d.card_id] : [])))];

  // drop selections whose todo left the list (done elsewhere, date moved)
  useEffect(() => {
    const live = new Set(due.map(rowKey));
    setSelected((prev) => ([...prev].every((k) => live.has(k)) ? prev : new Set([...prev].filter((k) => live.has(k)))));
  }, [due]);

  useEffect(() => {
    if (!selected.size) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSelected(new Set());
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [selected.size]);

  const select = (d: DueTodo, e: MouseEvent) => {
    const k = rowKey(d);
    if (e.shiftKey && anchor) {
      const keys = ordered.map(rowKey);
      const [a, b] = [keys.indexOf(anchor), keys.indexOf(k)].sort((x, y) => x - y);
      if (a >= 0) return setSelected(new Set(keys.slice(a, b + 1)));
    }
    const next = new Set(selected);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setSelected(next);
    setAnchor(k);
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doneSelected = () => run(async () => {
    await markDone(picked);
    refreshDue();
  });

  // each selected todo's card, in a Trame terminal like the card's own button
  const openSelected = () => run(async () => {
    for (const card of cards) {
      let r = await resumeCommand(card);
      // nothing to resume here: start the card's agent on it, as the card's "Open in" does
      if (!r.ok) r = await resumeCommand(card, r.agent ?? "claude");
      if (!r.ok || !r.repo) throw new Error(`${board?.sessions.find((s) => s.id === card)?.title ?? card}: can't resume here`);
      const title = board?.sessions.find((s) => s.id === card)?.title;
      await openTerminal({ cwd: r.repo, command: r.command, title, card });
    }
    onOpenTerminals(cards.at(-1)!);
  });

  const row = (d: DueTodo) => {
    const tone = dueTone(d.due);
    const on = selected.has(rowKey(d));
    return (
      <button
        type="button"
        key={rowKey(d)}
        aria-pressed={on}
        onMouseDown={(e) => e.shiftKey && e.preventDefault()}
        onClick={(e) => {
          if (e.shiftKey || e.metaKey || e.ctrlKey) {
            clearSelection();
            return select(d, e);
          }
          // a plain click selects just this todo (the Shift anchor) and opens it
          setSelected(new Set([rowKey(d)]));
          setAnchor(rowKey(d));
          if (d.block_id) focusBlock(d.block_id);
          if (d.card_id) treeCards.open(d.card_id);
          else onOpenPage(d.page_id);
        }}
        title={`${d.text} — ${d.page_title}`}
        className={`grid grid-cols-[auto_1fr_auto] items-center gap-x-2 rounded-md px-2 py-[5px] text-left ${
          on ? "bg-active-row ring-1 ring-inset ring-copper/50" : "hover:bg-active-row"
        }`}
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
        <FoldLabel folded={folded} onToggle={() => setFolded((f) => !f)}>DUE</FoldLabel>
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
      {!folded && selected.size > 0 && (
        <div className="mx-1 mb-1 flex flex-col gap-0.5 rounded-md border border-line bg-panel px-1.5 py-1">
          <div className="flex items-center">
            <span className="px-1 text-[12px] tabular-nums text-ink-soft">{selected.size} selected</span>
            <IconButton
              tone="close"
              className="ml-auto px-1 text-[13px]"
              aria-label="Clear selection"
              title="Clear (Esc)"
              onClick={() => setSelected(new Set())}
            >
              ✕
            </IconButton>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className={ACTION}
              disabled={busy || !cards.length}
              title={cards.length
                ? `Resume ${cards.length === 1 ? "its card" : `${cards.length} cards`} in Trame terminals`
                : "None of these todos is on a card"}
              onClick={openSelected}
            >
              Open terminal
            </button>
            <button type="button" className={ACTION} disabled={busy} onClick={doneSelected}>
              Mark done
            </button>
          </div>
        </div>
      )}
      {error && <div className="px-2 pb-1 text-[11.5px] text-blocked">{error}</div>}
      {!folded && keys.map((key) => (
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
