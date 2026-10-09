import type { ReactNode } from "react";
import type { Block } from "../api";
import { stripMarks } from "../../../../core/todo-marks.ts";
import { isText, type TextBlock } from "./editor-text";
import { FoldHeader, TabStrip } from "./editor-blocks";
import { FolderBlock } from "./FolderBlock";
import { HtmlBlock } from "./HtmlBlock";

export type SectionMeta = {
  heads: Map<number, { i: number; title: string }[]>;
  of: Map<number, { kind: "tab" | "fold"; group: number; tab: number }>;
};

// "{{tab}}" / "{{fold}}" headings group the blocks below them: a tab runs to the next
// marked heading (consecutive tabs form one strip), a fold is a standalone accordion
export function sectionMeta(blocks: Block[]): SectionMeta {
  let group: number | null = null;
  let foldAt: number | null = null;
  const heads = new Map<number, { i: number; title: string }[]>();
  const of = new Map<
    number,
    { kind: "tab" | "fold"; group: number; tab: number }
  >();
  blocks.forEach((b, i) => {
    const m = isText(b) && b.type === "heading" &&
      b.text.match(/\{\{(tab|fold)\}\}/i);
    if (m && m[1].toLowerCase() === "tab") {
      foldAt = null;
      if (group === null) {
        group = i;
        heads.set(i, []);
      }
      heads.get(group)!.push({
        i,
        title: stripMarks((b as TextBlock).text)
          .replace(/\s*\{\{tab\}\}\s*/i, " ").trim(),
      });
      of.set(i, { kind: "tab", group, tab: heads.get(group)!.length - 1 });
    } else if (m) {
      group = null;
      foldAt = i;
      of.set(i, { kind: "fold", group: i, tab: 0 });
    } else if (group !== null) {
      of.set(i, { kind: "tab", group, tab: heads.get(group)!.length - 1 });
    } else if (foldAt !== null) {
      of.set(i, { kind: "fold", group: foldAt, tab: 0 });
    }
  });
  return { heads, of };
}

export type SectionCtx = {
  blocks: Block[];
  tabMeta: SectionMeta;
  openFolds: Record<string, boolean>;
  setOpenFolds: (f: (m: Record<string, boolean>) => Record<string, boolean>) => void;
  activeTabs: Record<string, number>;
  setActiveTabs: (f: (m: Record<string, number>) => Record<string, number>) => void;
  focusIdx: number | null;
  activeId: string | null;
  setFocusIdx: (i: number) => void;
  tabDrag: number | null;
  setTabDrag: (i: number) => void;
  moveTab: (from: number, to: number) => void;
};

// a block's section rendering: the strip/accordion control, null when hidden, undefined to render it normally
export function renderSection(ctx: SectionCtx, b: Block, i: number): ReactNode | null | undefined {
  const { blocks, tabMeta, openFolds, setOpenFolds, activeTabs, setActiveTabs, focusIdx, activeId, setFocusIdx, tabDrag, setTabDrag, moveTab } = ctx;
  const tm = tabMeta.of.get(i);
  if (tm) {
    const gb = blocks[tm.group];
    const gid = (isText(gb) && gb.id) || String(tm.group);
    const bid0 = ("id" in b && b.id) || String(i);
    if (tm.kind === "fold") {
      const open = openFolds[gid] ?? false;
      const isHead = i === tm.group;
      // a heading being renamed renders as its normal editable row
      const renaming = isHead && (focusIdx === i || activeId === bid0);
      if (isHead && !renaming) {
        const title = stripMarks((b as TextBlock).text)
          .replace(/\s*\{\{fold\}\}\s*/i, " ").trim();
        return (
          <FoldHeader
            key={bid0}
            title={title}
            open={open}
            onToggle={() =>
              setOpenFolds((m) => ({ ...m, [gid]: !open }))}
            onRename={() => setFocusIdx(i)}
          />
        );
      }
      if (!isHead && !open) return null;
    } else {
      const active = activeTabs[gid] ?? 0;
      const heads = tabMeta.heads.get(tm.group)!;
      const isHead = heads.some((h) => h.i === i);
      // a tab heading being renamed renders as its normal editable row
      const renaming = isHead && (focusIdx === i || activeId === bid0);
      if (isHead && !renaming) {
        if (i !== tm.group) return null;
        return (
          <TabStrip
            key={bid0}
            heads={heads}
            active={active}
            tabDrag={tabDrag}
            setTabDrag={setTabDrag}
            moveTab={moveTab}
            onSelect={(ti) => setActiveTabs((m) => ({ ...m, [gid]: ti }))}
            onRename={setFocusIdx}
          />
        );
      }
      if (!isHead && tm.tab !== active) return null;
    }
  }
  return undefined;
}

// a folder or html block: self-contained components with their own chrome
export function EmbedBlock({ block, onPatch, onRemove, onOpenReport }: {
  block: Extract<Block, { type: "folder" | "html" }>;
  onPatch: (patch: Partial<Block>) => void;
  onRemove: () => void;
  onOpenReport: (path: string) => void;
}) {
  return block.type === "folder"
    ? <FolderBlock block={block} onPatch={onPatch} onRemove={onRemove} onOpenReport={onOpenReport} />
    : <HtmlBlock block={block} onPatch={onPatch} onRemove={onRemove} />;
}

// a text block row's classes: comment tint, flash ring, selection contour, drop target, live agent
export function rowCls({ hasOpen, flashed, selected, isTable, isSnippet, drop, live }: {
  hasOpen: boolean;
  flashed: boolean;
  selected: boolean;
  isTable: boolean;
  isSnippet: boolean;
  drop: string;
  live: string;
}) {
  return `group relative -ml-6 -mr-1 flex items-start gap-2 pl-6 pr-1 ${hasOpen ? "rounded-md bg-copper/[0.05]" : ""} ${
    flashed ? "rounded-md ring-1 ring-copper/50" : ""
  } ${
    selected
      // tables/snippets: color the card's own contour — no ring
      // floating around the block gutter with a gap
      ? isTable
        ? "[&_.md-table-card]:border-copper/70 [&_.md-table-card]:ring-1 [&_.md-table-card]:ring-copper/50"
        : isSnippet
        ? "[&_.md-snippet-card]:ring-1 [&_.md-snippet-card]:ring-copper/60"
        : "rounded-md ring-2 ring-copper/60"
      : ""
  } ${drop} ${live}`;
}
