import type { Dispatch, MutableRefObject, ReactNode, SetStateAction } from "react";
import { type Block, openInBrowser, type PageComment, type SessionLink, uploadAsset } from "../api";
import { clearSelection } from "../ui/ui";
import { Markdown } from "../md/md";
import type { ItemLink } from "../md/md-types";
import { normalizeMarks, setMark, stripMarks, todayMark, touchTodo } from "../../../../core/todo-marks.ts";
import { TodoDueCtx } from "../ui/due";
import { caretXY, type InlineKind, isText, PILLS, SLASH, type TextBlock } from "./editor-text";
import { CornerToolbar, FormatBar } from "./editor-toolbar";

// React rewrites node.defaultValue on every render of a controlled textarea, which
// mutates its text child and resets the browser's undo grouping — Ctrl+Z then crawls
// back one character per press. While the field is focused, report the live value so
// React's `defaultValue !== value` guard skips the write; unfocused it behaves
// normally, so the text child re-syncs on the render that follows a blur.
const defaultValueProp = Object.getOwnPropertyDescriptor(
  HTMLTextAreaElement.prototype,
  "defaultValue",
)!;
const keepNativeUndo = (el: HTMLTextAreaElement) => {
  if (Object.getOwnPropertyDescriptor(el, "defaultValue")) return;
  Object.defineProperty(el, "defaultValue", {
    get: () =>
      document.activeElement === el
        ? el.value
        : defaultValueProp.get!.call(el) as string,
    set: (v: string) => defaultValueProp.set!.call(el, v),
    configurable: true,
  });
};

// open "{{" pill autocomplete: block index, offset of the partial color, its
// text, and the popup anchor under the "{{" (px, relative to the block row)
export type PillState = { i: number; start: number; query: string; x: number; y: number };
// non-collapsed selection inside a block textarea → floating format toolbar
// (px anchor is relative to the block row, like the pill menu)
export type SelState = { i: number; start: number; end: number; x: number; y: number };
export type ListVariant = "done" | "open" | undefined;

// BlockEditor state and callbacks shared by every text block row
export type TextCtx = {
  blocks: Block[];
  refs: MutableRefObject<(HTMLTextAreaElement | null)[]>;
  editStart: MutableRefObject<string | null>;
  menuIdx: number | null;
  menuSel: number;
  pill: PillState | null;
  pillSel: number;
  autoItem: { id: string; item: string } | null;
  links?: SessionLink[];
  onLinkItem?: (blockId: string, item: string) => void;
  chipsFor: (ls: SessionLink[]) => ItemLink[];
  set: (i: number, patch: Partial<TextBlock>) => void;
  remove: (i: number) => void;
  move: (i: number, dir: -1 | 1) => void;
  insertAt: (at: number, indent?: number) => void;
  insertAfter: (i: number) => void;
  grow: (el: HTMLTextAreaElement) => void;
  syncSel: (i: number, el: HTMLTextAreaElement) => void;
  applyInline: (i: number, kind: InlineKind) => void;
  applyLink: (i: number) => void;
  commentSel: (i: number) => void;
  pick: (i: number, key: string) => void;
  pickPill: (color: string) => void;
  replaceImage: (i: number) => void;
  markDone: (i: number, item: string) => void;
  markOpen: (i: number, item: string) => void;
  editItem: (i: number, item: string, next: string) => void;
  splitItem: (i: number, item: string, before: string, after: string) => void;
  setFocusIdx: Dispatch<SetStateAction<number | null>>;
  setActiveId: Dispatch<SetStateAction<string | null>>;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  setDueIdx: Dispatch<SetStateAction<number | null>>;
  setMenuIdx: Dispatch<SetStateAction<number | null>>;
  setMenuSel: Dispatch<SetStateAction<number>>;
  setPill: Dispatch<SetStateAction<PillState | null>>;
  setPillSel: Dispatch<SetStateAction<number>>;
  setSel: Dispatch<SetStateAction<SelState | null>>;
  setPendingNote: Dispatch<SetStateAction<{ id: string; anchor: string } | null>>;
};

// how a text block renders and edits, decided by its markdown
export type BlockShape = { isSnippet: boolean; isImage: boolean; isTable: boolean; isList: boolean };

