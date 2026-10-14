import type { ReactNode } from "react";
import type { AgentPresenceSettings, PageComment } from "../api";
import { isMetadataMark } from "../plugins";
import { readMarks, removeMark, stripMarks, writeMark } from "../../../../core/todo-marks.ts";
import { type Live, LiveLine, LiveRail, liveRingCls, liveRowCls, LiveTrail, worksOn } from "../agents/agents";
import { CommentGutter, type CommentMode, type CommentOps } from "../page/comments";
import type { TextBlock } from "./editor-text";
import { graphWideOf, graphWidthOf, setGraphWidth } from "../md/graph";
import { TodoActions, TodoCheck, TodoChips } from "./editor-blocks";
import { InlineThread, PendingNote, PillMenu, SlashMenu } from "./editor-menus";
import { rowCls } from "./editor-sections";
import {
  BlockCorners,
  BlockRendered,
  blockShape,
  BlockTextarea,
  listVariantAt,
  pillItemsFor,
  SelectionBar,
  type SelState,
  slashItems,
  type TextCtx,
  textClsOf,
} from "./editor-text-block";

// the per-row state a text block reads beyond the shared TextCtx: comments, selection, drag, live agents
export type RowCtx = {
  comments: PageComment[];
  showResolved: boolean;
  mode: CommentMode;
  openThreads: Set<string>;
  onToggleThread: (blockId: string) => void;
  focusThread: string | null;
  flash: string | null;
  meId: string | null;
  commentOps: CommentOps;
  activeId: string | null;
  focusIdx: number | null;
  selectedId: string | null;
  sel: SelState | null;
  dueIdx: number | null;
  pendingNote: { id: string; anchor: string } | null;
  live: Live[];
  liveCfg: AgentPresenceSettings | null;
  dragIdx: number | null;
  overIdx: number | null;
  setOverIdx: (i: number) => void;
  dragHandle: (i: number) => ReactNode;
  dropClass: (i: number) => string;
  toggleTodo: (i: number) => void;
};

