import { type ReactNode, useEffect, useState } from "react";
import type { Block } from "../api";
import { isText } from "./editor-text";

// a block row wider than the text column, centred on it (wide graphs, tables, databases)
export const spanStyle = (w: string) => ({ width: w, marginLeft: `calc((100% - ${w}) / 2)` });

export function useBlockDrag(
  blocks: Block[],
  snapshot: () => void,
  onChange: (next: Block[]) => void,
) {
  // mouse reordering: ⋮⋮ handle on hover, drop on a row to move the block there.
  // Pointer events, NOT html5 dnd — WebKitGTK (the desktop webview) drops dragstart.
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [tabDrag, setTabDrag] = useState<number | null>(null); // heading block being dragged along its strip
  // a block dragged in from outside the editor (a database listed at the page end):
  // dragIdx is -1 while it moves, and it lands below the row it is dropped on
  const [inserting, setInserting] = useState<Block | null>(null);
  const startInsert = (b: Block) => {
    setInserting(b);
    setDragIdx(-1);
  };
  const moveTo = (from: number, to: number) => {
    if (from === to) return;
    // a heading drags its whole section (every block up to the next heading)
    const head = blocks[from];
    let len = 1;
    if (isText(head) && head.type === "heading") {
      while (
        from + len < blocks.length &&
        !(isText(blocks[from + len]) && blocks[from + len].type === "heading")
      ) len++;
    }
    if (to > from && to < from + len) return; // dropped inside its own section
    snapshot();
    const next = [...blocks];
    const moved = next.splice(from, len);
    next.splice(to > from ? to - len + 1 : to, 0, ...moved);
    onChange(next);
  };
  // fixed width keeps it inside the 24px block gutter (pl-6) — with p-1 the
  // glyph's font-dependent width could overlap the todo checkbox and swallow its clicks
  const dragHandle = (i: number) => (
    <button
      type="button"
      title="Drag to move"
      onMouseDown={(e) => {
        e.preventDefault(); // no text selection while dragging
        setDragIdx(i);
      }}
      // z-20: a card that grows into the margins (wide table, graph) would cover it
      className={`absolute left-0.5 top-[2px] z-20 w-[18px] overflow-hidden py-1 text-center cursor-grab select-none text-[13px] leading-none text-ink-muted hover:text-ink ${
        dragIdx === null ? "hidden group-hover:block group-hover/block:block" : "block"
      }`}
    >
      ⋮⋮
    </button>
  );
  // a bar on the edge the block would land on — moveTo drops it below the row
  // when dragged downwards, above it when dragged up
  const dropClass = (i: number) =>
    dragIdx === i
      ? "opacity-40" // the block being dragged
      : overIdx !== i || dragIdx === null
      ? ""
      : dragIdx < i
      ? "shadow-[0_2px_0_0_#c98a63]"
      : "shadow-[0_-2px_0_0_#c98a63]";
  // handle + drop target for blocks that render no text row of their own;
  // span widens the row past the text column (a database)
  const dragRow = (i: number, child: ReactNode, span?: string) => (
    <div
      // a named group: an embedded database's own group-hover styles must not fire for the whole block
      className={`group/block relative pl-6 ${dropClass(i)}`}
      style={span ? spanStyle(span) : undefined}
      onMouseMove={() => {
        if (dragIdx !== null && overIdx !== i) setOverIdx(i);
      }}
    >
      {dragHandle(i)}
      {child}
    </div>
  );
  useEffect(() => {
    if (dragIdx === null) return;
    const up = () => {
      if (overIdx !== null && dragIdx === -1 && inserting) {
        snapshot();
        onChange([...blocks.slice(0, overIdx + 1), inserting, ...blocks.slice(overIdx + 1)]);
      } else if (overIdx !== null && dragIdx >= 0) moveTo(dragIdx, overIdx);
      setDragIdx(null);
      setOverIdx(null);
      setInserting(null);
    };
    document.addEventListener("mouseup", up);
    return () => document.removeEventListener("mouseup", up);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- the handler re-binds with the drag state
  }, [dragIdx, overIdx, blocks, inserting]);
  useEffect(() => {
    if (tabDrag === null) return;
    const up = () => setTabDrag(null);
    document.addEventListener("mouseup", up);
    return () => document.removeEventListener("mouseup", up);
  }, [tabDrag]);
  return { dragIdx, overIdx, setOverIdx, tabDrag, setTabDrag, dragHandle, dropClass, dragRow, startInsert };
}