export function blockShape(b: TextBlock): BlockShape {
  return {
    // fenced-code blocks keep their snippet look while editing (see md.tsx <pre>)
    isSnippet: b.type === "text" && /^\s*```/.test(b.text),
    // image-only blocks keep the picture visible; the markdown edits below it
    isImage: b.type === "text" && /^\s*!\[[^\]]*\]\([^)\s]+\)\s*$/.test(b.text),
    // pipe-table blocks select on click (like images) — raw markdown via ✏️ only
    isTable: b.type === "text" && /^\s*\|.*\|/.test(b.text),
    // all-bullet blocks edit line by line (md.tsx EditableItem), keeping the
    // list rendered — raw markdown via ✏️ only
    isList: b.type === "text" && /\S/.test(b.text) &&
      b.text.split("\n").filter((l) => l.trim()).every((l) => /^\s*([-*+]|\d+\.)\s+/.test(l)),
  };
}

// session-report lists: the nearest heading above decides how bullets render
// (Completed → green checks, Open/Next → copper rings; see md.tsx ListVariant)
export function listVariantAt(blocks: Block[], i: number): ListVariant {
  for (let j = i - 1; j >= 0; j--) {
    const pb = blocks[j];
    if (pb.type !== "heading") continue;
    return /^\s*(completed|done|shipped)\b/i.test(pb.text)
      ? "done"
      : /^\s*(open|todo|next|pending|remaining|in progress|blocked)\b/i.test(pb.text)
      ? "open"
      : undefined;
  }
  return undefined;
}

export const textClsOf = (b: TextBlock) =>
  b.type === "heading"
    ? "text-[16px] font-semibold text-ink"
    : `text-[13px] leading-relaxed ${b.type === "todo" && b.done ? "text-ink-muted line-through" : "text-ink-soft"}`;

// slash-menu items matching a "/…" block
export function slashItems(b: TextBlock) {
  const filter = b.text.startsWith("/") ? b.text.slice(1).toLowerCase() : null;
  return filter === null ? [] : SLASH.filter((s) =>
    // match the key too: "/todo" must find "To-do" despite the hyphen
    s.key.includes(filter) || s.label.toLowerCase().includes(filter)
  );
}

export const pillItemsFor = (pill: PillState | null, i: number) =>
  pill?.i === i ? PILLS.filter((p) => p.key.startsWith(pill.query.toLowerCase())) : [];

// rendered markdown of a text block; click edits, images/tables/snippets select
export function BlockRendered(
  { ctx, b, i, shape, editing, textCls, listVariant, visibleComments, children }: {
    ctx: TextCtx;
    b: TextBlock;
    i: number;
    shape: BlockShape;
    editing: boolean;
    textCls: string;
    listVariant: ListVariant;
    visibleComments: PageComment[];
    children?: ReactNode;
  },
) {
  const { isSnippet, isImage, isTable, isList } = shape;
  return (
    <div
      // kept mounted (not conditionally excluded) so the sibling textarea below
      // never shifts position and gets remounted, which would drop its ref/focus
      style={editing && !isImage ? { display: "none" } : undefined}
      title={isList
        ? "Click a line to edit it — ✏️ for raw markdown (export)"
        : isTable
        ? "Double-click a cell to edit — ✏️ for raw markdown (export)"
        : isSnippet
        ? "Click selects — double-click or ✏️ to edit"
        : isImage
        ? "Click selects the block — edit its markdown via ✏️"
        : undefined}
      className={`w-full py-1 ${
        isImage || isTable || isSnippet
          ? "cursor-default"
          : "cursor-text"
      } ${textCls}`}
      // a drag-selection also fires click on mouseup; only a plain click edits
      onClick={(e) => {
        if (document.getSelection()?.isCollapsed === false) return;
        // an inline image inside a text block selects instead of opening
        // the raw markdown; clicks on the surrounding text still edit
        const onImg = (e.target as HTMLElement).tagName === "IMG";
        if (isImage || isTable || isSnippet || onImg) {
          return ctx.setSelectedId(b.id ?? String(i));
        }
        if (isList) {
          // click anywhere on a line (or past the list) edits that line;
          // outside any item, continue on the last one
          const li = (e.target as HTMLElement).closest("li");
          const spans = (li ?? e.currentTarget)
            .querySelectorAll<HTMLElement>("[data-item-edit]");
          const hit = spans[spans.length - 1];
          if (hit) return hit.click();
        }
        ctx.setFocusIdx(i);
      }}
      onDoubleClick={() => {
        if (isSnippet) {
          clearSelection();
          ctx.setSelectedId(null);
          ctx.setFocusIdx(i);
        }
      }}
      onMouseDown={(e) => {
        // keep the document-level clear from racing this row's select
        if (
          isImage || isTable || isSnippet ||
          (e.target as HTMLElement).tagName === "IMG"
        ) e.stopPropagation();
      }}
    >
      <TodoDueCtx.Provider
        value={b.type === "todo" ? { done: !!b.done, onDue: () => ctx.setDueIdx(i) } : { done: false }}
      >
        <Markdown
          text={b.type === "todo" && !b.done && !b.text.includes("{{trame:due=")
            ? `${b.text} {{trame:due=}}` // placeholder: DuePill's hover "⚑ due"
            : b.text}
          listVariant={listVariant}
          onEdit={isTable ? (next) => ctx.set(i, { text: next }) : undefined}
          onCommentRow={isTable && b.id
            ? (anchor) => ctx.setPendingNote({ id: b.id as string, anchor })
            : undefined}
          rowComments={isTable && b.id
            ? (anchor) => visibleComments.filter((c) => c.anchor === anchor).length
            : undefined}
          onMarkDone={listVariant === "open" ? (item) => ctx.markDone(i, item) : undefined}
          onMarkOpen={listVariant === "done" ? (item) => ctx.markOpen(i, item) : undefined}
          onEditItem={(item, next) => ctx.editItem(i, item, next)}
          onSplitItem={(item, before, after) => ctx.splitItem(i, item, before, after)}
          autoEditItem={ctx.autoItem && ctx.autoItem.id === b.id ? ctx.autoItem.item : undefined}
          getItemLinks={(item) =>
            ctx.chipsFor(
              ctx.links?.filter((x) => x.block_id === b.id && x.anchor === item) ?? [],
            )}
          onLinkItem={b.id && ctx.onLinkItem
            ? (item) => ctx.onLinkItem!(b.id as string, item)
            : undefined}
        />
      </TodoDueCtx.Provider>
      {children}
    </div>
  );
}

// raw-markdown editor of a text block; offscreen (still focusable) while rendered
export function BlockTextarea(
  { ctx, b, i, shape, editing, textCls }: {
    ctx: TextCtx;
    b: TextBlock;
    i: number;
    shape: BlockShape;
    editing: boolean;
    textCls: string;
  },
) {
  const { blocks, refs, editStart, set, grow, menuIdx, menuSel, pill, pillSel } = ctx;
  const { isSnippet, isImage, isTable } = shape;
  const bid = b.id ?? String(i);
  const items = slashItems(b);
  const pillItems = pillItemsFor(pill, i);
  const editCls = isSnippet
    ? "my-1 rounded-md bg-panel px-2 font-mono text-[12px] leading-relaxed text-ink-soft"
    : isImage
    ? "rounded-md bg-panel px-2 font-mono text-[11px] leading-relaxed text-ink-muted"
    : isTable
    ? "my-1 rounded-md bg-panel px-2 font-mono text-[11.5px] leading-relaxed text-ink-soft"
    : `bg-transparent ${textCls}`;
  return (
    <textarea
      ref={(el) => {
        refs.current[i] = el;
        if (el) {
          keepNativeUndo(el);
          grow(el);
        }
      }}
      rows={1}
      value={b.text}
      placeholder={i === 0 && blocks.length === 1
        ? "Write something, or type / for blocks…"
        : ""}
      style={editing ? undefined : {
        position: "absolute",
        width: 1,
        height: 1,
        overflow: "hidden",
        opacity: 0,
        pointerEvents: "none",
      }}
      className={`w-full resize-none overflow-hidden border-none py-1 outline-none placeholder:text-ink-muted/40 ${editCls}`}
      onFocus={() => {
        ctx.setActiveId(bid);
        editStart.current = stripMarks(b.text);
      }}
      onBlur={() => {
        ctx.setActiveId((cur) => (cur === bid ? null : cur));
        ctx.setSel((cur) => (cur && cur.i === i ? null : cur));
        // on blur, not on keystroke: appending mid-typing would move the caret
        if (b.type === "todo" && stripMarks(b.text).trim()) {
          const was = editStart.current;
          let text = setMark(b.text, "created_at", todayMark());
          if (was !== null && was !== stripMarks(b.text)) {
            text = touchTodo(text, todayMark());
          }
          text = normalizeMarks(text);
          if (text !== b.text) set(i, { text });
        }
        editStart.current = null;
      }}
      onSelect={(e) => ctx.syncSel(i, e.currentTarget)}
      onChange={(e) => {
        set(i, { text: e.target.value });
        grow(e.target);
        ctx.setMenuIdx(e.target.value.startsWith("/") ? i : null);
        ctx.setMenuSel(0);
        // caret sitting right after "{{" (plus a partial color) opens the pill menu
        const m = e.target.value
          .slice(0, e.target.selectionStart)
          .match(/\{\{([a-zA-Z]*)$/);
        if (m) {
          const el = e.target;
          const p = caretXY(el, el.selectionStart - m[0].length);
          ctx.setPill({
            i,
            start: el.selectionStart - m[1].length,
            query: m[1],
            x: Math.max(
              0,
              Math.min(
                el.offsetLeft + p.x,
                el.offsetLeft + el.clientWidth - 210,
              ),
            ),
            y: el.offsetTop + p.y,
          });
        } else ctx.setPill(null);
        ctx.setPillSel(0);
      }}
      onPaste={(e) => {
        const files = [...(e.clipboardData?.files ?? [])]
          .filter((f) => f.type.startsWith("image/"));
        if (!files.length) return;
        e.preventDefault();
        const before = b.text.slice(
          0,
          e.currentTarget.selectionStart,
        );
        const after = b.text.slice(e.currentTarget.selectionEnd);
        Promise.all(files.map((f) => uploadAsset(f))).then((rs) => {
          const md = rs
            .filter((r) => r.id)
            .map((r) => `![image](/api/assets/${r.id})`)
            .join("\n");
          if (md) set(i, { text: `${before}${md}${after}` });
        });
      }}
      onKeyDown={(e) => {
        // formatting shortcuts wrap/unwrap the selection in markdown
        if ((e.ctrlKey || e.metaKey) && !e.altKey) {
          const k = e.key.toLowerCase();
          const kind = k === "b"
            ? "bold"
            : k === "i"
            ? "italic"
            : k === "e"
            ? "code"
            : k === "s" && e.shiftKey
            ? "strike"
            : null;
          if (kind) {
            e.preventDefault();
            return ctx.applyInline(i, kind);
          }
          if (k === "k") {
            e.preventDefault();
            return ctx.applyLink(i);
          }
        }
        if (menuIdx === i && items.length) {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            return ctx.setMenuSel((s) => (s + 1) % items.length);
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            return ctx.setMenuSel((s) => (s - 1 + items.length) % items.length);
          }
          if (e.key === "Enter") {
            e.preventDefault();
            return ctx.pick(i, items[Math.min(menuSel, items.length - 1)].key);
          }
          if (e.key === "Escape") {
            e.preventDefault();
            return ctx.setMenuIdx(null);
          }
        }
        if (pill?.i === i && pillItems.length) {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            return ctx.setPillSel((s) => (s + 1) % pillItems.length);
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            return ctx.setPillSel((s) => (s - 1 + pillItems.length) % pillItems.length);
          }
          if (e.key === "Enter") {
            e.preventDefault();
            return ctx.pickPill(pillItems[Math.min(pillSel, pillItems.length - 1)].key);
          }
          if (e.key === "Escape") {
            e.preventDefault();
            return ctx.setPill(null);
          }
        }
        // inside a snippet Enter stays a newline; a closed fence + caret
        // at the end exits to a new block, and arrows move within the code
        const el = e.currentTarget;
        const atEnd = el.selectionStart === b.text.length &&
          el.selectionEnd === b.text.length;
        const snippetDone = isSnippet && /\n\s*```\s*$/.test(b.text);
        if (e.key === "Enter" && !e.shiftKey) {
          if (isSnippet && !(snippetDone && atEnd)) return;
          e.preventDefault();
          if (el.selectionStart === 0 && el.selectionEnd === 0 && b.text) {
            ctx.insertAt(i, b.indent ?? 0);
          } else ctx.insertAfter(i);
        } else if (
          e.key === "Backspace" && b.text === "" && blocks.length > 1
        ) {
          e.preventDefault();
          ctx.remove(i);
        } else if (
          e.key === "Tab" && !isSnippet && b.type !== "heading"
        ) {
          // Tab / Shift+Tab nest the block under the one above
          e.preventDefault();
          const lvl = b.indent ?? 0;
          if (e.shiftKey) {
            if (lvl > 0) set(i, { indent: lvl - 1 });
          } else {
            const prev = blocks.slice(0, i).filter(isText).at(-1);
            const max = Math.min(
              4,
              prev ? (prev.indent ?? 0) + 1 : 0,
            );
            if (lvl < max) set(i, { indent: lvl + 1 });
          }
        } else if (e.key === "ArrowUp" && e.altKey) {
          e.preventDefault();
          ctx.move(i, -1);
        } else if (e.key === "ArrowDown" && e.altKey) {
          e.preventDefault();
          ctx.move(i, 1);
        } else if (e.key === "ArrowUp" && !e.shiftKey && i > 0) {
          if (isSnippet && el.selectionStart > 0) return;
          e.preventDefault();
          ctx.setFocusIdx(i - 1);
        } else if (
          e.key === "ArrowDown" && !e.shiftKey &&
          i < blocks.length - 1
        ) {
          if (isSnippet && !atEnd) return;
          e.preventDefault();
          ctx.setFocusIdx(i + 1);
        }
      }}
    />
  );
}

