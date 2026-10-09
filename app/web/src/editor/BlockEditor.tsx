import { Fragment, useEffect, useRef, useState } from "react";
import { type Block, type PageComment, type SessionLink, uploadAsset } from "../api";
import { clearSelection, statusStyle } from "../ui/ui";
import type { ItemLink } from "../md/md-types";
import {
  readMarks,
  removeMark,
  setMark,
  stripMarks,
  todayMark,
  touchTodo,
  writeMark,
} from "../../../../core/todo-marks.ts";
import { LiveLine, LiveRail, liveRingCls, liveRowCls, LiveTrail, useAgents, worksOn } from "../agents/agents";
import { FolderBlock } from "./FolderBlock";
import { isMetadataMark } from "../plugins";
import { HtmlBlock } from "./HtmlBlock";
import { genId } from "../page/page-ids";
import { useBlockDrag } from "./useBlockDrag";
import {
  type TextBlock,
  isText,
  caretXY,
  type InlineKind,
  toggleInline,
  linkify,
} from "./editor-text";
import { FormatBar } from "./editor-toolbar";
import { type CommentOps, type CommentMode, CommentGutter } from "../page/comments";
import { FoldHeader, TabStrip, TodoActions, TodoCheck, TodoChips } from "./editor-blocks";
import { InlineThread, PendingNote, PillMenu, SlashMenu } from "./editor-menus";
import {
  BlockCorners,
  BlockRendered,
  blockShape,
  BlockTextarea,
  listVariantAt,
  type PillState,
  pillItemsFor,
  SelectionBar,
  type SelState,
  slashItems,
  type TextCtx,
  textClsOf,
} from "./editor-text-block";

