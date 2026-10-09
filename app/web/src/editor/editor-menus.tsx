import type { PageComment } from "../api";
import { IconButton, Popover } from "../ui/ui";
import type { PILLS, SLASH } from "./editor-text";
import { type CommentOps, AddNote, answeredIn, anchorQuoteOf, CommentItem, RowNote } from "../page/comments";

// "/" block-type menu under a text block
export function SlashMenu(
  { items, menuSel, setMenuSel, onPick, onClose }: {
    items: typeof SLASH;
    menuSel: number;
    setMenuSel: (si: number) => void;
    onPick: (key: string) => void;
    onClose: () => void;
  },
) {
  return (
    <Popover
      onClose={onClose}
      className="!top-8 w-[240px]"
    >
      {items.map((s, si) => (
        <button
          type="button"
          key={s.key}
          className={`flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left ${
            si === Math.min(menuSel, items.length - 1)
              ? "bg-panel"
              : "hover:bg-panel"
          }`}
          onMouseMove={() => setMenuSel(si)}
          onClick={() => onPick(s.key)}
        >
          <span className="text-xs font-medium text-ink">
            {s.label}
          </span>
          <span className="text-[10.5px] text-ink-muted">
            {s.hint}
          </span>
        </button>
      ))}
    </Popover>
  );
}

// "{{" color-pill autocomplete, anchored under the "{{"
export function PillMenu(
  { items, pillSel, setPillSel, x, y, onPick, onClose }: {
    items: typeof PILLS;
    pillSel: number;
    setPillSel: (si: number) => void;
    x: number;
    y: number;
    onPick: (color: string) => void;
    onClose: () => void;
  },
) {
  return (
    <Popover
      onClose={onClose}
      className="w-[200px]"
      // anchored under the "{{" — inline left/top override left-0/top-full
      style={{ left: x, top: y }}
    >
      {items.map((p, si) => (
        <button
          type="button"
          key={p.key}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${
            si === Math.min(pillSel, items.length - 1)
              ? "bg-panel"
              : "hover:bg-panel"
          }`}
          onMouseMove={() => setPillSel(si)}
          onClick={() => onPick(p.key)}
        >
          <span
            className={`h-2.5 w-2.5 shrink-0 rounded-full ${p.dot}`}
          />
          <span className="text-xs font-medium text-ink">
            {p.key}
          </span>
          <span className="text-[10.5px] text-ink-muted">
            {p.hint}
          </span>
        </button>
      ))}
    </Popover>
  );
}

// composer for a comment picked in place (table row or text selection)
export function PendingNote(
  { anchor, isTable, onCancel, onAdd }: {
    anchor: string;
    isTable: boolean;
    onCancel: () => void;
    onAdd: (body: string) => void;
  },
) {
  return (
    <div className="my-1 ml-6 flex max-w-[480px] flex-col gap-1.5 rounded-md border border-copper/40 bg-panel p-2">
      <div className="flex items-start justify-between gap-2 text-[10.5px] text-ink-muted">
        <span className="min-w-0 truncate">
          {isTable ? "on row" : "on"}: “{anchor}”
        </span>
        <IconButton className="shrink-0 hover:text-ink" onClick={onCancel}>
          ×
        </IconButton>
      </div>
      <AddNote
        autoFocus
        onAdd={onAdd}
      />
    </div>
  );
}

// a block's expanded inline comment thread
export function InlineThread(
  { text, visibleComments, blockComments, meId, ops, autoFocus, onAdd }: {
    text: string;
    visibleComments: PageComment[];
    blockComments: PageComment[];
    meId: string | null;
    ops: CommentOps;
    autoFocus: boolean;
    onAdd: (body: string) => void;
  },
) {
  return (
    <div className="my-1 ml-6 flex max-w-[480px] flex-col gap-1.5 border-l-2 border-copper/40 pl-3">
      {visibleComments.map((c) => {
        const q = anchorQuoteOf(c, text);
        return (
          <div key={c.id} className="flex flex-col gap-1">
            {q && <RowNote label={q.label} text={q.text} />}
            <CommentItem
              c={c}
              canEdit={Boolean(meId) && c.author_id === meId}
              answered={answeredIn(c, blockComments)}
              onUpdate={(patch) => ops.update(c.id, patch)}
              onDelete={() => ops.remove(c.id)}
            />
          </div>
        );
      })}
      <AddNote
        autoFocus={autoFocus}
        onAdd={onAdd}
      />
    </div>
  );
}