// floating format toolbar over a textarea selection
export function SelectionBar({ ctx, b, i, sel }: { ctx: TextCtx; b: TextBlock; i: number; sel: SelState }) {
  return (
    <FormatBar
      style={{
        left: sel.x,
        top: sel.y - 6,
        transform: "translateY(-100%)",
      }}
      actions={[
        {
          label: "B",
          title: "Bold (Ctrl+B)",
          cls: "font-bold",
          onClick: () => ctx.applyInline(i, "bold"),
        },
        {
          label: "I",
          title: "Italic (Ctrl+I)",
          cls: "italic",
          onClick: () => ctx.applyInline(i, "italic"),
        },
        {
          label: "S",
          title: "Strikethrough (Ctrl+Shift+S)",
          cls: "line-through",
          onClick: () => ctx.applyInline(i, "strike"),
        },
        {
          label: "</>",
          title: "Code (Ctrl+E)",
          cls: "font-mono !text-[10.5px]",
          onClick: () => ctx.applyInline(i, "code"),
        },
        {
          label: "🔗",
          title: "Link (Ctrl+K)",
          cls: "!text-[10.5px]",
          onClick: () => ctx.applyLink(i),
        },
        ...(b.id
          ? [{
            label: "💬",
            title: "Comment on selection",
            cls: "!text-[10.5px]",
            onClick: () => ctx.commentSel(i),
          }]
          : []),
      ]}
    />
  );
}

