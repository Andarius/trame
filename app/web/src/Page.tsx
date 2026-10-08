import { Fragment, type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import {
  addSessionLink,
  attachUdbToPage,
  type Block,
  type BoardData,
  createComment,
  createPage,
  createUdb,
  deleteComment,
  deletePage,
  getIdentity,
  getPage,
  getPresence,
  listComments,
  openInBrowser,
  type PageChild,
  type PageComment,
  type PageDetail,
  pageToSession,
  pageToStory,
  pingPresence,
  type Presence,
  type Session,
  type SessionLink,
  type UdbMeta,
  updateComment,
  updatePage,
  uploadAsset,
} from "./api";
import {
  BOOL_CODEC,
  enumCodec,
  useLocalStorage,
  appConfirm,
  ClientChip,
  dblOpen,
  EntityIcon,
  inSubtree,
  pageGlyph,
  pagesById,
  Popover,
  SECTION_LABEL,
  Select,
  sessionTagKeys,
  StatusDot,
  statusStyle,
  storyOf,
  TagChips,
  timeAgo,
  uuid7Time,
  IconButton,
  ProgressBar,
} from "./ui";
import { type ItemLink, LinkChip, Markdown, PageActivityChip } from "./md";
import { blocksToMarkdown } from "./page-serialize";
import { IconPicker } from "./udb/cells";
import {
  normalizeMarks,
  readMarks,
  removeMark,
  setMark,
  stripMarks,
  todayMark,
  touchTodo,
  writeMark,
} from "../../../core/todo-marks.ts";
import { DueMenu, TodoDueCtx, useFocusedBlock } from "./due";
import { PAGE_STATUSES } from "../../../core/page-status.ts";
import {
  LiveAgentChip,
  LiveLine,
  LiveRail,
  liveRingCls,
  liveRowCls,
  LiveTrail,
  useAgents,
  worksOn,
} from "./agents";
import { DatabaseView } from "./udb/DatabaseTable";
import { FolderBlock } from "./FolderBlock";
import { TagEditor } from "./TagEditor";
import { FRONTEND_PLUGINS, isMetadataMark } from "./plugins";
import { markRoleOf } from "../../../core/mark-roles.ts";
import { HtmlBlock } from "./HtmlBlock";
import { tagPriority } from "./SessionSort";
import { QueryBox } from "./SessionBar";
import { filterSessions } from "./query";
import {
  FinishedStrip,
  PageRow,
  ProjectChildren,
  RepoChip,
  repoTitle,
  SessionRow,
  TodoBar,
  useFinishedCards,
} from "./project-page";
import { genId, ensureIds, PROJECT_COLORS } from "./page-ids";
import {
  type TextBlock,
  isText,
  SLASH,
  PILLS,
  caretXY,
  type InlineKind,
  toggleInline,
  linkify,
} from "./editor-text";
import { CornerToolbar, FormatBar } from "./editor-toolbar";
import { PresenceBar, StartWatcherButton } from "./PresenceBar";
import {
  type CommentOps,
  type CommentMode,
  COMMENT_MODE_KEY,
  STORY_ORDER_KEY,
  PANEL_OPEN_KEY,
  openKey,
  loadOpenThreads,
  isAgent,
  answeredIn,
  anchorQuoteOf,
  RowNote,
  CommentItem,
  AddNote,
  CommentGutter,
} from "./comments";

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
  // open "{{" pill autocomplete: block index, offset of the partial color, its
  // text, and the popup anchor under the "{{" (px, relative to the block row)
  const [pill, setPill] = useState<
    { i: number; start: number; query: string; x: number; y: number } | null
  >(null);
  const [pillSel, setPillSel] = useState(0);
  // block currently in raw-textarea edit mode (Notion-style: click to edit, blur to render)
  const [activeId, setActiveId] = useState<string | null>(null);
  // non-collapsed selection inside a block textarea → floating format toolbar
  // (px anchor is relative to the block row, like the pill menu)
  const [sel, setSel] = useState<
    { i: number; start: number; end: number; x: number; y: number } | null
  >(null);
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
  // mouse reordering: ⋮⋮ handle on hover, drop on a row to move the block there.
  // Pointer events, NOT html5 dnd — WebKitGTK (the desktop webview) drops dragstart.
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [tabDrag, setTabDrag] = useState<number | null>(null); // heading block being dragged along its strip
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
        dragIdx === null ? "hidden group-hover:block" : "block"
      }`}
    >
      ⋮⋮
    </button>
  );
  // a bar on the edge the block would land on — moveTo drops it below the row
  // when dragged downwards, above it when dragged up
  const dropClass = (i: number) =>
    overIdx !== i || dragIdx === null || dragIdx === i
      ? ""
      : dragIdx < i
      ? "shadow-[0_2px_0_0_#c98a63]"
      : "shadow-[0_-2px_0_0_#c98a63]";
  // handle + drop target for blocks that render no text row of their own
  const dragRow = (i: number, child: React.ReactNode) => (
    <div
      className={`group relative pl-6 ${dropClass(i)}`}
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
      if (overIdx !== null) moveTo(dragIdx, overIdx);
      setDragIdx(null);
      setOverIdx(null);
    };
    document.addEventListener("mouseup", up);
    return () => document.removeEventListener("mouseup", up);
  }, [dragIdx, overIdx, blocks]);
  useEffect(() => {
    if (tabDrag === null) return;
    const up = () => setTabDrag(null);
    document.addEventListener("mouseup", up);
    return () => document.removeEventListener("mouseup", up);
  }, [tabDrag]);
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
                document.getSelection()?.removeAllRanges();
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
                <div
                  key={bid0}
                  className="my-1 overflow-hidden rounded-lg border border-line-soft"
                >
                  <button
                    type="button"
                    title="double-click to rename"
                    className="flex w-full items-center gap-2 bg-panel px-3 py-2 text-left text-[13px] font-medium text-ink transition-colors hover:text-copper"
                    onClick={() =>
                      setOpenFolds((m) => ({ ...m, [gid]: !open }))}
                    onDoubleClick={() => setFocusIdx(i)}
                  >
                    <span className="text-[10px] text-ink-muted">
                      {open ? "▾" : "▸"}
                    </span>
                    {title || "untitled"}
                  </button>
                </div>
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
                <div
                  key={bid0}
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
                        setActiveTabs((m) => ({ ...m, [gid]: ti }));
                      }}
                      onClick={() =>
                        setActiveTabs((m) => ({ ...m, [gid]: ti }))}
                      onDoubleClick={() => setFocusIdx(h.i)}
                    >
                      {h.title || "untitled"}
                    </button>
                  ))}
                </div>
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
        const filter = b.text.startsWith("/")
          ? b.text.slice(1).toLowerCase()
          : null;
        const items = filter === null ? [] : SLASH.filter((s) =>
          // match the key too: "/todo" must find "To-do" despite the hyphen
          s.key.includes(filter) || s.label.toLowerCase().includes(filter)
        );
        const pillItems = pill?.i === i
          ? PILLS.filter((p) => p.key.startsWith(pill.query.toLowerCase()))
          : [];
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
        // session-report lists: the nearest heading above decides how bullets render
        // (Completed → green checks, Open/Next → copper rings; see md.tsx ListVariant)
        let listVariant: "done" | "open" | undefined;
        for (let j = i - 1; j >= 0; j--) {
          const pb = blocks[j];
          if (pb.type !== "heading") continue;
          listVariant = /^\s*(completed|done|shipped)\b/i.test(pb.text)
            ? "done"
            : /^\s*(open|todo|next|pending|remaining|in progress|blocked)\b/i
                .test(pb.text)
            ? "open"
            : undefined;
          break;
        }
        const textCls = b.type === "heading"
          ? "text-[16px] font-semibold text-ink"
          : `text-[13px] leading-relaxed ${
            b.type === "todo" && b.done
              ? "text-ink-muted line-through"
              : "text-ink-soft"
          }`;
        // fenced-code blocks keep their snippet look while editing (see md.tsx <pre>)
        const isSnippet = b.type === "text" && /^\s*```/.test(b.text);
        // image-only blocks keep the picture visible; the markdown edits below it
        const isImage = b.type === "text" &&
          /^\s*!\[[^\]]*\]\([^)\s]+\)\s*$/.test(b.text);
        // pipe-table blocks select on click (like images) — raw markdown via ✏️ only
        const isTable = b.type === "text" && /^\s*\|.*\|/.test(b.text);
        // all-bullet blocks edit line by line (md.tsx EditableItem), keeping the
        // list rendered — raw markdown via ✏️ only
        const isList = b.type === "text" && /\S/.test(b.text) &&
          b.text.split("\n").filter((l) => l.trim()).every((l) =>
            /^\s*([-*+]|\d+\.)\s+/.test(l)
          );
        const editCls = isSnippet
          ? "my-1 rounded-md bg-panel px-2 font-mono text-[12px] leading-relaxed text-ink-soft"
          : isImage
          ? "rounded-md bg-panel px-2 font-mono text-[11px] leading-relaxed text-ink-muted"
          : isTable
          ? "my-1 rounded-md bg-panel px-2 font-mono text-[11.5px] leading-relaxed text-ink-soft"
          : `bg-transparent ${textCls}`;
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
                // same visual language as session-report lists: ○ open, ✓ done
                <button
                  type="button"
                  title={b.done ? "Mark as open" : "Mark as done"}
                  onClick={() => toggleTodo(i)}
                  className="mt-[7px] flex h-3.5 w-3.5 shrink-0 items-center justify-center"
                >
                  {b.done
                    ? (
                      <span className="text-[12px] leading-none text-active">
                        ✓
                      </span>
                    )
                    : (
                      <span
                        className={`h-3 w-3 rounded-full border-[1.5px] hover:bg-copper/20 ${
                          (lv && liveCfg && liveRingCls(lv.state, liveCfg)) || "border-copper"
                        }`}
                      />
                    )}
                </button>
              )}
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
                    return setSelectedId(bid);
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
                  setFocusIdx(i);
                }}
                onDoubleClick={() => {
                  if (isSnippet) {
                    document.getSelection()?.removeAllRanges();
                    setSelectedId(null);
                    setFocusIdx(i);
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
                  value={b.type === "todo" ? { done: !!b.done, onDue: () => setDueIdx(i) } : { done: false }}
                >
                <Markdown
                  text={b.type === "todo" && !b.done && !b.text.includes("{{trame:due=")
                    ? `${b.text} {{trame:due=}}` // placeholder: DuePill's hover "⚑ due"
                    : b.text}
                  listVariant={listVariant}
                  onEdit={isTable
                    ? (next) => set(i, { text: next })
                    : undefined}
                  onCommentRow={isTable && b.id
                    ? (anchor) => setPendingNote({ id: b.id as string, anchor })
                    : undefined}
                  rowComments={isTable && b.id
                    ? (anchor) =>
                      visibleComments.filter((c) => c.anchor === anchor).length
                    : undefined}
                  onMarkDone={listVariant === "open"
                    ? (item) => markDone(i, item)
                    : undefined}
                  onMarkOpen={listVariant === "done"
                    ? (item) => markOpen(i, item)
                    : undefined}
                  onEditItem={(item, next) => editItem(i, item, next)}
                  onSplitItem={(item, before, after) =>
                    splitItem(i, item, before, after)}
                  autoEditItem={autoItem && autoItem.id === b.id
                    ? autoItem.item
                    : undefined}
                  getItemLinks={(item) =>
                    chipsFor(
                      links?.filter((x) =>
                        x.block_id === b.id && x.anchor === item
                      ) ?? [],
                    )}
                  onLinkItem={b.id && onLinkItem
                    ? (item) => onLinkItem(b.id as string, item)
                    : undefined}
                />
                </TodoDueCtx.Provider>
                {lv && liveCfg && (
                  // reading the activity line shouldn't open the editor
                  <div onClick={(e) => e.stopPropagation()}>
                    <LiveLine a={lv.a} state={lv.state} cfg={liveCfg} />
                  </div>
                )}
              </div>
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
                  setActiveId(bid);
                  editStart.current = stripMarks(b.text);
                }}
                onBlur={() => {
                  setActiveId((cur) => (cur === bid ? null : cur));
                  setSel((cur) => (cur && cur.i === i ? null : cur));
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
                onSelect={(e) => syncSel(i, e.currentTarget)}
                onChange={(e) => {
                  set(i, { text: e.target.value });
                  grow(e.target);
                  setMenuIdx(e.target.value.startsWith("/") ? i : null);
                  setMenuSel(0);
                  // caret sitting right after "{{" (plus a partial color) opens the pill menu
                  const m = e.target.value
                    .slice(0, e.target.selectionStart)
                    .match(/\{\{([a-zA-Z]*)$/);
                  if (m) {
                    const el = e.target;
                    const p = caretXY(el, el.selectionStart - m[0].length);
                    setPill({
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
                  } else setPill(null);
                  setPillSel(0);
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
                      return applyInline(i, kind);
                    }
                    if (k === "k") {
                      e.preventDefault();
                      return applyLink(i);
                    }
                  }
                  if (menuIdx === i && items.length) {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      return setMenuSel((s) => (s + 1) % items.length);
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      return setMenuSel((s) =>
                        (s - 1 + items.length) % items.length
                      );
                    }
                    if (e.key === "Enter") {
                      e.preventDefault();
                      return pick(
                        i,
                        items[Math.min(menuSel, items.length - 1)].key,
                      );
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      return setMenuIdx(null);
                    }
                  }
                  if (pill?.i === i && pillItems.length) {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      return setPillSel((s) => (s + 1) % pillItems.length);
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      return setPillSel((s) =>
                        (s - 1 + pillItems.length) % pillItems.length
                      );
                    }
                    if (e.key === "Enter") {
                      e.preventDefault();
                      return pickPill(
                        pillItems[Math.min(pillSel, pillItems.length - 1)].key,
                      );
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      return setPill(null);
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
                      insertAt(i, b.indent ?? 0);
                    } else insertAfter(i);
                  } else if (
                    e.key === "Backspace" && b.text === "" && blocks.length > 1
                  ) {
                    e.preventDefault();
                    remove(i);
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
                    move(i, -1);
                  } else if (e.key === "ArrowDown" && e.altKey) {
                    e.preventDefault();
                    move(i, 1);
                  } else if (e.key === "ArrowUp" && !e.shiftKey && i > 0) {
                    if (isSnippet && el.selectionStart > 0) return;
                    e.preventDefault();
                    setFocusIdx(i - 1);
                  } else if (
                    e.key === "ArrowDown" && !e.shiftKey &&
                    i < blocks.length - 1
                  ) {
                    if (isSnippet && !atEnd) return;
                    e.preventDefault();
                    setFocusIdx(i + 1);
                  }
                }}
              />
              {/* a todo is its own block, not a list item — carry its chips here, after
                  the textarea so edit mode does not move them left of the task text */}
              {lv && liveCfg && <LiveTrail a={lv.a} state={lv.state} cfg={liveCfg} />}
              {b.type === "todo" &&
                chipsFor(links?.filter((x) => x.block_id === b.id) ?? []).map((lk) => (
                  <span key={lk.sessionId} className="mt-[3px] shrink-0">
                    <LinkChip lk={lk} />
                  </span>
                ))}
              {menuIdx === i && items.length > 0 && (
                <Popover
                  onClose={() => setMenuIdx(null)}
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
                      onClick={() => pick(i, s.key)}
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
              )}
              {pill?.i === i && pillItems.length > 0 && (
                <Popover
                  onClose={() => setPill(null)}
                  className="w-[200px]"
                  // anchored under the "{{" — inline left/top override left-0/top-full
                  style={{ left: pill.x, top: pill.y }}
                >
                  {pillItems.map((p, si) => (
                    <button
                      type="button"
                      key={p.key}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${
                        si === Math.min(pillSel, pillItems.length - 1)
                          ? "bg-panel"
                          : "hover:bg-panel"
                      }`}
                      onMouseMove={() => setPillSel(si)}
                      onClick={() => pickPill(p.key)}
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
              )}
              {sel?.i === i && (
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
                      onClick: () => applyInline(i, "bold"),
                    },
                    {
                      label: "I",
                      title: "Italic (Ctrl+I)",
                      cls: "italic",
                      onClick: () => applyInline(i, "italic"),
                    },
                    {
                      label: "S",
                      title: "Strikethrough (Ctrl+Shift+S)",
                      cls: "line-through",
                      onClick: () => applyInline(i, "strike"),
                    },
                    {
                      label: "</>",
                      title: "Code (Ctrl+E)",
                      cls: "font-mono !text-[10.5px]",
                      onClick: () => applyInline(i, "code"),
                    },
                    {
                      label: "🔗",
                      title: "Link (Ctrl+K)",
                      cls: "!text-[10.5px]",
                      onClick: () => applyLink(i),
                    },
                    ...(b.id
                      ? [{
                        label: "💬",
                        title: "Comment on selection",
                        cls: "!text-[10.5px]",
                        onClick: () => commentSel(i),
                      }]
                      : []),
                  ]}
                />
              )}
              {isSnippet && (
                <CornerToolbar
                  chip={b.text.match(/^\s*```\s*([\w+#-]*)/)?.[1] ?? ""}
                  onChip={(l) =>
                    set(i, {
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
                    {
                      icon: "edit",
                      title: "Edit",
                      onClick: () => setFocusIdx(i),
                    },
                    {
                      icon: "delete",
                      title: "Delete",
                      danger: true,
                      onClick: () => remove(i),
                    },
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
                    {
                      icon: "replace",
                      title: "Replace image",
                      onClick: () => replaceImage(i),
                    },
                    {
                      icon: "edit",
                      title: "Edit alt / URL",
                      onClick: () => setFocusIdx(i),
                    },
                    {
                      icon: "delete",
                      title: "Delete",
                      danger: true,
                      onClick: () => remove(i),
                    },
                  ]}
                />
              )}
              {(isTable || isList) && (
                <CornerToolbar
                  actions={[
                    {
                      icon: "edit",
                      title: "Raw markdown (edit / export)",
                      onClick: () => setFocusIdx(i),
                    },
                    {
                      icon: "delete",
                      title: "Delete",
                      danger: true,
                      onClick: () => remove(i),
                    },
                  ]}
                />
              )}
              {b.type === "todo" && (
                <CornerToolbar
                  actions={[
                    // clicking the text edits, so the second slot is the due date
                    {
                      icon: "flag",
                      title: "Due date",
                      onClick: () => setDueIdx(i),
                    },
                    {
                      icon: "delete",
                      title: "Delete",
                      danger: true,
                      onClick: () => remove(i),
                    },
                  ]}
                />
              )}
              {dueIdx === i && b.type === "todo" && (
                <DueMenu
                  current={readMarks(b.text).due ?? null}
                  onPick={(due) => set(i, { text: due ? writeMark(b.text, "due", due) : removeMark(b.text, "due") })}
                  onClose={() => setDueIdx(null)}
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
              <div className="my-1 ml-6 flex max-w-[480px] flex-col gap-1.5 rounded-md border border-copper/40 bg-panel p-2">
                <div className="flex items-start justify-between gap-2 text-[10.5px] text-ink-muted">
                  <span className="min-w-0 truncate">
                    {isTable ? "on row" : "on"}: “{pendingNote.anchor}”
                  </span>
                  <button
                    type="button"
                    className="shrink-0 hover:text-ink"
                    onClick={() => setPendingNote(null)}
                  >
                    ×
                  </button>
                </div>
                <AddNote
                  autoFocus
                  onAdd={(body) => {
                    commentOps.add(bid, pendingNote?.anchor ?? "", body);
                    setPendingNote(null);
                  }}
                />
              </div>
            )}
            {inlineOpen && (
              <div className="my-1 ml-6 flex max-w-[480px] flex-col gap-1.5 border-l-2 border-copper/40 pl-3">
                {visibleComments.map((c) => {
                  const q = anchorQuoteOf(c, b.text);
                  return (
                    <div key={c.id} className="flex flex-col gap-1">
                      {q && <RowNote label={q.label} text={q.text} />}
                      <CommentItem
                        c={c}
                        canEdit={Boolean(meId) && c.author_id === meId}
                        answered={answeredIn(c, blockComments)}
                        onUpdate={(patch) => commentOps.update(c.id, patch)}
                        onDelete={() => commentOps.remove(c.id)}
                      />
                    </div>
                  );
                })}
                <AddNote
                  autoFocus={focusThread === b.id}
                  onAdd={(body) => commentOps.add(b.id as string, b.text, body)}
                />
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

export function Page(
  {
    pageId,
    board,
    udbs,
    onOpenPage,
    onOpenSession,
    onOpenClient,
    onOpenReport,
    onChanged,
  }: {
    pageId: string;
    board: BoardData;
    udbs: UdbMeta[];
    onOpenPage: (id: string) => void;
    onOpenSession: (id: string, full?: boolean) => void;
    onOpenClient: (id: string) => void;
    onOpenReport: (path: string) => void;
    onChanged: () => void; // sidebar tree cares about title/icon/structure changes
  },
) {
  const [page, setPage] = useState<PageDetail | null>(null);
  // 🔗 on a list item: pick the session to link it to
  const [linkPick, setLinkPick] = useState<
    { blockId: string; item: string } | null
  >(null);
  const { live: liveAgentsAll, recent: recentAgents } = useAgents();
  const [blocks, setBlocks] = useState<Block[]>([]);
  const focused = useFocusedBlock(blocks);
  const [comments, setComments] = useState<PageComment[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [sessionFilter, setSessionFilter] = useState<"active" | "done">("active");
  const [showDoneCards, setShowDoneCards] = useState(false);
  const [unfoldedStories, setUnfoldedStories] = useState<Set<string>>(new Set());
  const [cardQuery, setCardQuery] = useState("");
  const [storyOrder, setStoryOrder] = useLocalStorage<"touched" | "priority">(STORY_ORDER_KEY, "touched", enumCodec(["touched", "priority"]));
  const [showArchivedDocs, setShowArchivedDocs] = useState(false);
  const [commentMode, setCommentMode] = useLocalStorage<CommentMode>(COMMENT_MODE_KEY, "inline", enumCodec(["inline", "panel"]));
  const [openThreads, setOpenThreads] = useState<Set<string>>(() =>
    loadOpenThreads(pageId)
  );
  const [focusThread, setFocusThread] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useLocalStorage(PANEL_OPEN_KEY, false, BOOL_CODEC);
  // set + persist open threads together, keyed by the current page (no cross-page race)
  const putOpenThreads = (v: Set<string> | ((p: Set<string>) => Set<string>)) =>
    setOpenThreads((p) => {
      const next = typeof v === "function" ? v(p) : v;
      localStorage.setItem(openKey(pageId), JSON.stringify([...next]));
      return next;
    });
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);
  const [idCopied, setIdCopied] = useState(false);
  const [headerMenu, setHeaderMenu] = useState(false);
  const [mdOpen, setMdOpen] = useState(false);
  const [mdCopied, setMdCopied] = useState(false);
  const [meId, setMeId] = useState<string | null>(null);
  useEffect(() => {
    getIdentity().then((i) => setMeId(i.userId)).catch(() => {});
  }, []);
  // presence: heartbeat that I'm here + poll who else / which agents are watching
  const [presence, setPresence] = useState<Presence[]>([]);
  useEffect(() => {
    const beat = () => {
      if (document.hidden) return;
      pingPresence(pageId);
      getPresence(pageId).then(setPresence).catch(() => {});
    };
    beat();
    const t = setInterval(beat, 8000);
    return () => clearInterval(t);
  }, [pageId]);
  // "select all → copy" the whole page as Markdown. Blocks are separate textareas, so
  // a second Ctrl/⌘+A (or one with nothing focused) selects the page instead of a block;
  // a copy while page-selected writes Markdown to the clipboard.
  const [pageSelected, setPageSelected] = useState(false);
  useEffect(() => {
    if (!pageSelected) return;
    const onCopy = (e: ClipboardEvent) => {
      e.preventDefault();
      e.clipboardData?.setData(
        "text/plain",
        blocksToMarkdown(page?.title ?? "", blocksRef.current),
      );
    };
    document.addEventListener("copy", onCopy);
    return () => document.removeEventListener("copy", onCopy);
  }, [pageSelected, page?.title]);
  const onPageKeyDown = (e: ReactKeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === "a" || e.key === "A")) {
      const el = document.activeElement as HTMLTextAreaElement | null;
      const inTextarea = el?.tagName === "TEXTAREA";
      const fullySelected = inTextarea &&
        el!.selectionStart === 0 && el!.selectionEnd === el!.value.length &&
        el!.value.length > 0;
      // first Ctrl+A selects the focused block (native); a second one selects the page
      if (!inTextarea || fullySelected) {
        e.preventDefault();
        el?.blur();
        document.getSelection()?.removeAllRanges();
        setPageSelected(true);
      }
    } else if (e.key !== "Meta" && e.key !== "Control") {
      setPageSelected(false); // any other key drops the whole-page selection
    }
  };
  // live-refresh comments so watcher status (seen/answering) and agent replies appear
  // without a reload; only swap state when the payload actually changed (keeps
  // in-progress edits and avoids re-render churn), and pause when the tab is hidden.
  useEffect(() => {
    const tick = () => {
      if (document.hidden) return;
      listComments(pageId).then((next) =>
        setComments((
          prev,
        ) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
      ).catch(() => {});
    };
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, [pageId]);
  const [iconOpen, setIconOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const saveTimer = useRef<number | undefined>(undefined);
  const savingRef = useRef(0); // in-flight updatePage calls
  const blocksRef = useRef<Block[]>([]);

  // live-refresh content written by others (agents via MCP, another tab). Never
  // while the user is mid-edit — focused input/textarea, pending debounce, or
  // in-flight save skips the tick, re-checked once the fetch resolves.
  useEffect(() => {
    const busy = () => {
      if (saveTimer.current !== undefined || savingRef.current > 0) return true;
      const tag = document.activeElement?.tagName;
      return tag === "TEXTAREA" || tag === "INPUT";
    };
    const tick = () => {
      if (document.hidden || busy()) return;
      getPage(pageId).then((p) => {
        if (busy()) return; // an edit started while the fetch was in flight
        if (
          p.content.length &&
          JSON.stringify(p.content) !== JSON.stringify(blocksRef.current)
        ) {
          const { blocks: content, changed } = ensureIds(p.content);
          setBlocks(content);
          blocksRef.current = content;
          if (changed) {
            savingRef.current++;
            updatePage(pageId, { content }).catch(() => {}).finally(() =>
              savingRef.current--
            );
          }
        }
        setPage((
          prev,
        ) => (JSON.stringify(prev) === JSON.stringify(p) ? prev : p));
      }).catch(() => {});
    };
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, [pageId]);

  const reload = () => getPage(pageId).then(setPage).catch(() => {});
  const reloadComments = () =>
    listComments(pageId).then(setComments).catch(() => {});
  const commentOps: CommentOps = {
    add: (blockId, anchor, body) =>
      createComment({
        page_id: pageId,
        block_id: blockId,
        anchor: anchor.slice(0, 300),
        body,
      }).then(reloadComments),
    update: (id, patch) => updateComment(id, patch).then(reloadComments),
    remove: (id) => deleteComment(id).then(reloadComments),
  };
  const setMode = (m: CommentMode) => {
    if (m === commentMode) return;
    setCommentMode(m);
    setFocusThread(null);
    // carry the open state across so switching doesn't hide what you were reading
    if (m === "panel") {
      if (openThreads.size > 0) setPanelOpen(true);
      putOpenThreads(new Set());
    } else {
      if (panelOpen) {
        putOpenThreads(
          new Set(
            comments.filter((c) => showResolved || !c.resolved).map((c) =>
              c.block_id
            ),
          ),
        );
      }
      setPanelOpen(false);
    }
  };
  const toggleThread = (blockId: string) => {
    const opening = !openThreads.has(blockId);
    setFocusThread(opening ? blockId : null);
    putOpenThreads((prev) => {
      const next = new Set(prev);
      if (opening) next.add(blockId);
      else next.delete(blockId);
      return next;
    });
  };
  const flashBlock = (blockId: string) => {
    document.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlash(blockId);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 1400);
  };
  useEffect(() => {
    setShowResolved(false);
    setOpenThreads(loadOpenThreads(pageId)); // restore this page's expanded threads
    setFocusThread(null);
    getPage(pageId).then((p) => {
      setPage(p);
      setComments(p.comments ?? []);
      const raw = p.content.length
        ? p.content
        : [{ type: "text", text: "", id: genId() } as Block];
      // durable ids up front so a comment made before the next edit can't orphan
      const { blocks: content, changed } = ensureIds(raw);
      setBlocks(content);
      blocksRef.current = content;
      if (changed) {
        savingRef.current++;
        updatePage(pageId, { content }).catch(() => {}).finally(() =>
          savingRef.current--
        );
      }
    }).catch(() => {});
    return () => {
      // flush a pending debounce so fast page-switches don't lose the last edit
      if (saveTimer.current !== undefined) {
        clearTimeout(saveTimer.current);
        updatePage(pageId, { content: blocksRef.current }).catch(() => {});
      }
    };
  }, [pageId]);

  const changeBlocks = (next: Block[]) => {
    setBlocks(next);
    blocksRef.current = next;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = undefined;
      savingRef.current++;
      updatePage(pageId, { content: blocksRef.current }).catch(() => {})
        .finally(() => savingRef.current--);
    }, 800);
  };

  const patch = (p: Parameters<typeof updatePage>[1]) => {
    savingRef.current++;
    return updatePage(pageId, p).then(reload).then(onChanged)
      .finally(() => savingRef.current--);
  };

  const newSubpage = () =>
    createPage({ parent_id: pageId }).then((
      r,
    ) => (onChanged(), onOpenPage(r.id)));
  const newStory = () =>
    createPage({ parent_id: pageId, kind: "story" }).then((
      r,
    ) => (onChanged(), onOpenPage(r.id)));
  const slashInsert = (kind: "subpage" | "database", replaceIdx: number) => {
    // drop the "/…" block the user was typing in, then create the target
    const next = blocks.filter((_, j) => j !== replaceIdx);
    // needs an id like every other block — a comment on an id-less block is stored
    // against "" and orphans for good once ensureIds backfills a real one
    changeBlocks(
      next.length ? next : [{ type: "text", text: "", id: genId() } as Block],
    );
    if (kind === "subpage") newSubpage();
    else {
      createUdb("Untitled").then((r) => attachUdbToPage(r.id, pageId)).then(
        () => {
          reload();
          onChanged();
        },
      );
    }
  };

  const finished = useFinishedCards(
    board.sessions.filter((s) => !statusStyle(s.status).terminal && inSubtree(s, pageId, pagesById(board.pages))),
  );
  if (!page) return <p className="p-6 text-ink-muted">Loading…</p>;
  const client = board.projects.find((c) => c.id === page.client_id);
  const isProject = page.kind === "project";
  const isStory = page.kind === "story";
  // distinct sessions linked anywhere on the page — the Activity chip's subject
  const linkedSessions = new Set((page.links ?? []).map((l) => l.session_id).filter(Boolean)).size;
  // sessions come from the polled board (not the fetch-once getPage) so they stay live.
  // subtree semantics: anything anchored to this page or any page nested under it.
  const byId = pagesById(board.pages);
  const childStoryIds = new Set(
    page.children.filter((c) => c.kind === "story").map((c) => c.id),
  );
  const subtreeSessions = board.sessions.filter((s) => inSubtree(s, pageId, byId));
  // the card whose specs are this page — off the polled board, so it stays live
  const specCard = board.sessions.find((x) => x.specs_page_id === page.id);
  // a story can't hold another one: no "Convert to user story" below a story
  let underStory = false;
  for (let a = page.parent_id ? byId.get(page.parent_id) : undefined; a; a = a.parent_id ? byId.get(a.parent_id) : undefined) {
    if (a.kind === "story") underStory = true;
  }
  // on a story, its cards' spec pages render as the cards themselves
  const specIds = new Set(isStory ? subtreeSessions.map((s) => s.specs_page_id).filter(Boolean) as string[] : []);
  // a card already shown as a chip on one of this page's todos isn't listed again
  const todoIds = new Set(blocks.flatMap((b) => (b.type === "todo" && b.id ? [b.id] : [])));
  const chipped = new Set(
    (page.links ?? []).filter((l) => l.session_id && l.block_id && todoIds.has(l.block_id)).map((l) => l.session_id),
  );
  const sessions = subtreeSessions
    .filter((s) => !chipped.has(s.id))
    .sort((a, b) =>
      (statusStyle(a.status).terminal ? 1 : 0) -
      (statusStyle(b.status).terminal ? 1 : 0)
    );
  const done = sessions.filter((s) => statusStyle(s.status).terminal).length;
  // the header's progress counts every card, chipped or not
  const doneAll = subtreeSessions.filter((s) => statusStyle(s.status).terminal).length;
  // a project's sessions come from several stories — group them under their story
  // instead of one flat list; a story only ever shows its own.
  const sessionsByStory = isProject
    ? page.children
      .filter((c) => c.kind === "story")
      .map((story) => ({
        story,
        list: sessions.filter((s) => storyOf(s, byId)?.id === story.id),
      }))
      .filter((g) => g.list.length > 0)
    : [];
  const ungroupedSessions = isProject
    ? sessions.filter((s) => !childStoryIds.has(storyOf(s, byId)?.id ?? ""))
    : sessions;
  const sessionRow = (s: Session) => <SessionRow key={s.id} s={s} onOpen={onOpenSession} />;
  const finishedCards = sessions.filter((s) => !statusStyle(s.status).terminal && finished.has(s.id));
  const shownSession = (s: Session) =>
    statusStyle(s.status).terminal === (sessionFilter === "done") && !(sessionFilter === "active" && finished.has(s.id));
  const sessionPill = (value: "active" | "done", label: string, count: number) => (
    <button
      type="button"
      onClick={() => setSessionFilter(value)}
      className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium transition-colors ${
        sessionFilter === value
          ? "bg-copper/15 text-copper"
          : "text-ink-muted hover:bg-hover hover:text-ink-soft"
      }`}
    >
      {label} {count}
    </button>
  );
  const sessionsPanel = (atTop: boolean) => (
    <div
      className={`flex flex-col gap-1 border-line-soft ${
        atTop ? "border-b pb-3" : "border-t pt-3"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span className={`mr-1 ${SECTION_LABEL}`}>
          SESSIONS
        </span>
        {sessionPill("active", "Active", sessions.length - done)}
        {sessionPill("done", "Done", done)}
      </div>
      {sessionFilter === "active" && <FinishedStrip cards={finishedCards} onOpen={onOpenSession} />}
      {sessionsByStory.filter(({ list }) => list.some(shownSession)).map(({ story, list }) => {
        const doneInStory = list.filter((s) =>
          statusStyle(s.status).terminal
        ).length;
        const shown = list.filter(shownSession);
        // a story with one card is one row: the story, then that card's repo/branch/status
        if (shown.length === 1) {
          const s = shown[0];
          const rt = repoTitle(s);
          return (
            <div
              key={story.id}
              onClick={() => onOpenSession(s.id)}
              title={s.title}
              onDoubleClick={dblOpen(() => onOpenSession(s.id, true))}
              className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-hover"
            >
              <EntityIcon icon={story.icon} fallback={pageGlyph("story", story.mark_role)} className="text-[11px] text-ink-muted" />
              <span className="shrink-0 text-[12px] font-semibold text-ink-soft">{story.title || "Untitled"}</span>
              <span className="min-w-0 truncate text-[11px] text-ink-muted">{rt.title}</span>
              <span className="flex-1" />
              {rt.repo && <RepoChip repo={rt.repo} />}
              {list.length > 1 && <span className="shrink-0 whitespace-nowrap text-[10px] text-ink-muted">{doneInStory} / {list.length}</span>}
              <StatusDot status={s.status} size={7} />
              <span className="w-[42px] text-right text-[10px] text-ink-muted/70">{statusStyle(s.status).label}</span>
            </div>
          );
        }
        return (
          <div
            key={story.id}
            className="flex flex-col gap-0.5 pt-2 first:pt-0"
          >
            <div className="flex items-center gap-2 px-1">
              <EntityIcon
                icon={story.icon}
                fallback={pageGlyph("story", story.mark_role)}
                className="text-[11px] text-ink-muted"
              />
              <span className="text-[12px] font-semibold text-ink-soft">
                {story.title || "Untitled"}
              </span>
              <ProgressBar value={doneInStory / list.length} color="bg-copper" className="w-[60px]" />
              <span className="text-[10px] text-ink-muted">
                {doneInStory} / {list.length}
              </span>
            </div>
            <div className="flex flex-col pl-1">
              {shown.map(sessionRow)}
            </div>
          </div>
        );
      })}
      {ungroupedSessions.filter(shownSession).map(sessionRow)}
      {!sessions.some(shownSession) && (
        <span className="py-1 text-[11.5px] text-ink-muted">
          {sessions.length === 0 ? "no sessions yet" : `no ${sessionFilter} sessions`}
        </span>
      )}
    </div>
  );
  // a project lists its user stories with open cards first, those cards nested under them
  const openOf = (list: Session[]) =>
    filterSessions(list.filter((s) => !statusStyle(s.status).terminal && !finished.has(s.id)), board, cardQuery);
  const lastTouch = (list: Session[]) => list.reduce((m, s) => (s.last_touched > m ? s.last_touched : m), "");
  // priority = the most urgent `pN` tag on a card (its story's tags included); untagged last
  const prio = (list: Session[]) => tagPriority(list.flatMap((s) => sessionTagKeys(s, byId))) ?? Infinity;
  const byPrio = (list: Session[]) =>
    storyOrder === "priority" ? [...list].sort((a, b) => prio([a]) - prio([b])) : list;
  const inProgress = sessionsByStory
    .map((g) => ({ ...g, open: byPrio(openOf(g.list)) }))
    .filter((g) => g.open.length > 0)
    .sort((a, b) =>
      (storyOrder === "priority" ? prio(a.open) - prio(b.open) : 0) ||
      lastTouch(b.open).localeCompare(lastTouch(a.open))
    );
  const looseOpen = byPrio(openOf(ungroupedSessions));
  const storiesInSessions = new Set(inProgress.map(({ story }) => story.id));
  const FOLD = 3;
  const inProgressBlock = isProject && (
    <>
      <FinishedStrip cards={finishedCards} onOpen={onOpenSession} />
      {(inProgress.length > 0 || cardQuery) && (
        <div className="flex items-center gap-3">
          <span className={`shrink-0 px-1.5 ${SECTION_LABEL}`}>
            IN PROGRESS <span className="font-normal text-ink-faint">· {inProgress.length}</span>
            <button
              type="button"
              title="order stories by last activity or by priority tag (p1, p2…)"
              onClick={() => {
                const next = storyOrder === "priority" ? "touched" : "priority";
                setStoryOrder(next);
              }}
              className="ml-2 font-normal tracking-normal text-ink-faint hover:text-ink-soft"
            >
              {storyOrder === "priority" ? "by priority" : "by activity"}
            </button>
          </span>
          <QueryBox query={cardQuery} onQuery={setCardQuery} onClear={() => setCardQuery("")} />
        </div>
      )}
      {inProgress.map(({ story, list, open }) => {
        const doneN = list.filter((s) => statusStyle(s.status).terminal).length;
        const unfolded = unfoldedStories.has(story.id);
        return (
          <div key={story.id} className="flex flex-col">
            <button
              type="button"
              onClick={() => onOpenPage(story.id)}
              className="flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] font-medium text-ink hover:bg-panel"
            >
              <EntityIcon icon={story.icon} fallback={pageGlyph("story", story.mark_role)} className="text-ink-muted" />
              <span className="min-w-0 truncate">{story.title || "Untitled"}</span>
              <TagChips keys={story.tags} />
              <span className="flex-1" />
              <ProgressBar value={doneN / list.length} color="bg-active" className="w-[60px] shrink-0" />
              <span className="w-[56px] shrink-0 text-right text-[10.5px] font-normal text-ink-muted">
                {doneN} / {list.length}
              </span>
            </button>
            <div className="ml-[22px] flex flex-col border-l border-line-soft pl-2">
              {(unfolded ? open : open.slice(0, FOLD)).map(sessionRow)}
              {open.length > FOLD && (
                <button
                  type="button"
                  onClick={() =>
                    setUnfoldedStories((prev) => {
                      const next = new Set(prev);
                      if (!next.delete(story.id)) next.add(story.id);
                      return next;
                    })}
                  className="self-start px-1 py-0.5 text-[11px] text-ink-muted hover:text-ink-soft"
                >
                  {unfolded ? "▾ fewer" : `▸ ${open.length - FOLD} more`}
                </button>
              )}
            </div>
          </div>
        );
      })}
      {looseOpen.length > 0 && (
        <div className="flex flex-col">
          <span className={`mt-2 px-1.5 ${SECTION_LABEL}`}>
            NO USER STORY <span className="font-normal text-ink-faint">· {looseOpen.length}</span>
          </span>
          <div className="ml-[22px] flex flex-col pl-2">{looseOpen.map(sessionRow)}</div>
        </div>
      )}
    </>
  );
  const childRow = (c: PageChild, hideTag: string | null = null) => (
    <PageRow key={c.id} c={c} hideTag={hideTag} live={liveAgentsAll} onOpen={onOpenPage} />
  );
  const blockIds = new Set(
    blocks.filter(isText).map((b) => b.id).filter(Boolean) as string[],
  );
  const orphans = comments.filter((c) => !blockIds.has(c.block_id));
  const resolvedCount =
    comments.filter((c) => c.resolved && blockIds.has(c.block_id)).length;
  const openCount =
    comments.filter((c) => !c.resolved && blockIds.has(c.block_id)).length;
  const commentedIds = [
    ...new Set(
      comments.filter((c) =>
        blockIds.has(c.block_id) && (showResolved || !c.resolved)
      ).map((c) => c.block_id),
    ),
  ];
  const allOpen = commentedIds.length > 0 &&
    commentedIds.every((id) => openThreads.has(id));
  // panel threads follow block order so the list reads like the page
  const panelThreads = blocks.filter(isText).flatMap((b) => {
    if (!b.id) return [];
    const list = comments.filter((c) =>
      c.block_id === b.id && (showResolved || !c.resolved)
    );
    return list.length ? [{ block: b, list }] : [];
  });

  return (
    <div
      className="flex min-h-0 flex-1"
      onKeyDown={onPageKeyDown}
      onMouseDown={() => setPageSelected(false)}
    >
      <div className="@container min-h-0 flex-1 overflow-y-auto">
        <div
          className={`mx-auto flex max-w-[820px] flex-col gap-4 px-8 py-7 ${
            pageSelected
              ? "rounded-lg bg-copper/[0.07] ring-1 ring-copper/25"
              : ""
          }`}
        >
          {isStory && (
            <span className={`-mb-3 ${SECTION_LABEL}`}>
              {markRoleOf(page.content ?? []) === "ticket" ? "TICKET" : "USER STORY"}
            </span>
          )}
          <div className="flex items-center gap-2">
            <div className="relative">
              <button
                type="button"
                className={`rounded-md p-1 leading-none transition-colors hover:bg-panel ${
                  isProject ? "text-[30px]" : "text-[22px]"
                }`}
                title="page icon"
                onClick={() => setIconOpen(true)}
              >
                <EntityIcon
                  icon={page.icon}
                  fallback={pageGlyph(
                    page.kind,
                    markRoleOf(page.content ?? []),
                  )}
                  className={page.icon ? "" : "text-ink-muted"}
                  size={isProject ? 32 : 22}
                />
              </button>
              {iconOpen && (
                <IconPicker
                  current={page.icon}
                  onPick={(icon) => patch({ icon })}
                  onClose={() => setIconOpen(false)}
                />
              )}
            </div>
            <input
              key={page.id + page.title}
              className="w-full border-none bg-transparent text-[22px] font-semibold text-ink outline-none placeholder:text-ink-muted/40"
              defaultValue={page.title}
              placeholder="Untitled"
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== page.title) patch({ title: v });
              }}
              onKeyDown={(e) =>
                e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
            {linkedSessions > 0 && <PageActivityChip pageId={page.id} sessions={linkedSessions} />}
            {specCard && (
              <button
                type="button"
                title="Open the session this page is the specs of"
                className="shrink-0 rounded-md border border-copper/40 bg-copper/[0.06] px-2 py-0.5 text-[11.5px] text-copper transition-colors hover:border-copper/60 hover:bg-copper/10"
                onClick={() => onOpenSession(specCard.id, true)}
              >
                ▦ Open session ↗
              </button>
            )}
            {isProject && (
              <div className="relative shrink-0">
                <button
                  type="button"
                  title="project color"
                  className="h-5 w-5 rounded-md border border-chipline"
                  style={{ background: page.color ?? "var(--color-chipline)" }}
                  onClick={() => setColorOpen((o) => !o)}
                />
                {colorOpen && (
                  <Popover
                    onClose={() => setColorOpen(false)}
                    className="right-0 left-auto flex w-auto gap-1.5 p-2"
                  >
                    {PROJECT_COLORS.map((c) => (
                      <button
                        type="button"
                        key={c}
                        className={`h-5 w-5 rounded-md ${
                          page.color === c
                            ? "ring-2 ring-ink ring-offset-1 ring-offset-panel-modal"
                            : ""
                        }`}
                        style={{ background: c }}
                        onClick={() => {
                          patch({ color: c });
                          setColorOpen(false);
                        }}
                      />
                    ))}
                  </Popover>
                )}
              </div>
            )}
            <div className="flex shrink-0 items-center gap-1.5 pl-1">
              {(() => {
                // agents with comments on this page but no live watcher heartbeat;
                // watcher ids are watcher:<agent> or watcher:<agent>:<page> (scoped),
                // and presence already filters scoped ones to this page
                const watching = new Set(
                  presence.filter((p) => p.kind === "watcher").map((p) =>
                    p.id.split(":")[1]
                  ),
                );
                const startable = new Map<string, PageComment>();
                for (const c of comments) {
                  const id = c.author.trim().toLowerCase();
                  if (isAgent(c) && id && !watching.has(id)) {
                    startable.set(id, c);
                  }
                }
                return startable.size > 0 && (
                  <div className="flex items-center">
                    {[...startable].map(([id, c]) => (
                      <StartWatcherButton
                        key={id}
                        agent={id}
                        name={c.author}
                        avatar={c.author_avatar}
                        pageId={pageId}
                      />
                    ))}
                  </div>
                );
              })()}
              <PresenceBar people={presence} />
            </div>
          </div>

          {(() => {
            const created = uuid7Time(page.id);
            const canConvert = !isProject && !isStory && !specCard;
            const item =
              "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12.5px] text-ink-soft hover:bg-panel";
            return (
              <div className="-mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[11px] text-ink-muted/70">
                {created && (
                  <span title={created.toLocaleString()}>
                    Created {created.toLocaleDateString(undefined, {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </span>
                )}
                {created && <span>·</span>}
                <span title={new Date(page.updated_at).toLocaleString()}>
                  Updated {timeAgo(page.updated_at)}
                </span>
                <span className="mx-1 h-3 w-px bg-line" />
                <TagEditor
                  tags={page.tags ?? []}
                  onChange={(tags) => patch({ tags })}
                />
                <span className="flex-1" />
                {/* rarely-used page actions, out of the metadata line */}
                <div className="relative">
                  <button
                    type="button"
                    title="More page actions"
                    aria-label="More page actions"
                    aria-haspopup="menu"
                    aria-expanded={headerMenu}
                    className="rounded-md px-1.5 py-0.5 text-[15px] leading-none text-ink-muted hover:bg-panel hover:text-ink-soft"
                    onClick={() => setHeaderMenu((v) => !v)}
                  >
                    ⋯
                  </button>
                  {headerMenu && (
                    <Popover onClose={() => setHeaderMenu(false)} className="!left-auto right-0 w-[230px]">
                      <button
                        type="button"
                        className={item}
                        onClick={() => {
                          navigator.clipboard?.writeText(page.id).then(() => {
                            setIdCopied(true);
                            setTimeout(() => setIdCopied(false), 1500);
                          }).catch(() => {});
                        }}
                      >
                        ⧉ {idCopied ? "Copied ✓" : "Copy page id"}
                      </button>
                      <button
                        type="button"
                        className={item}
                        onClick={() => {
                          setHeaderMenu(false);
                          setMdOpen(true);
                        }}
                      >
                        ⌘ Show as Markdown
                      </button>
                      {canConvert && (
                        <button
                          type="button"
                          className={item}
                          title="Track this page as a session — the page becomes the card's specs"
                          onClick={() => {
                            setHeaderMenu(false);
                            pageToSession(page.id)
                              .then((r) => {
                                onChanged(); // the drawer renders only once the board has the card
                                onOpenSession(r.id, true);
                              })
                              .catch((e: Error) => appConfirm(e.message, "OK"));
                          }}
                        >
                          ▦ Convert to session
                        </button>
                      )}
                      {canConvert && page.kind === "page" && !underStory && (
                        <button
                          type="button"
                          className={item}
                          title="Make this page a user story under its project — cards will attach to it"
                          onClick={() => {
                            setHeaderMenu(false);
                            pageToStory(page.id)
                              .then(() => {
                                onChanged();
                                getPage(page.id).then(setPage);
                              })
                              .catch((e: Error) => appConfirm(e.message, "OK"));
                          }}
                        >
                          <EntityIcon icon={null} fallback="◇" /> Convert to user story
                        </button>
                      )}
                    </Popover>
                  )}
                </div>
              </div>
            );
          })()}

          {mdOpen && (
            <div
              className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 pt-[10vh]"
              onClick={() => setMdOpen(false)}
            >
              <div
                className="flex max-h-[76vh] w-[min(760px,90vw)] flex-col gap-3 overflow-hidden rounded-xl border border-overlay-border bg-panel-modal p-5 shadow-2xl shadow-black/50"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-medium tracking-[0.8px] text-ink-muted/80">
                    MARKDOWN
                  </span>
                  <span className="flex-1" />
                  <button
                    type="button"
                    className={`rounded-md border border-line-soft px-2 py-0.5 text-[11px] transition-colors ${
                      mdCopied ? "border-copper/50 text-copper" : "text-ink-muted hover:bg-panel hover:text-ink-soft"
                    }`}
                    onClick={() => {
                      navigator.clipboard
                        ?.writeText(blocksToMarkdown(page.title, blocksRef.current))
                        .then(() => {
                          setMdCopied(true);
                          setTimeout(() => setMdCopied(false), 1500);
                        }).catch(() => {});
                    }}
                  >
                    {mdCopied ? "copied ✓" : "copy"}
                  </button>
                  <IconButton tone="close" className="rounded-md px-1.5 py-0.5 text-[13px] transition-colors hover:bg-panel"
                    title="close"
                    onClick={() => setMdOpen(false)}
                  >
                    ✕
                  </IconButton>
                </div>
                <pre className="overflow-auto whitespace-pre-wrap rounded-md border border-line-soft bg-panel px-3 py-2 font-mono text-[12px] leading-relaxed text-ink">
                  {blocksToMarkdown(page.title, blocksRef.current)}
                </pre>
              </div>
            </div>
          )}

          {isStory && (
            <div className="flex items-center gap-3">
              <div className="w-[120px]">
                {(() => {
                  const def = PAGE_STATUSES.find((s) => s.value === page.status);
                  return (
                    <Select
                      value={page.status}
                      className="rounded-md px-2.5 py-1.5 text-xs font-medium outline-none"
                      triggerStyle={def
                        ? { background: `color-mix(in srgb, ${def.color} 13%, transparent)`, color: def.color }
                        : undefined}
                      options={PAGE_STATUSES.map((s) => ({ value: s.value, label: s.label, dot: s.color }))}
                      onChange={(status) => patch({ status })}
                    />
                  );
                })()}
              </div>
              {client && (
                <ClientChip
                  name={client.name}
                  color={client.color}
                  onClick={() => onOpenClient(client.id)}
                />
              )}
              {subtreeSessions.length > 0 && (
                <>
                  <div className="h-[5px] w-[140px] overflow-hidden rounded-full bg-line">
                    <div
                      className="h-full rounded-full bg-copper"
                      style={{ width: `${(doneAll / subtreeSessions.length) * 100}%` }}
                    />
                  </div>
                  <span className="text-[11.5px] font-medium text-ink-muted">
                    {doneAll} / {subtreeSessions.length} done
                  </span>
                </>
              )}
            </div>
          )}

          {isStory && (
            <textarea
              key={page.id + page.brief}
              rows={2}
              className="resize-none rounded-md border border-transparent bg-transparent px-2 py-1.5 text-xs leading-relaxed text-ink-soft outline-none transition-colors placeholder:italic placeholder:text-ink-muted/50 hover:bg-well focus:border-chipline focus:bg-well"
              defaultValue={page.brief}
              placeholder="add the brief — what are we trying to achieve? (click to edit)"
              onBlur={(e) => {
                if (e.target.value !== page.brief) {
                  patch({ brief: e.target.value });
                }
              }}
            />
          )}

          {/* Below the brief, because the brief becomes the ticket's
              objective: the offer sits next to the text it will send. */}
          {FRONTEND_PLUGINS.map((p) => p.PageHeader && <p.PageHeader key={p.id} page={page} onDone={() => reload()} />)}

          {/* a story's cards show as agents on its sub-pages and chips on todos */}
          {!isStory && !isProject && sessions.length > 0 && sessionsPanel(true)}
          {isStory && subtreeSessions.length > 0 && (
            <div className="flex flex-col gap-0.5 border-b border-line-soft pb-3">
              <span className={`mb-1 ${SECTION_LABEL}`}>CARDS</span>
              {/* open cards first; done ones fold behind a toggle so a long-lived story stays readable */}
              {[
                ...subtreeSessions.filter((s) => !statusStyle(s.status).terminal),
                ...(showDoneCards ? subtreeSessions.filter((s) => statusStyle(s.status).terminal) : []),
              ].map((s) => {
                const spec = page.children.find((c) => c.id === s.specs_page_id);
                const agents = liveAgentsAll.filter(({ a }) =>
                  a.session_id === s.id || (!!s.specs_page_id && a.page_id === s.specs_page_id)
                );
                const done = statusStyle(s.status).terminal;
                return (
                  <div
                    key={s.id}
                    title="open the session"
                    // the full session view: its specs, worklog and links in one place
                    onClick={() => onOpenSession(s.id, true)}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[13px] hover:bg-panel"
                  >
                    <StatusDot status={s.status} size={7} />
                    {spec?.icon && <EntityIcon icon={spec.icon} className="text-[13px]" />}
                    <span className={done ? "text-ink-muted line-through decoration-ink-faint" : "text-ink-soft"}>
                      {s.title}
                    </span>
                    {FRONTEND_PLUGINS.map((p) => p.CardBadge && <p.CardBadge key={p.id} sessionId={s.id} />)}
                    {(() => {
                      // the session working this card, by its own name (live or recently seen)
                      const name = recentAgents.find((a) => a.session_id === s.id && a.name)?.name;
                      return name && <span className="font-mono text-[11px] text-ink-faint">{name}</span>;
                    })()}
                    {/* the card's tags and its spec page's */}
                    {(() => {
                      const keys = [...new Set([...(s.tags ?? []), ...(spec?.tags ?? [])])];
                      return keys.length > 0 && <TagChips keys={keys} />;
                    })()}
                    <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                      {agents.map((l) => <LiveAgentChip key={l.a.session_id} {...l} />)}
                      {!!spec?.todos && <TodoBar done={spec.todos_done ?? 0} total={spec.todos} />}
                      <span className="w-[64px] text-right text-[10.5px] text-ink-muted/70">
                        {statusStyle(s.status).label}
                      </span>
                    </span>
                  </div>
                );
              })}
              {subtreeSessions.some((s) => statusStyle(s.status).terminal) && (
                <button
                  type="button"
                  onClick={() => setShowDoneCards((v) => !v)}
                  className="self-start rounded-md px-1.5 py-1 text-[11.5px] text-ink-muted hover:text-ink-soft"
                >
                  {showDoneCards ? "▾ Hide" : "▸"} {subtreeSessions.filter((s) => statusStyle(s.status).terminal).length} done
                </button>
              )}
            </div>
          )}

          {(openCount > 0 || resolvedCount > 0) && (
            <div className="-mb-2 flex items-center gap-3 self-start">
              {commentMode === "inline"
                ? (
                  <button
                    type="button"
                    className="text-[11px] text-ink-muted/70 transition-colors hover:text-ink-soft"
                    onClick={() => {
                      setFocusThread(null);
                      putOpenThreads(
                        allOpen ? new Set() : new Set(commentedIds),
                      );
                    }}
                  >
                    {allOpen ? "Close" : "Open"} all {openCount}{" "}
                    comment{openCount > 1 ? "s" : ""}
                  </button>
                )
                : (
                  <button
                    type="button"
                    className="text-[11px] text-ink-muted/70 transition-colors hover:text-ink-soft"
                    onClick={() => setPanelOpen((v) => !v)}
                  >
                    {panelOpen ? "Hide" : "Show"} comments panel ({openCount})
                  </button>
                )}
              {resolvedCount > 0 && (
                <button
                  type="button"
                  className="text-[11px] text-ink-muted/70 transition-colors hover:text-ink-soft"
                  onClick={() => {
                    const next = !showResolved;
                    setShowResolved(next);
                    // inline mode: reveal AND expand the threads holding resolved notes
                    if (next && commentMode === "inline") {
                      setFocusThread(null);
                      putOpenThreads((prev) => {
                        const n = new Set(prev);
                        for (const c of comments) {
                          if (c.resolved && blockIds.has(c.block_id)) {
                            n.add(c.block_id);
                          }
                        }
                        return n;
                      });
                    }
                  }}
                >
                  {showResolved ? "Hide" : "Show"} {resolvedCount}{" "}
                  resolved comment{resolvedCount > 1 ? "s" : ""}
                </button>
              )}
              <div className="flex overflow-hidden rounded-md border border-line-soft text-[10.5px]">
                {(["inline", "panel"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`px-2 py-0.5 capitalize transition-colors ${
                      commentMode === m
                        ? "bg-panel text-ink-soft"
                        : "text-ink-muted/60 hover:text-ink-soft"
                    }`}
                    onClick={() => setMode(m)}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
          )}

          <BlockEditor
            blocks={blocks}
            onChange={changeBlocks}
            links={page?.links ?? []}
            onOpenSession={onOpenSession}
            onLinkItem={(blockId, item) => setLinkPick({ blockId, item })}
            onSlashInsert={slashInsert}
            onOpenReport={onOpenReport}
            comments={comments}
            commentOps={commentOps}
            showResolved={showResolved}
            mode={commentMode}
            openThreads={openThreads}
            focusThread={focusThread}
            flash={flash ?? focused}
            meId={meId}
            onToggleThread={toggleThread}
          />

          {linkPick && (
            <div
              className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[18vh]"
              onClick={() => setLinkPick(null)}
            >
              <div
                className="w-[440px] rounded-xl border border-line bg-panel-modal p-3 shadow-2xl shadow-black/50"
                onClick={(e) => e.stopPropagation()}
              >
                <div className={`mb-1.5 ${SECTION_LABEL}`}>
                  LINK TO SESSION
                </div>
                <div
                  className="mb-2 truncate rounded-md bg-panel px-2 py-1 text-[11.5px] text-ink-muted"
                  title={linkPick.item}
                >
                  {linkPick.item}
                </div>
                <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
                  {[...board.sessions]
                    .sort((a, b) =>
                      (statusStyle(a.status).terminal ? 1 : 0) -
                      (statusStyle(b.status).terminal ? 1 : 0)
                    )
                    .map((sn) => (
                      <button
                        key={sn.id}
                        type="button"
                        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-ink-soft hover:bg-panel"
                        onClick={() => {
                          addSessionLink(sn.id, {
                            page_id: pageId,
                            block_id: linkPick.blockId,
                            anchor: linkPick.item,
                          }).then(() => {
                            setLinkPick(null);
                            reload();
                          });
                        }}
                      >
                        <span
                          className="h-[7px] w-[7px] shrink-0 rounded-full"
                          style={{ background: statusStyle(sn.status).color }}
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {sn.title}
                        </span>
                        {sn.branch && (
                          <span className="shrink-0 font-mono text-[10px] text-ink-muted">
                            {sn.branch}
                          </span>
                        )}
                      </button>
                    ))}
                </div>
              </div>
            </div>
          )}

          {orphans.length > 0 && (
            <div className="flex flex-col gap-2 rounded-lg border border-line-soft bg-panel/30 p-3">
              <span className={`${SECTION_LABEL}`}>
                COMMENTS ON REMOVED TEXT
              </span>
              {orphans.map((c) => (
                <div key={c.id} className="flex flex-col gap-1">
                  {c.anchor && (
                    <span className="truncate border-l-2 border-line pl-2 text-[11px] italic text-ink-muted/70">
                      “{c.anchor}”
                    </span>
                  )}
                  <CommentItem
                    c={c}
                    canEdit={Boolean(meId) && c.author_id === meId}
                    onUpdate={(patch) =>
                      commentOps.update(c.id, patch)}
                    onDelete={() =>
                      commentOps.remove(c.id)}
                  />
                </div>
              ))}
            </div>
          )}

          {page.databases.map((d) => (
            // breakout: attached databases use the pane's width (100cqw minus the
            // px-8 gutters), not the 820px text column
            <div
              key={d.id}
              className="relative left-1/2 flex w-[min(1400px,100cqw_-_4rem)] -translate-x-1/2 flex-col gap-1"
            >
              <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink">
                <EntityIcon
                  icon={d.icon}
                  fallback="⌗"
                  className="text-ink-muted"
                />
                {d.name}
              </div>
              <DatabaseView dbId={d.id} epoch={0} udbs={udbs} />
            </div>
          ))}

          <div className="flex flex-col gap-0.5">
            {isStory && page.children.some((c) => !specIds.has(c.id)) && (
              <span className={`mb-1 ${SECTION_LABEL}`}>DOCUMENTS</span>
            )}
            {isProject
              ? <ProjectChildren pages={page.children} shown={storiesInSessions} row={childRow} top={inProgressBlock} />
              : (() => {
                const docs = page.children.filter((c) => !specIds.has(c.id));
                const archived = docs.filter((c) => c.status === "archived");
                return (
                  <>
                    {docs.filter((c) => c.status !== "archived").map((c) => childRow(c))}
                    {showArchivedDocs && archived.map((c) => childRow(c))}
                    {archived.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setShowArchivedDocs((v) => !v)}
                        className="self-start rounded-md px-1.5 py-1 text-[11.5px] text-ink-muted hover:text-ink-soft"
                      >
                        {showArchivedDocs ? "▾ Hide" : "▸"} {archived.length} archived
                      </button>
                    )}
                  </>
                );
              })()}
            <button
              type="button"
              className="flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] text-ink-muted/70 hover:text-ink-soft"
              onClick={isProject ? newStory : newSubpage}
            >
              <span className="text-[11px]">＋</span>{" "}
              {isProject ? "New story" : "New sub-page"}
            </button>
          </div>

        </div>
      </div>
      {commentMode === "panel" && panelOpen && (
        <aside className="flex w-[320px] shrink-0 flex-col border-l border-line bg-sidebar">
          <div className="flex items-center gap-2 border-b border-line-soft px-3.5 py-2.5">
            <span className="text-[12px] font-semibold text-ink">Comments</span>
            <span className="text-[10.5px] text-ink-muted">
              {openCount} open
            </span>
            <span className="flex-1" />
            {resolvedCount > 0 && (
              <button
                type="button"
                className="text-[10.5px] text-ink-muted/70 transition-colors hover:text-ink-soft"
                onClick={() => setShowResolved((v) => !v)}
              >
                {showResolved ? "hide" : "show"} resolved
              </button>
            )}
            <button
              type="button"
              title="close"
              className="text-[11px] text-ink-muted transition-colors hover:text-ink-soft"
              onClick={() => setPanelOpen(false)}
            >
              ✕
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
            {panelThreads.map(({ block, list }) => (
              <div key={block.id} className="flex flex-col gap-1.5">
                <button
                  type="button"
                  title="jump to text"
                  className="truncate border-l-2 border-chipline pl-2 text-left text-[11px] italic text-ink-muted/70 transition-colors hover:text-ink-soft"
                  onClick={() =>
                    flashBlock(block.id as string)}
                >
                  “{block.text || "…"}”
                </button>
                {list.map((c) => {
                  const q = anchorQuoteOf(c, block.text);
                  return (
                    <div key={c.id} className="flex flex-col gap-1">
                      {q && <RowNote label={q.label} text={q.text} />}
                      <CommentItem
                        c={c}
                        canEdit={Boolean(meId) && c.author_id === meId}
                        answered={answeredIn(c, list)}
                        onUpdate={(patch) =>
                          commentOps.update(c.id, patch)}
                        onDelete={() =>
                          commentOps.remove(c.id)}
                      />
                    </div>
                  );
                })}
                <AddNote
                  onAdd={(body) =>
                    commentOps.add(block.id as string, block.text, body)}
                />
              </div>
            ))}
            {panelThreads.length === 0 && (
              <span className="px-1 text-[11px] text-ink-muted/60">
                No comments
              </span>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

// Header-level delete used by App (kept here so the confirm copy lives with the page code).
export async function confirmDeletePage(
  page: { id: string; title: string },
): Promise<boolean> {
  const ok = await appConfirm(
    `Delete "${
      page.title || "Untitled"
    }" and everything inside it (sub-pages and attached databases)?`,
  );
  if (ok) await deletePage(page.id);
  return ok;
}
