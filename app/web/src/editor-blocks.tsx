import { LinkChip } from "./md-activity";
import { feedMd } from "./md";
import type { ItemLink } from "./md-types";
import { DueMenu } from "./due";
import { CornerToolbar } from "./editor-toolbar";

// collapsed/expanded header of a {{fold}} section
export function FoldHeader(
  { title, open, onToggle, onRename }: {
    title: string;
    open: boolean;
    onToggle: () => void;
    onRename: () => void;
  },
) {
  return (
    <div
      className="my-1 overflow-hidden rounded-lg border border-line-soft"
    >
      <button
        type="button"
        title="double-click to rename"
        className="flex w-full items-center gap-2 bg-panel px-3 py-2 text-left text-[13px] font-medium text-ink transition-colors hover:text-copper"
        onClick={onToggle}
        onDoubleClick={onRename}
      >
        <span className="text-[10px] text-ink-muted">
          {open ? "▾" : "▸"}
        </span>
        {title || "untitled"}
      </button>
    </div>
  );
}

// strip of a {{tab}} group: click selects, drag reorders, double-click renames
export function TabStrip(
  { heads, active, tabDrag, setTabDrag, moveTab, onSelect, onRename }: {
    heads: { i: number; title: string }[];
    active: number;
    tabDrag: number | null;
    setTabDrag: (i: number) => void;
    moveTab: (from: number, to: number) => void;
    onSelect: (ti: number) => void;
    onRename: (i: number) => void;
  },
) {
  return (
    <div
      className="flex gap-1 border-b border-line pb-0 pt-2"
    >
      {heads.map((h, ti) => (
        <button
          key={h.i}
          type="button"
          title="drag to reorder · double-click to rename"
          className={`-mb-px cursor-grab border-b-2 px-3 py-1.5 text-[12.5px] transition-colors ${
            ti === active
              ? "border-copper font-medium text-copper"
              : "border-transparent text-ink-muted hover:text-ink-soft"
          } ${
            // drop indicator: a bar on the side the tab would land on
            tabDrag === null || tabDrag === h.i
              ? ""
              : h.i < tabDrag
              ? "cursor-grabbing hover:shadow-[-2px_0_0_0_#c98a63]"
              : "cursor-grabbing hover:shadow-[2px_0_0_0_#c98a63]"
          }`}
          onMouseDown={(e) => {
            e.preventDefault(); // no text selection while dragging
            setTabDrag(h.i);
          }}
          onMouseUp={() => {
            if (tabDrag === null || tabDrag === h.i) return;
            moveTab(tabDrag, h.i);
            onSelect(ti);
          }}
          onClick={() => onSelect(ti)}
          onDoubleClick={() => onRename(h.i)}
        >
          {h.title || "untitled"}
        </button>
      ))}
    </div>
  );
}

// same visual language as session-report lists: ○ open, ✓ done
export function TodoCheck(
  { done, ringCls, onToggle }: { done: boolean; ringCls: string; onToggle: () => void },
) {
  return (
    <button
      type="button"
      title={done ? "Mark as open" : "Mark as done"}
      onClick={onToggle}
      className="mt-[7px] flex h-3.5 w-3.5 shrink-0 items-center justify-center"
    >
      {done
        ? (
          <span className="text-[12px] leading-none text-active">
            ✓
          </span>
        )
        : (
          <span
            className={`h-3 w-3 rounded-full border-[1.5px] hover:bg-copper/20 ${ringCls}`}
          />
        )}
    </button>
  );
}

// session chips carried by a todo row
export function TodoChips({ chips }: { chips: ItemLink[] }) {
  return chips.map((lk) => (
    <span key={lk.sessionId} className="mt-[3px] shrink-0">
      <LinkChip lk={lk} md={feedMd} />
    </span>
  ));
}

// a todo's corner toolbar (due date, delete) and its due-date picker
export function TodoActions(
  { dueOpen, due, onDue, onRemove, onPickDue, onCloseDue }: {
    dueOpen: boolean;
    due: string | null;
    onDue: () => void;
    onRemove: () => void;
    onPickDue: (due: string | null) => void;
    onCloseDue: () => void;
  },
) {
  return (
    <>
      <CornerToolbar
        actions={[
          // clicking the text edits, so the second slot is the due date
          {
            icon: "flag",
            title: "Due date",
            onClick: onDue,
          },
          {
            icon: "delete",
            title: "Delete",
            danger: true,
            onClick: onRemove,
          },
        ]}
      />
      {dueOpen && (
        <DueMenu
          current={due}
          onPick={onPickDue}
          onClose={onCloseDue}
        />
      )}
    </>
  );
}