// hover toolbars of snippet, image, table and list blocks
export function BlockCorners({ ctx, b, i, shape }: { ctx: TextCtx; b: TextBlock; i: number; shape: BlockShape }) {
  const { isSnippet, isImage, isTable, isList } = shape;
  const del = { icon: "delete", title: "Delete", danger: true, onClick: () => ctx.remove(i) } as const;
  return (
    <>
      {isSnippet && (
        <CornerToolbar
          chip={b.text.match(/^\s*```\s*([\w+#-]*)/)?.[1] ?? ""}
          onChip={(l) =>
            ctx.set(i, {
              text: b.text.replace(
                /^(\s*```)[^\n]*/,
                `$1${l === "plain" ? "" : l}`,
              ),
            })}
          actions={[
            {
              icon: "copy",
              title: "Copy code",
              onClick: () =>
                navigator.clipboard?.writeText(
                  b.text
                    .replace(/^\s*```[^\n]*\n?/, "")
                    .replace(/\n?\s*```\s*$/, ""),
                ),
            },
            { icon: "edit", title: "Edit", onClick: () => ctx.setFocusIdx(i) },
            del,
          ]}
        />
      )}
      {isImage && (
        <CornerToolbar
          actions={[
            {
              icon: "open",
              title: "Open full size",
              onClick: () => {
                const url = b.text.match(/\(([^)\s]+)\)\s*$/)?.[1];
                // the desktop webview has no window.open — route via /api/open
                if (url) openInBrowser(url);
              },
            },
            { icon: "replace", title: "Replace image", onClick: () => ctx.replaceImage(i) },
            { icon: "edit", title: "Edit alt / URL", onClick: () => ctx.setFocusIdx(i) },
            del,
          ]}
        />
      )}
      {(isTable || isList) && (
        <CornerToolbar
          actions={[
            { icon: "edit", title: "Raw markdown (edit / export)", onClick: () => ctx.setFocusIdx(i) },
            del,
          ]}
        />
      )}
    </>
  );
}