// one text/heading/todo block: its rendered view or textarea, menus, todo extras and comments
export function TextBlockRow({ ctx, row, b, i }: { ctx: TextCtx; row: RowCtx; b: TextBlock; i: number }) {
  const textCtx = ctx;
  const {
    blocks, chipsFor, links, menuIdx, menuSel, pill, pillSel, pick, pickPill, remove, set,
    setDueIdx, setMenuIdx, setMenuSel, setPendingNote, setPill, setPillSel,
  } = ctx;
  const {
    comments, showResolved, mode, openThreads, onToggleThread, focusThread, flash, meId, commentOps,
    activeId, focusIdx, selectedId, sel, dueIdx, pendingNote, live, liveCfg, dragIdx, overIdx, setOverIdx,
    dragHandle, dropClass, toggleTodo,
  } = row;
  const items = slashItems(b);
  const pillItems = pillItemsFor(pill, i);
  const blockComments = b.id
    ? comments.filter((c) => c.block_id === b.id)
    : [];
  const hasOpen = blockComments.some((c) => !c.resolved);
  const visibleComments = showResolved
    ? blockComments
    : blockComments.filter((c) => !c.resolved);
  const inlineOpen = mode === "inline" && Boolean(b.id) &&
    openThreads.has(b.id as string);
  const bid = b.id ?? String(i);
  // empty/new/mid-navigation blocks always stay in raw-text edit mode
  const editing = activeId === bid || (!stripMarks(b.text).trim() && !Object.keys(readMarks(b.text)).some(isMetadataMark)) ||
    focusIdx === i;
  const textCls = textClsOf(b);
  const shape = blockShape(b);
  const { isSnippet, isTable } = shape;
  // a `wide` or dragged-wider graph breaks the whole row out of the text column, so
  // its handle, outline and toolbar move with it; margins, not a transform, keep
  // popovers anchored
  const isGraph = isSnippet && /^\s*```\s*graph\b/.test(b.text);
  const px = isGraph ? graphWidthOf(b.text) : undefined;
  const span = isGraph && graphWideOf(b.text)
    ? "min(1400px, 100cqw - 4rem)"
    : px
    ? `min(${px}px, 100cqw - 4rem)`
    : null;
  const spanStyle = (w: string) => ({ width: w, marginLeft: `calc((100% - ${w}) / 2)` });
  // right-edge drag, as on HTML blocks: grows both ways, saved as a `width` line
  const startWidthDrag = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const row = e.currentTarget.parentElement;
    const column = row?.parentElement?.getBoundingClientRect().width;
    if (!row || !column) return;
    const from = { x: e.clientX, w: row.getBoundingClientRect().width };
    let last: number | null = null;
    const move = (ev: MouseEvent) => {
      last = Math.max(from.w + 2 * (ev.clientX - from.x), column);
      Object.assign(row.style, spanStyle(`min(${last}px, 100cqw - 4rem)`));
    };
    const up = () => {
      removeEventListener("mousemove", move);
      removeEventListener("mouseup", up);
      if (last === null) return;
      const w = Math.min(last, row.getBoundingClientRect().width); // what the pane allowed
      // the row's own gutter makes it ~28px wider than the column: within that is "no width"
      set(i, { text: setGraphWidth(b.text, w <= column + 32 ? undefined : w) });
    };
    addEventListener("mousemove", move);
    addEventListener("mouseup", up);
  };
  // the live agent working on this todo, if any
  const lv = b.type === "todo" && !b.done && b.id && liveCfg
    ? live.find((x) => worksOn(x.a, b.id as string))
    : undefined;
  return (
    <>
      <div
        data-block-id={b.id || undefined}
        className={rowCls({
          hasOpen,
          flashed: flash === b.id,
          selected: selectedId === bid,
          isTable,
          isSnippet,
          drop: dropClass(i),
          live: lv && liveCfg ? liveRowCls(lv.state, liveCfg) : "",
        })}
        // nested blocks shift right; overrides the base pl-6 (24px)
        style={{
          ...(b.indent ? { paddingLeft: 24 + b.indent * 20 } : {}),
          ...(span ? spanStyle(span) : {}),
        }}
        onMouseMove={() => {
          if (dragIdx !== null && overIdx !== i) setOverIdx(i);
        }}
      >
        {dragHandle(i)}
        {lv && liveCfg && <LiveRail state={lv.state} cfg={liveCfg} />}
        {b.type === "todo" && (
          <TodoCheck
            done={!!b.done}
            ringCls={(lv && liveCfg && liveRingCls(lv.state, liveCfg)) || "border-copper"}
            onToggle={() => toggleTodo(i)}
          />
        )}
        <BlockRendered
          ctx={textCtx}
          b={b}
          i={i}
          shape={shape}
          editing={editing}
          textCls={textCls}
          listVariant={listVariantAt(blocks, i)}
          visibleComments={visibleComments}
        >
          {lv && liveCfg && (
            // reading the activity line shouldn't open the editor
            <div onClick={(e) => e.stopPropagation()}>
              <LiveLine a={lv.a} state={lv.state} cfg={liveCfg} />
            </div>
          )}
        </BlockRendered>
        <BlockTextarea ctx={textCtx} b={b} i={i} shape={shape} editing={editing} textCls={textCls} />
        {/* a todo is its own block, not a list item — carry its chips here, after
            the textarea so edit mode does not move them left of the task text */}
        {lv && liveCfg && <LiveTrail a={lv.a} state={lv.state} cfg={liveCfg} />}
        {b.type === "todo" && (
          <TodoChips chips={chipsFor(links?.filter((x) => x.block_id === b.id) ?? [])} />
        )}
        {menuIdx === i && items.length > 0 && (
          <SlashMenu
            items={items}
            menuSel={menuSel}
            setMenuSel={setMenuSel}
            onPick={(key) => pick(i, key)}
            onClose={() => setMenuIdx(null)}
          />
        )}
        {pill?.i === i && pillItems.length > 0 && (
          <PillMenu
            items={pillItems}
            pillSel={pillSel}
            setPillSel={setPillSel}
            x={pill.x}
            y={pill.y}
            onPick={pickPill}
            onClose={() => setPill(null)}
          />
        )}
        {sel?.i === i && <SelectionBar ctx={textCtx} b={b} i={i} sel={sel} />}
        <BlockCorners ctx={textCtx} b={b} i={i} shape={shape} />
        {isGraph && !editing && (
          <div
            onMouseDown={startWidthDrag}
            onDoubleClick={() => set(i, { text: setGraphWidth(b.text, undefined) })}
            title="drag to set width, double-click for the text column"
            className="absolute bottom-2 right-0 top-2 z-10 w-[6px] cursor-ew-resize rounded bg-transparent transition-colors hover:bg-copper/30"
          />
        )}
        {b.type === "todo" && (
          <TodoActions
            dueOpen={dueIdx === i}
            due={readMarks(b.text).due ?? null}
            onDue={() => setDueIdx(i)}
            onRemove={() => remove(i)}
            onPickDue={(due) => set(i, { text: due ? writeMark(b.text, "due", due) : removeMark(b.text, "due") })}
            onCloseDue={() => setDueIdx(null)}
          />
        )}
        <div className="absolute -right-7 top-[3px]">
          <CommentGutter
            blockId={b.id ?? ""}
            anchor={b.text}
            comments={blockComments}
            showResolved={showResolved}
            mode={mode}
            inlineOpen={inlineOpen}
            onToggleInline={() => b.id && onToggleThread(b.id)}
            meId={meId}
            ops={commentOps}
          />
        </div>
      </div>
      {pendingNote?.id === bid && (
        <PendingNote
          anchor={pendingNote.anchor}
          isTable={isTable}
          onCancel={() => setPendingNote(null)}
          onAdd={(body) => {
            commentOps.add(bid, pendingNote?.anchor ?? "", body);
            setPendingNote(null);
          }}
        />
      )}
      {inlineOpen && (
        <InlineThread
          text={b.text}
          visibleComments={visibleComments}
          blockComments={blockComments}
          meId={meId}
          ops={commentOps}
          autoFocus={focusThread === b.id}
          onAdd={(body) => commentOps.add(b.id as string, b.text, body)}
        />
      )}
    </>
  );
}