export function BlockEditor(
  {
    blocks,
    onChange,
    onSlashInsert,
    onOpenReport,
    comments,
    commentOps,
    showResolved,
    mode,
    openThreads,
    focusThread,
    flash,
    meId,
    onToggleThread,
    links,
    onOpenSession,
    onLinkItem,
  }: {
    blocks: Block[];
    onChange: (blocks: Block[]) => void;
    // subpage/database creation is async and owned by the page
    onSlashInsert: (kind: "subpage" | "database", replaceIdx: number) => void;
    onOpenReport: (path: string) => void;
    comments: PageComment[];
    commentOps: CommentOps;
    showResolved: boolean;
    mode: CommentMode;
    openThreads: Set<string>; // block ids with their inline thread expanded
    focusThread: string | null; // thread just opened by a click — its composer grabs focus
    flash: string | null; // block briefly highlighted after a panel jump
    meId: string | null;
    onToggleThread: (blockId: string) => void;
    links?: SessionLink[];
    onOpenSession?: (id: string) => void;
    onLinkItem?: (blockId: string, item: string) => void;
  },
) {
  const refs = useRef<(HTMLTextAreaElement | null)[]>([]);
  const { live, cfg: liveCfg } = useAgents();
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  const [menuIdx, setMenuIdx] = useState<number | null>(null); // block showing the slash menu
  const [dueIdx, setDueIdx] = useState<number | null>(null); // todo showing the due-date picker
  const [menuSel, setMenuSel] = useState(0); // highlighted item in the slash menu
  const [pill, setPill] = useState<PillState | null>(null);
  const [pillSel, setPillSel] = useState(0);
  // block currently in raw-textarea edit mode (Notion-style: click to edit, blur to render)
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sel, setSel] = useState<SelState | null>(null);
  // non-collapsed selection over rendered markdown → fixed-position comment bar
  const [viewSel, setViewSel] = useState<
    { id: string; text: string; x: number; y: number } | null
  >(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // a todo's visible text when it took focus — a blur only counts as an edit if it moved
  const editStart = useRef<string | null>(null);
  // has the focused field taken a keystroke since it got focus? decides who owns
  // Ctrl+Z — the browser's native undo or ours (see the undo stack below)
  const typed = useRef(false);

  // every session linked to a line, as the chips render them (a task can pass
  // through several sessions — showing only the first would hide the others)
  const chipsFor = (ls: SessionLink[]): ItemLink[] =>
    ls.filter((l) => l.session_id).map((l) => ({
      title: l.session_title ?? "session",
      color: statusStyle(l.session_status ?? "active").color,
      sessionId: l.session_id!,
      open: () => onOpenSession?.(l.session_id!),
    }));

  const syncSel = (i: number, el: HTMLTextAreaElement) => {
    const { selectionStart: s, selectionEnd: e } = el;
    if (s === e) return setSel((cur) => (cur && cur.i === i ? null : cur));
    const p = caretXY(el, s);
    setSel({
      i,
      start: s,
      end: e,
      x: Math.max(
        0,
        Math.min(el.offsetLeft + p.x, el.offsetLeft + el.clientWidth - 230),
      ),
      y: el.offsetTop + p.top,
    });
  };
  // Formatting edits mutate the DOM textarea first (value + selection, in one
  // synchronous step) and then sync React state to the same text: the commit
  // sees a matching DOM value and leaves the node alone, so the caret can never
  // be stale — a chained shortcut right after is safe.
  const applyInline = (i: number, kind: InlineKind) => {
    const el = refs.current[i];
    const b = blocks[i];
    if (!el || !isText(b)) return;
    const r = toggleInline(el.value, el.selectionStart, el.selectionEnd, kind);
    el.value = r.text;
    el.setSelectionRange(r.start, r.end);
    grow(el);
    set(i, { text: r.text });
    syncSel(i, el);
  };
  const applyLink = (i: number) => {
    const el = refs.current[i];
    const b = blocks[i];
    if (!el || !isText(b) || el.selectionStart === el.selectionEnd) return;
    const r = linkify(el.value, el.selectionStart, el.selectionEnd);
    el.value = r.text;
    el.setSelectionRange(r.caret, r.caret);
    grow(el);
    set(i, { text: r.text });
    setSel(null);
  };
  // 💬 on an edit-mode selection: open the pending composer with it as anchor
  const commentSel = (i: number) => {
    const el = refs.current[i];
    const b = blocks[i];
    if (!el || !isText(b) || !b.id) return;
    const anchor = b.text.slice(el.selectionStart, el.selectionEnd).trim();
    if (anchor) setPendingNote({ id: b.id, anchor: anchor.slice(0, 300) });
    setSel(null);
  };

  // selection over rendered markdown (no textarea focused) → comment bar above it
  useEffect(() => {
    const sync = () => {
      const s = document.getSelection();
      if (!s || s.isCollapsed || s.rangeCount === 0) return setViewSel(null);
      if (document.activeElement?.tagName === "TEXTAREA") return; // edit-mode path
      const range = s.getRangeAt(0);
      const at = (n: Node) => n instanceof Element ? n : n.parentElement;
      const row = at(range.startContainer)?.closest("[data-block-id]");
      if (!row || !rootRef.current?.contains(row)) return setViewSel(null);
      const text = s.toString().trim().slice(0, 300);
      if (!text) return setViewSel(null);
      const r = range.getBoundingClientRect();
      setViewSel({
        id: row.getAttribute("data-block-id") as string,
        text,
        x: r.left + r.width / 2,
        y: r.top,
      });
    };
    // show only once the drag ends (after the click's own selection handling);
    // selectionchange just hides a bar whose selection collapsed
    const up = () => setTimeout(sync, 0);
    const change = () => {
      const s = document.getSelection();
      if (!s || s.isCollapsed) setViewSel(null);
    };
    document.addEventListener("mouseup", up);
    document.addEventListener("selectionchange", change);
    document.addEventListener("scroll", sync, true);
    return () => {
      document.removeEventListener("mouseup", up);
      document.removeEventListener("selectionchange", change);
      document.removeEventListener("scroll", sync, true);
    };
  }, []);

  useEffect(() => {
    if (focusIdx === null) return;
    const el = refs.current[focusIdx];
    // already-focused: this is a re-run on a later blocks change (the null reset
    // hasn't committed yet) — stealing the caret would clobber a live selection
    if (el && document.activeElement !== el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
    setFocusIdx(null);
  }, [focusIdx, blocks]);

  const set = (i: number, patch: Partial<TextBlock>) =>
    onChange(
      blocks.map((b, j) => (j === i && isText(b) ? { ...b, ...patch } : b)),
    );
  const setBlock = (i: number, patch: Partial<Block>) =>
    onChange(blocks.map((b, j) => (j === i ? { ...b, ...patch } as Block : b)));
  const insertAfter = (i: number) => {
    const cur = blocks[i];
    const inTodo = isText(cur) && cur.type === "todo";
    // Enter on an EMPTY todo exits the list instead of stacking empty rings
    // (outdenting first if nested)
    if (inTodo && !stripMarks(cur.text).trim()) {
      return setBlock(
        i,
        cur.indent ? { indent: cur.indent - 1 } : { type: "text" },
      );
    }
    const indent = (isText(cur) && cur.indent) ? { indent: cur.indent } : {};
    const next = [
      ...blocks.slice(0, i + 1),
      (inTodo
        ? { type: "todo", text: "", done: false, ...indent, id: genId() }
        : { type: "text", text: "", ...indent, id: genId() }) as Block,
      ...blocks.slice(i + 1),
    ];
    onChange(next);
    setFocusIdx(i + 1);
  };
  // an empty writable line at `at` — Enter on a block's first column, and the
  // strip above a page that opens on a non-text block
  const insertAt = (at: number, indent = 0) => {
    onChange([
      ...blocks.slice(0, at),
      { type: "text", text: "", ...(indent ? { indent } : {}), id: genId() } as Block,
      ...blocks.slice(at),
    ]);
    setFocusIdx(at);
  };
  // toggling done sinks the item below the open ones of its contiguous todo run
  // (and un-checking lifts it back to the end of the open section).
  // Indented blocks travel with their parent todo, so subtrees stay glued.
  const toggleTodo = (i: number) => {
    const cur = blocks[i] as TextBlock;
    const done = !cur.done;
    const lvl = cur.indent ?? 0;
    const ind = (x: Block) => (isText(x) ? x.indent ?? 0 : 0);
    const inRun = (x: Block) =>
      (x.type === "todo" && ind(x) === lvl) || (isText(x) && ind(x) > lvl);
    let start = i, end = i;
    while (start > 0 && inRun(blocks[start - 1])) start--;
    // the run must open on a same-level todo, not a dangling deeper block
    while (
      start < i &&
      !(blocks[start].type === "todo" && ind(blocks[start]) === lvl)
    ) start++;
    while (end < blocks.length - 1 && inRun(blocks[end + 1])) end++;
    const groups: Block[][] = [];
    for (const x of blocks.slice(start, end + 1)) {
      if (x.type === "todo" && ind(x) === lvl) groups.push([x]);
      else groups.at(-1)?.push(x);
    }
    const gi = groups.findIndex((g) => g[0] === cur);
    if (gi < 0) return;
    const stamp = (t: string) =>
      done
        ? setMark(t, "completed_at", todayMark())
        // re-opening drops completed_at, so updated_at is what keeps the trace
        : touchTodo(removeMark(t, "completed_at"), todayMark());
    const moved = groups[gi].map((x, j) =>
      j === 0 ? { ...x, done, text: stamp((x as TextBlock).text) } : x
    );
    const rest = groups.filter((_, j) => j !== gi);
    const firstDone = rest.findIndex((g) => (g[0] as TextBlock).done);
    const at = done || firstDone === -1 ? rest.length : firstDone;
    rest.splice(at, 0, moved as Block[]);
    onChange([
      ...blocks.slice(0, start),
      ...rest.flat(),
      ...blocks.slice(end + 1),
    ]);
  };
  const remove = (i: number) => {
    snapshot();
    onChange(blocks.filter((_, j) => j !== i));
    setFocusIdx(Math.max(0, i - 1));
  };
  // shared by ○/✓ list clicks: pull `item` out of block i's list and re-file its
  // `line` into the list under the first heading matching `head` (created as
  // `newHeading` if missing) — prepended for done items, appended for reopened ones
  const refileItem = (
    i: number,
    item: string,
    head: RegExp,
    newHeading: string,
    line: string,
    prepend: boolean,
  ) => {
    const cur = blocks[i];
    if (!isText(cur)) return;
    const strip = (l: string) => l.replace(/^\s*[-*+]\s+/, "");
    const lines = cur.text.split("\n");
    const li = lines.findIndex((l) =>
      /^\s*[-*+]\s+/.test(l) && strip(l) === item
    );
    if (li < 0) return;
    snapshot();
    lines.splice(li, 1);
    const restText = lines.join("\n");
    const next: Block[] = [];
    for (let j = 0; j < blocks.length; j++) {
      if (j === i) {
        if (restText.trim()) next.push({ ...cur, text: restText });
      } else next.push(blocks[j]);
    }
    let h = next.findIndex((b) =>
      isText(b) && b.type === "heading" && head.test(b.text)
    );
    if (h < 0) {
      const hb = { type: "heading", text: newHeading, id: genId() } as Block;
      if (prepend) next.push(hb);
      else next.unshift(hb);
      h = prepend ? next.length - 1 : 0;
    }
    for (let j = h + 1; j <= next.length; j++) {
      const b = next[j];
      if (b && isText(b) && b.type === "text" && /^\s*[-*+]\s+/.test(b.text)) {
        next[j] = {
          ...b,
          text: prepend ? `${line}\n${b.text}` : `${b.text}\n${line}`,
        };
        break;
      }
      if (!b || (isText(b) && b.type === "heading")) {
        next.splice(j, 0, { type: "text", text: line, id: genId() } as Block);
        break;
      }
    }
    onChange(next);
  };
  // ○ click on an "open" markdown list: move the item to the top of the list under
  // the Completed heading, stamped with a done pill; undoable via Ctrl+Z
  const markDone = (i: number, item: string) => {
    const d = new Date();
    const day = `${d.getFullYear()}-${
      String(d.getMonth() + 1).padStart(2, "0")
    }-${String(d.getDate()).padStart(2, "0")}`;
    refileItem(
      i,
      item,
      /^\s*(completed|done|shipped)\b/i,
      "Completed",
      `- ${item} {{green:done ${day}}}`,
      true,
    );
  };
  // ✓ click on a "done" markdown list: strip the done pill and lift the item back
  // to the end of the Open list; undoable via Ctrl+Z
  const markOpen = (i: number, item: string) =>
    refileItem(
      i,
      item,
      /^\s*(open|todo|next|pending|remaining|in progress|blocked)\b/i,
      "Open",
      `- ${item.replace(/\s*\{\{green:done [^}]*\}\}\s*$/, "")}`,
      false,
    );
  // item of a fresh split whose editor opens on mount (block id + item text)
  const [autoItem, setAutoItem] = useState<
    { id: string; item: string } | null
  >(null);
  // inline single-line edit from a rendered list item — replaces just that line
  // (clearing it, or leaving a split's fresh item empty, removes it); undoable
  // via Ctrl+Z
  const editItem = (i: number, item: string, next: string) => {
    setAutoItem(null);
    const cur = blocks[i];
    if (!isText(cur) || (next === item && next.trim() !== "")) return;
    const re = /^(\s*(?:[-*+]|\d+\.)\s+)(.*)$/;
    const lines = cur.text.split("\n");
    const li = lines.findIndex((l) => l.match(re)?.[2] === item);
    if (li < 0) return;
    // dropping a still-empty split item is cleanup, not an undo step
    if (item.trim() || next.trim()) snapshot();
    if (next.trim()) lines[li] = lines[li].match(re)![1] + next;
    else lines.splice(li, 1);
    const text = lines.join("\n");
    onChange(
      text.trim()
        ? blocks.map((b, j) => (j === i ? { ...b, text } as Block : b))
        : blocks.filter((_, j) => j !== i),
    );
  };
  // Enter inside a rendered list item: split it at the caret and open the new
  // item's editor; Enter on an empty item exits (drops the dangling line)
  const splitItem = (i: number, item: string, before: string, after: string) => {
    const cur = blocks[i];
    if (!isText(cur)) return;
    const re = /^(\s*(?:[-*+]|\d+\.)\s+)(.*)$/;
    const lines = cur.text.split("\n");
    const li = lines.findIndex((l) => l.match(re)?.[2] === item);
    if (li < 0) return;
    snapshot();
    if (!item && !before.trim() && !after.trim()) {
      setAutoItem(null);
      lines.splice(li, 1);
    } else {
      const prefix = lines[li].match(re)![1];
      lines.splice(li, 1, prefix + before, prefix + after);
      setAutoItem((isText(cur) && cur.id) ? { id: cur.id, item: after } : null);
    }
    onChange(
      blocks.map((
        b,
        j,
      ) => (j === i ? { ...b, text: lines.join("\n") } as Block : b)),
    );
  };
  // Alt+↑ / Alt+↓ — swap the focused block with its neighbor
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= blocks.length) return;
    const next = [...blocks];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
    setFocusIdx(j);
  };
  // undo history for structural edits (drag reorder, block delete) — Ctrl/⌘+Z
  // restores, except while a field holds keystrokes of its own (those keep the
  // browser's native undo). A block textarea merely refocused after a delete has
  // nothing native to give, so deferring to it would swallow the shortcut.
  const undoStack = useRef<Block[][]>([]);
  const snapshot = () => {
    undoStack.current.push(blocks);
    if (undoStack.current.length > 30) undoStack.current.shift();
  };
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || (e.key !== "z" && e.key !== "Z")) return;
      const el = document.activeElement as HTMLElement | null;
      const inField = el?.tagName === "TEXTAREA" || el?.tagName === "INPUT";
      if (inField && (typed.current || !rootRef.current?.contains(el))) return;
      const prev = undoStack.current.pop();
      if (!prev) return;
      e.preventDefault();
      onChangeRef.current(prev);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  const {
    dragIdx,
    overIdx,
    setOverIdx,
    tabDrag,
    setTabDrag,
    dragHandle,
    dropClass,
    dragRow,
  } = useBlockDrag(blocks, snapshot, onChange);
  // a comment target picked in place (💬 on a table row or a text selection),
  // awaiting its body
  const [pendingNote, setPendingNote] = useState(
    null as { id: string; anchor: string } | null,
  );
  // clicking an image selects its block (ring) instead of opening the markdown;
  // Escape deselects, Delete/Backspace removes, any outside click clears
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // active tab per {{tab}} group, keyed by the group's first heading block id
  const [activeTabs, setActiveTabs] = useState<Record<string, number>>({});
  // open state per {{fold}} section, collapsed by default
  const [openFolds, setOpenFolds] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!selectedId) return;
    const bidOf = (x: Block, j: number) =>
      (isText(x) && x.id) ? x.id : String(j);
    const key = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      // a cell/line editor owns its keys — Backspace there must not eat the block
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Escape") setSelectedId(null);
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        const idx = blocks.findIndex((x, j) => bidOf(x, j) === selectedId);
        if (idx >= 0) remove(idx);
        setSelectedId(null);
      }
    };
    const clear = () => setSelectedId(null);
    document.addEventListener("keydown", key);
    document.addEventListener("mousedown", clear);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("mousedown", clear);
    };
  }, [selectedId, blocks]);
  // swap an image block's asset via a file picker, keeping the alt text
  const replaceImage = (i: number) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const f = input.files?.[0];
      const cur = blocks[i];
      if (!f || !isText(cur)) return;
      const alt = cur.text.match(/^\s*!\[([^\]]*)\]/)?.[1] || "image";
      uploadAsset(f).then((r) => {
        if (r.id) set(i, { text: `![${alt}](/api/assets/${r.id})` });
      });
    };
    input.click();
  };
  const pick = (i: number, key: string) => {
    setMenuIdx(null);
    if (key === "subpage" || key === "database") return onSlashInsert(key, i);
    // section markers: a heading whose {{tab}}/{{fold}} groups the blocks below
    if (key === "tab" || key === "fold") {
      onChange(
        blocks.map((b, j) =>
          j === i
            ? {
              type: "heading",
              text: `{{${key}}} `,
              id: (isText(b) && b.id) || genId(),
            } as Block
            : b
        ),
      );
      return setFocusIdx(i);
    }
    if (key === "folder") {
      return onChange(
        blocks.map((b, j) =>
          j === i
            ? {
              type: "folder",
              path: "",
              view: "list",
              id: (isText(b) && b.id) || genId(),
            } as Block
            : b
        ),
      );
    }
    if (key === "html") {
      return onChange(
        blocks.map((b, j) =>
          j === i
            ? {
              type: "html",
              html: "",
              id: (isText(b) && b.id) || genId(),
            } as Block
            : b
        ),
      );
    }
    onChange(
      blocks.map((b, j) =>
        j === i
          ? {
            type: key as TextBlock["type"],
            text: "",
            id: (isText(b) && b.id) || genId(),
          }
          : b
      ),
    );
    setFocusIdx(i);
  };

  // "{{gr" + pick green → "{{green:}}" with the caret before "}}"
  const pickPill = (color: string) => {
    if (!pill) return;
    const b = blocks[pill.i];
    if (!isText(b)) return;
    const after = b.text.slice(pill.start + pill.query.length);
    const closing = after.startsWith("}}") ? "" : "}}";
    set(pill.i, {
      text: `${b.text.slice(0, pill.start)}${color}:${closing}${after}`,
    });
    setPill(null);
    const el = refs.current[pill.i];
    const pos = pill.start + color.length + 1;
    if (el) {
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(pos, pos);
      });
    }
  };

  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "0";
    el.style.height = `${el.scrollHeight}px`;
  };

  // "{{tab}}" / "{{fold}}" heading blocks group the blocks below them (same
  // dialect as the session-ticket spec): a tab runs to the next marked heading,
  // consecutive tabs form one strip; a fold is a standalone accordion. The first
  // heading's row renders the control; hidden blocks are skipped. Double-click
  // a label to rename its heading.
  const tabMeta = (() => {
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
  })();

  // a tab owns every block filed under it (plain headings included), so its span
  // comes from tabMeta, not from the next-heading rule moveTo uses
  const tabSpan = (i: number) => {
    const t = tabMeta.of.get(i);
    let len = 1;
    while (i + len < blocks.length) {
      const m = tabMeta.of.get(i + len);
      if (!m || m.kind !== "tab" || m.group !== t?.group || m.tab !== t?.tab) {
        break;
      }
      len++;
    }
    return len;
  };
  const moveTab = (from: number, to: number) => {
    if (from === to) return;
    snapshot();
    const len = tabSpan(from);
    const next = [...blocks];
    const moved = next.splice(from, len);
    // dragged right: land after the target's whole tab, not inside it
    next.splice(to < from ? to : to - len + tabSpan(to), 0, ...moved);
    onChange(next);
  };

  const textCtx: TextCtx = {
    blocks, refs, editStart, menuIdx, menuSel, pill, pillSel, autoItem, links, onLinkItem, chipsFor,
    set, remove, move, insertAt, insertAfter, grow, syncSel, applyInline, applyLink, commentSel, pick, pickPill,
    replaceImage, markDone, markOpen, editItem, splitItem, setFocusIdx, setActiveId, setSelectedId, setDueIdx,
    setMenuIdx, setMenuSel, setPill, setPillSel, setSel, setPendingNote,
  };

  return (
    <div
      ref={rootRef}
      className="flex flex-col"
      onFocusCapture={() => (typed.current = false)}
      onInputCapture={() => (typed.current = true)}
    >
      {viewSel && (
        <FormatBar
          fixed
          style={{
            left: viewSel.x,
            top: viewSel.y - 6,
            transform: "translate(-50%, -100%)",
          }}
          actions={[
            {
              label: "💬 Comment",
              title: "Comment on selection",
              onClick: () => {
                setPendingNote({ id: viewSel.id, anchor: viewSel.text });
                setViewSel(null);
                clearSelection();
              },
            },
          ]}
        />
      )}
      {blocks.length > 0 && !isText(blocks[0]) && (
        <button
          type="button"
          title="write above this block"
          onClick={() => insertAt(0)}
          className="flex h-4 w-full items-center gap-2 text-[10px] text-transparent transition-colors hover:text-ink-muted"
        >
          <span>+ write here</span>
          <span className="h-px flex-1 bg-current opacity-40" />
        </button>
      )}
      {blocks.map((b, i) => {
        // section groups: strip/accordion on the marked heading, hide inactive blocks
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
        if (b.type === "folder") {
          return (
            <Fragment key={b.id ?? i}>
              {dragRow(
                i,
                <FolderBlock
                  block={b}
                  onPatch={(patch) => setBlock(i, patch)}
                  onRemove={() => remove(i)}
                  onOpenReport={onOpenReport}
                />,
              )}
            </Fragment>
          );
        }
        if (b.type === "html") {
          return (
            <Fragment key={b.id ?? i}>
              {dragRow(
                i,
                <HtmlBlock
                  block={b}
                  onPatch={(patch) => setBlock(i, patch)}
                  onRemove={() => remove(i)}
                />,
              )}
            </Fragment>
          );
        }
        if (!isText(b)) {
          // database/subpage markers live in the flow but render as the page sections below
          return null;
        }
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
        // the live agent working on this todo, if any
        const lv = b.type === "todo" && !b.done && b.id && liveCfg
          ? live.find((x) => worksOn(x.a, b.id as string))
          : undefined;
        return (
          <Fragment key={b.id ?? i}>
            <div
              data-block-id={b.id || undefined}
              className={`group relative -ml-6 -mr-1 flex items-start gap-2 pl-6 pr-1 ${
                hasOpen ? "rounded-md bg-copper/[0.05]" : ""
              } ${flash === b.id ? "rounded-md ring-1 ring-copper/50" : ""} ${
                selectedId === bid
                  // tables/snippets: color the card's own contour — no ring
                  // floating around the block gutter with a gap
                  ? isTable
                    ? "[&_.md-table-card]:border-copper/70 [&_.md-table-card]:ring-1 [&_.md-table-card]:ring-copper/50"
                    : isSnippet
                    ? "[&_.md-snippet-card]:ring-1 [&_.md-snippet-card]:ring-copper/60"
                    : "rounded-md ring-2 ring-copper/60"
                  : ""
              } ${
                dropClass(i)
              } ${lv && liveCfg ? liveRowCls(lv.state, liveCfg) : ""}`}
              // nested blocks shift right; overrides the base pl-6 (24px)
              style={b.indent ? { paddingLeft: 24 + b.indent * 20 } : undefined}
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
          </Fragment>
        );
      })}
    </div>
  );
}
