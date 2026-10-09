import { createContext, useContext, useEffect, useState } from "react";
import { daysUntil, isShownDue } from "../../../../core/due.ts";
import { type Block, type DueTodo, getDue } from "../api";
import { todayMark } from "../../../../core/todo-marks.ts";
import { MenuRow, Popover } from "./ui";

// Due dates on todos: the {{trame:due=YYYY-MM-DD}} mark rendered as a pill, the
// picker that writes it, and the wording shared with the sidebar's DUE section.

// the todo a pill sits on: a checked todo's due date is history, not a warning;
// onDue opens the date picker when the pill is clicked
export const TodoDueCtx = createContext<{ done: boolean; onDue?: () => void }>({ done: false });

const WEEKDAY = new Intl.DateTimeFormat("en", { weekday: "short" });
const LONG = new Intl.DateTimeFormat("en", { weekday: "short", day: "numeric", month: "short" });
const local = (iso: string) => new Date(`${iso}T00:00:00`);

// within a week: words ("in 2 days", "3 days late"); further out: "Tue 13"
export function dueLabel(due: string, today = todayMark()): string {
  const d = daysUntil(due, today);
  if (d < 0) return `${-d} day${d === -1 ? "" : "s"} late`;
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d < 7) return `in ${d} days`;
  return `${WEEKDAY.format(local(due))} ${local(due).getDate()}`;
}

export function dueTone(due: string, today = todayMark()): "late" | "soon" | "later" {
  const d = daysUntil(due, today);
  return d < 0 ? "late" : d <= 3 ? "soon" : "later";
}

export const DUE_TONE_CLS = {
  late: "bg-blocked/15 text-blocked",
  soon: "bg-wait/15 text-wait",
  later: "border border-chipline bg-panel text-ink-soft",
} as const;

export function DuePill({ due }: { due: string }) {
  const { done, onDue } = useContext(TodoDueCtx);
  // an empty mark is the editor's placeholder: a hover-only way in to the picker
  if (!due) {
    if (!onDue || done) return null;
    return (
      <button
        type="button"
        title="Set a due date"
        className="ml-1.5 hidden whitespace-nowrap rounded-full border border-dashed border-line px-1.5 align-[1px] text-[0.78em] text-ink-faint hover:text-ink group-hover:inline-block"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          onDue();
        }}
      >
        ⚑ due
      </button>
    );
  }
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(due);
  const cls = `ml-1.5 inline-block whitespace-nowrap rounded-full px-1.5 py-px align-[1px] text-[0.78em] tabular-nums ${
    done || !valid ? DUE_TONE_CLS.later : DUE_TONE_CLS[dueTone(due)]
  }`;
  const title = valid ? `due ${LONG.format(local(due))}` : `due ${due}`;
  const label = <>⚑ {valid ? (done ? LONG.format(local(due)) : dueLabel(due)) : due}</>;
  if (!onDue) return <span title={title} className={cls}>{label}</span>;
  return (
    <button
      type="button"
      title={`${title} — change`}
      className={`${cls} cursor-pointer hover:brightness-125`}
      // the line itself opens the editor on click; the pill opens the picker instead
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        onDue();
      }}
    >
      {label}
    </button>
  );
}

const addDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return todayMark(d);
};
// the coming Friday, a week out when today is Friday
const nextFriday = () => addDays(((5 - new Date().getDay() + 7) % 7) || 7);

// Quick picks + a date input; `onPick(null)` clears the date.
export function DueMenu(
  { current, onPick, onClose }: {
    current: string | null;
    onPick: (due: string | null) => void;
    onClose: () => void;
  },
) {
  const [custom, setCustom] = useState(current ?? "");
  const pick = (v: string | null) => {
    onPick(v);
    onClose();
  };
  const quick: [string, string][] = [
    ["Today", addDays(0)],
    ["Tomorrow", addDays(1)],
    ["Fri", nextFriday()],
    ["+1 week", addDays(7)],
  ];
  return (
    <Popover onClose={onClose} className="!left-auto !right-0 !top-8 w-[240px]">
      <div className="px-2 pb-1 pt-1.5 text-[10.5px] font-medium tracking-[0.6px] text-ink-muted">
        ⚑ DUE DATE
      </div>
      <div className="flex flex-wrap gap-1 px-2 pb-1.5">
        {quick.map(([label, v]) => (
          <button
            key={label}
            type="button"
            title={v}
            onClick={() => pick(v)}
            className={`rounded-md border px-1.5 py-0.5 text-[11.5px] hover:bg-panel ${
              v === current ? "border-copper text-copper" : "border-line text-ink-soft"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <form
        className="flex items-center gap-1.5 px-2 pb-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (custom) pick(custom);
        }}
      >
        <input
          type="date"
          aria-label="Due date"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-line bg-canvas px-1.5 py-0.5 text-[12px] text-ink"
        />
        <button type="submit" disabled={!custom} className="rounded-md px-1.5 py-0.5 text-[12px] text-copper disabled:opacity-40">
          Set
        </button>
      </form>
      {current && (
        <MenuRow dense
          onClick={() => pick(null)}
          className="text-[12px] text-ink-muted hover:text-ink"
        >
          Clear due date
        </MenuRow>
      )}
    </Popover>
  );
}

// late or due within a week, refreshed every 30 s and when the window regains focus
export function useDue(): DueTodo[] {
  const [due, setDue] = useState<DueTodo[]>([]);
  useEffect(() => {
    const load = () =>
      getDue()
        .then((all) => {
          const today = todayMark();
          const next = all.filter((d) => isShownDue(d.due, today));
          setDue((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    addEventListener("focus", load);
    return () => {
      clearInterval(t);
      removeEventListener("focus", load);
    };
  }, []);
  return due;
}

// a DUE row asks for its todo; the editor that renders it scrolls there and rings it
let pendingFocus: string | null = null;
export function focusBlock(id: string) {
  pendingFocus = id;
  dispatchEvent(new Event("trame:focus-block"));
}

// the block of `blocks` to ring now
export function useFocusedBlock(blocks: readonly Block[]): string | null {
  const [hit, setHit] = useState<string | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const go = () => {
      if (!pendingFocus || !blocks.some((b) => "id" in b && b.id === pendingFocus)) return; // another editor's block
      const el = document.querySelector(`[data-block-id="${CSS.escape(pendingFocus)}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setHit(pendingFocus);
      pendingFocus = null;
      clearTimeout(timer);
      timer = setTimeout(() => setHit(null), 1600);
    };
    go();
    addEventListener("trame:focus-block", go);
    return () => {
      removeEventListener("trame:focus-block", go);
      clearTimeout(timer);
    };
  }, [blocks]);
  return hit;
}
