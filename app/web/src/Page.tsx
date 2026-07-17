import { Fragment, useEffect, useRef, useState } from "react";
import {
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
  type Presence,
  pingPresence,
  type PageComment,
  type PageDetail,
  type UdbMeta,
  updateComment,
  updatePage,
} from "./api";
import { appConfirm, ClientChip, EntityIcon, Popover, Select, statusStyle, StatusDot, timeAgo } from "./ui";

// Stable block id so a comment survives edits/reorders of the surrounding text.
const genId = () => crypto.randomUUID().slice(0, 8);
const isTextType = (t: Block["type"]) => t === "text" || t === "heading" || t === "todo";
// Backfill ids on text blocks that predate them; `changed` tells the caller to persist.
function ensureIds(blocks: Block[]): { blocks: Block[]; changed: boolean } {
  let changed = false;
  const out = blocks.map((b) => {
    if (isTextType(b.type) && !("id" in b && b.id)) {
      changed = true;
      return { ...b, id: genId() } as Block;
    }
    return b;
  });
  return { blocks: out, changed };
}
import { IconPicker } from "./udb/cells";
import { DatabaseView } from "./udb/DatabaseTable";
import { FolderBlock } from "./FolderBlock";

// project chip palette (matches the client palette + a few extras)
const PROJECT_COLORS = ["#7a9ee7", "#b590e7", "#c98a63", "#7bd88f", "#e3c567", "#e06c75", "#56b6c2", "#8b93a3"];

const PAGE_STATUS = [
  { value: "open", label: "Open" },
  { value: "done", label: "Done" },
  { value: "archived", label: "Archived" },
];

type TextBlock = Extract<Block, { type: "text" | "heading" | "todo" }>;
const isText = (b: Block): b is TextBlock => b.type === "text" || b.type === "heading" || b.type === "todo";

const SLASH: { key: string; label: string; hint: string }[] = [
  { key: "text", label: "Text", hint: "plain paragraph" },
  { key: "heading", label: "Heading", hint: "section title" },
  { key: "todo", label: "To-do", hint: "checkbox item" },
  { key: "subpage", label: "Sub-page", hint: "nest a page here" },
  { key: "database", label: "Database", hint: "table on this page" },
  { key: "folder", label: "Folder", hint: "live files from a directory" },
];

type CommentOps = {
  add: (blockId: string, anchor: string, body: string) => void;
  update: (id: string, patch: { body?: string; resolved?: boolean }) => void;
  remove: (id: string) => void;
};

// "inline": threads expand under their block (GitHub-PR style).
// "panel": threads live in a right-side panel; bubbles open a quick popover.
type CommentMode = "inline" | "panel";
const COMMENT_MODE_KEY = "trame-comment-mode";
const PANEL_OPEN_KEY = "trame-comments-panel-open";
// which inline threads are expanded — persisted per page so a refresh keeps them open
const openKey = (pageId: string) => `trame-open-threads:${pageId}`;
const loadOpenThreads = (pageId: string): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(openKey(pageId)) || "[]"));
  } catch {
    return new Set();
  }
};

// Stable per-author tint so replies from different people read apart at a glance.
const authorColor = (name: string) =>
  PROJECT_COLORS[[...name].reduce((a, ch) => a + ch.charCodeAt(0), 0) % PROJECT_COLORS.length];

// mirrors AGENT_AUTHOR_ID in app/agent-comments.ts — agent-authored comments
const AGENT_AUTHOR_ID = "00000000-0000-4000-8000-0000000000aa";
const isAgent = (c: PageComment) => c.author_id === AGENT_AUTHOR_ID;
// a reply is answered once a newer agent comment sits on the same block
const answeredIn = (c: PageComment, blockComments: PageComment[]) =>
  blockComments.some((o) => isAgent(o) && o.updated_at > c.updated_at);

// Badges describe what the AGENT is doing about this human reply — the agent's name
// is in the label so it never reads as if the human author is the one acting.
const AGENT_BADGE = {
  seen: { verb: (a: string) => `${a} saw this`, cls: "text-ink-muted", pulse: false },
  answering: { verb: (a: string) => `${a} is answering…`, cls: "text-copper", pulse: true },
  failed: { verb: (a: string) => `${a} couldn't answer`, cls: "text-blocked/80", pulse: false },
} as const;
const cap = (s: string) => s ? s[0].toUpperCase() + s.slice(1) : "An agent";

// A dim one-line footer for an agent answer: "haiku · 1.2k→340 tok · 4.3s".
function formatMeta(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as { model?: string; in?: number; out?: number; ms?: number };
    const model = (m.model ?? "").replace(/^claude-/, "").replace(/(-[\d.]+)+$/, "");
    const tok = (n?: number) => n == null ? "?" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
    const parts = [];
    if (model) parts.push(model);
    if (m.in != null || m.out != null) parts.push(`${tok(m.in)}→${tok(m.out)} tok`);
    if (m.ms != null) parts.push(`${(m.ms / 1000).toFixed(1)}s`);
    return parts.join(" · ") || null;
  } catch {
    return null;
  }
}

function CommentItem(
  { c, canEdit, answered, onUpdate, onDelete }: {
    c: PageComment;
    canEdit: boolean; // body editing is the author's alone; resolve/delete stay open
    answered?: boolean; // a newer agent comment exists — hide any stale watcher badge
    onUpdate: (patch: { body?: string; resolved?: boolean }) => void;
    onDelete: () => void;
  },
) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.body);
  const tint = authorColor(c.author || "?");
  const grow = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "0";
    el.style.height = `${el.scrollHeight}px`;
  };
  return (
    <div
      className={`rounded-md border border-line-soft bg-panel/50 p-2 ${c.resolved ? "opacity-55" : ""}`}
      style={{ borderLeft: `2px solid ${tint}66` }}
    >
      <div className="mb-1 flex items-center gap-1.5">
        {c.author_avatar && (
          <img
            src={c.author_avatar}
            alt=""
            className="h-4 w-4 shrink-0 rounded-full object-cover"
          />
        )}
        {c.author && <span className="text-[10.5px] font-medium" style={{ color: tint }}>{c.author}</span>}
        <span className="text-[10px] text-ink-muted">{timeAgo(c.updated_at)}</span>
        {c.resolved && <span className="text-[9px] uppercase tracking-[0.5px] text-active">resolved</span>}
        {c.agent_status && !answered && !c.resolved && !isAgent(c) && (
          <span
            className={`flex items-center gap-0.5 rounded-full bg-panel px-1.5 py-px text-[9px] ${
              AGENT_BADGE[c.agent_status].cls
            } ${AGENT_BADGE[c.agent_status].pulse ? "animate-pulse" : ""}`}
          >
            {c.agent_status === "answering" ? "⟳" : c.agent_status === "seen" ? "✓" : "⚠"}
            {AGENT_BADGE[c.agent_status].verb(cap(c.agent_status_agent))}
          </span>
        )}
        <span className="flex-1" />
        <button type="button" title={c.resolved ? "reopen" : "resolve"} onClick={() => onUpdate({ resolved: !c.resolved })}
          className="text-[12px] text-ink-muted transition-colors hover:text-active"
        >
          {c.resolved ? "↺" : "✓"}
        </button>
        <button type="button" title="delete" onClick={onDelete}
          className="text-[11px] text-ink-muted transition-colors hover:text-blocked"
        >
          ✕
        </button>
      </div>
      {editing
        ? (
          <textarea
            autoFocus
            rows={1}
            ref={grow}
            value={draft}
            className="w-full resize-none overflow-hidden rounded bg-[#101219] p-1.5 text-[12px] leading-snug text-ink outline-none"
            onChange={(e) => {
              setDraft(e.target.value);
              grow(e.target);
            }}
            onBlur={() => {
              setEditing(false);
              const v = draft.trim();
              if (v && v !== c.body) onUpdate({ body: v });
              else setDraft(c.body);
            }}
          />
        )
        : (
          <div
            className={`whitespace-pre-wrap text-[12px] leading-snug text-ink-soft ${canEdit ? "cursor-text" : ""}`}
            title={canEdit ? "click to edit" : undefined}
            onClick={() => canEdit && setEditing(true)}
          >
            {c.body}
          </div>
        )}
      {formatMeta(c.meta) && (
        <div className="mt-1 text-[9px] tracking-[0.3px] text-ink-muted/50">{formatMeta(c.meta)}</div>
      )}
    </div>
  );
}

// Notion-style avatar stack: who's on the page + which agents are watching.
function PresenceBar({ people }: { people: Presence[] }) {
  if (people.length === 0) return null;
  // viewers first, then watchers; dedup already handled server-side by id
  const sorted = [...people].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "viewer" ? -1 : 1));
  return (
    <div className="flex items-center">
      {sorted.map((p) => (
        <div
          key={p.id}
          className="relative -ml-1.5 first:ml-0"
          title={p.kind === "watcher" ? `${p.name} is watching` : p.name}
        >
          {p.avatar
            ? (
              <img
                src={p.avatar}
                alt={p.name}
                className={`h-6 w-6 rounded-full object-cover ring-2 ring-canvas ${
                  p.kind === "watcher" ? "ring-copper/60" : ""
                }`}
              />
            )
            : (
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-chipline text-[10px] font-medium text-ink ring-2 ring-canvas">
                {p.name.slice(0, 1).toUpperCase()}
              </div>
            )}
          {p.kind === "watcher" && (
            <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-copper ring-2 ring-canvas" />
          )}
        </div>
      ))}
    </div>
  );
}

function AddNote({ onAdd, autoFocus }: { onAdd: (body: string) => void; autoFocus?: boolean }) {
  const [body, setBody] = useState("");
  return (
    <textarea
      autoFocus={autoFocus}
      rows={2}
      value={body}
      placeholder="Add a comment… ⏎"
      className="w-full resize-none rounded-md border border-chipline/70 bg-panel px-2 py-1.5 text-[12px] leading-snug text-ink outline-none placeholder:text-ink-muted/60 focus:border-copper/50"
      onChange={(e) => setBody(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          const v = body.trim();
          if (!v) return;
          onAdd(v);
          setBody("");
        }
      }}
    />
  );
}

// The margin affordance next to a block: a bubble when the block has comments,
// otherwise a hover-only "add" button. Inline mode toggles the thread under the
// block; panel mode opens a quick popover.
function CommentGutter(
  { blockId, anchor, comments, showResolved, mode, inlineOpen, onToggleInline, meId, ops }: {
    blockId: string;
    anchor: string;
    comments: PageComment[]; // already filtered to this block
    showResolved: boolean;
    mode: CommentMode;
    inlineOpen: boolean;
    onToggleInline: () => void;
    meId: string | null;
    ops: CommentOps;
  },
) {
  const [open, setOpen] = useState(false);
  const unresolved = comments.filter((c) => !c.resolved);
  const visible = showResolved ? comments : unresolved;
  const marker = unresolved.length > 0 || (showResolved && comments.length > 0);
  const active = mode === "inline" ? inlineOpen : open;
  return (
    <div className="relative">
      <button
        type="button"
        title={unresolved.length ? `${unresolved.length} comment${unresolved.length > 1 ? "s" : ""}` : "comment"}
        onClick={() => (mode === "inline" ? onToggleInline() : setOpen((v) => !v))}
        className={`flex items-center gap-0.5 rounded-md px-1 py-0.5 text-[11px] transition-opacity ${
          marker || active ? "opacity-100" : "opacity-0 group-hover:opacity-60 hover:!opacity-100"
        } ${unresolved.length ? "text-copper hover:bg-copper/10" : "text-ink-muted hover:bg-panel"}`}
      >
        💬{unresolved.length > 0 && <span className="text-[10px] font-medium">{unresolved.length}</span>}
      </button>
      {mode === "panel" && open && (
        <Popover onClose={() => setOpen(false)} className="left-auto right-0 max-h-[60vh] w-[300px] overflow-y-auto p-2">
          <div className="flex flex-col gap-2">
            {visible.map((c) => (
              <CommentItem
                key={c.id}
                c={c}
                canEdit={Boolean(meId) && c.author_id === meId}
                answered={answeredIn(c, comments)}
                onUpdate={(patch) => ops.update(c.id, patch)}
                onDelete={() => ops.remove(c.id)}
              />
            ))}
            {visible.length === 0 && <span className="px-1 text-[11px] text-ink-muted/60">No comments yet</span>}
            <AddNote autoFocus onAdd={(body) => ops.add(blockId, anchor, body)} />
          </div>
        </Popover>
      )}
    </div>
  );
}

function BlockEditor(
  { blocks, onChange, onSlashInsert, onOpenReport, comments, commentOps, showResolved, mode, openThreads, focusThread, flash, meId, onToggleThread }: {
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
  },
) {
  const refs = useRef<(HTMLTextAreaElement | null)[]>([]);
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  const [menuIdx, setMenuIdx] = useState<number | null>(null); // block showing the slash menu
  const [menuSel, setMenuSel] = useState(0); // highlighted item in the slash menu

  useEffect(() => {
    if (focusIdx === null) return;
    const el = refs.current[focusIdx];
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
    setFocusIdx(null);
  }, [focusIdx, blocks]);

  const set = (i: number, patch: Partial<TextBlock>) =>
    onChange(blocks.map((b, j) => (j === i && isText(b) ? { ...b, ...patch } : b)));
  const setBlock = (i: number, patch: Partial<Block>) =>
    onChange(blocks.map((b, j) => (j === i ? { ...b, ...patch } as Block : b)));
  const insertAfter = (i: number) => {
    const next = [...blocks.slice(0, i + 1), { type: "text", text: "", id: genId() } as Block, ...blocks.slice(i + 1)];
    onChange(next);
    setFocusIdx(i + 1);
  };
  const remove = (i: number) => {
    onChange(blocks.filter((_, j) => j !== i));
    setFocusIdx(Math.max(0, i - 1));
  };
  const pick = (i: number, key: string) => {
    setMenuIdx(null);
    if (key === "subpage" || key === "database") return onSlashInsert(key, i);
    if (key === "folder") {
      return onChange(
        blocks.map((b, j) =>
          j === i ? { type: "folder", path: "", view: "list", id: (isText(b) && b.id) || genId() } as Block : b
        ),
      );
    }
    onChange(
      blocks.map((b, j) =>
        j === i ? { type: key as TextBlock["type"], text: "", id: (isText(b) && b.id) || genId() } : b
      ),
    );
    setFocusIdx(i);
  };

  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "0";
    el.style.height = `${el.scrollHeight}px`;
  };

  return (
    <div className="flex flex-col">
      {blocks.map((b, i) => {
        if (b.type === "folder") {
          return (
            <FolderBlock
              key={b.id ?? i}
              block={b}
              onPatch={(patch) => setBlock(i, patch)}
              onRemove={() => remove(i)}
              onOpenReport={onOpenReport}
            />
          );
        }
        if (!isText(b)) {
          // database/subpage markers live in the flow but render as the page sections below
          return null;
        }
        const filter = b.text.startsWith("/") ? b.text.slice(1).toLowerCase() : null;
        const items = filter === null ? [] : SLASH.filter((s) => s.label.toLowerCase().includes(filter));
        const blockComments = b.id ? comments.filter((c) => c.block_id === b.id) : [];
        const hasOpen = blockComments.some((c) => !c.resolved);
        const visibleComments = showResolved ? blockComments : blockComments.filter((c) => !c.resolved);
        const inlineOpen = mode === "inline" && Boolean(b.id) && openThreads.has(b.id as string);
        return (
          <Fragment key={b.id ?? i}>
          <div
            data-block-id={b.id || undefined}
            className={`group relative -mx-1 flex items-start gap-2 px-1 ${
              hasOpen ? "rounded-md bg-copper/[0.05]" : ""
            } ${flash === b.id ? "rounded-md ring-1 ring-copper/50" : ""}`}
          >
            {b.type === "todo" && (
              <input
                type="checkbox"
                checked={Boolean(b.done)}
                onChange={(e) => set(i, { done: e.target.checked })}
                className="mt-[7px] h-3.5 w-3.5 accent-[#c98a63]"
              />
            )}
            <textarea
              ref={(el) => {
                refs.current[i] = el;
                if (el) grow(el);
              }}
              rows={1}
              value={b.text}
              placeholder={i === 0 && blocks.length === 1 ? "Write something, or type / for blocks…" : ""}
              className={`w-full resize-none overflow-hidden border-none bg-transparent py-1 outline-none placeholder:text-ink-muted/40 ${
                b.type === "heading"
                  ? "text-[16px] font-semibold text-ink"
                  : `text-[13px] leading-relaxed ${b.type === "todo" && b.done ? "text-ink-muted line-through" : "text-ink-soft"}`
              }`}
              onChange={(e) => {
                set(i, { text: e.target.value });
                grow(e.target);
                setMenuIdx(e.target.value.startsWith("/") ? i : null);
                setMenuSel(0);
              }}
              onKeyDown={(e) => {
                if (menuIdx === i && items.length) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    return setMenuSel((s) => (s + 1) % items.length);
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    return setMenuSel((s) => (s - 1 + items.length) % items.length);
                  }
                  if (e.key === "Enter") {
                    e.preventDefault();
                    return pick(i, items[Math.min(menuSel, items.length - 1)].key);
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    return setMenuIdx(null);
                  }
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  insertAfter(i);
                } else if (e.key === "Backspace" && b.text === "" && blocks.length > 1) {
                  e.preventDefault();
                  remove(i);
                } else if (e.key === "ArrowUp" && !e.shiftKey && i > 0) {
                  e.preventDefault();
                  setFocusIdx(i - 1);
                } else if (e.key === "ArrowDown" && !e.shiftKey && i < blocks.length - 1) {
                  e.preventDefault();
                  setFocusIdx(i + 1);
                }
              }}
            />
            {menuIdx === i && items.length > 0 && (
              <Popover onClose={() => setMenuIdx(null)} className="!top-8 w-[240px]">
                {items.map((s, si) => (
                  <button type="button"
                    key={s.key}
                    className={`flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left ${
                      si === Math.min(menuSel, items.length - 1) ? "bg-panel" : "hover:bg-panel"
                    }`}
                    onMouseMove={() => setMenuSel(si)}
                    onClick={() => pick(i, s.key)}
                  >
                    <span className="text-xs font-medium text-ink">{s.label}</span>
                    <span className="text-[10.5px] text-ink-muted">{s.hint}</span>
                  </button>
                ))}
              </Popover>
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
          {inlineOpen && (
            <div className="my-1 ml-6 flex max-w-[480px] flex-col gap-1.5 border-l-2 border-copper/40 pl-3">
              {visibleComments.map((c) => (
                <CommentItem
                  key={c.id}
                  c={c}
                  canEdit={Boolean(meId) && c.author_id === meId}
                  answered={answeredIn(c, blockComments)}
                  onUpdate={(patch) => commentOps.update(c.id, patch)}
                  onDelete={() => commentOps.remove(c.id)}
                />
              ))}
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
  { pageId, board, udbs, onOpenPage, onOpenSession, onOpenClient, onOpenReport, onChanged }: {
    pageId: string;
    board: BoardData;
    udbs: UdbMeta[];
    onOpenPage: (id: string) => void;
    onOpenSession: (id: string) => void;
    onOpenClient: (id: string) => void;
    onOpenReport: (path: string) => void;
    onChanged: () => void; // sidebar tree cares about title/icon/structure changes
  },
) {
  const [page, setPage] = useState<PageDetail | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [comments, setComments] = useState<PageComment[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [commentMode, setCommentMode] = useState<CommentMode>(
    () => (localStorage.getItem(COMMENT_MODE_KEY) === "panel" ? "panel" : "inline"),
  );
  const [openThreads, setOpenThreads] = useState<Set<string>>(() => loadOpenThreads(pageId));
  const [focusThread, setFocusThread] = useState<string | null>(null);
  const [panelOpen, setPanelOpenState] = useState(() => localStorage.getItem(PANEL_OPEN_KEY) === "1");
  const setPanelOpen = (v: boolean | ((p: boolean) => boolean)) =>
    setPanelOpenState((p) => {
      const next = typeof v === "function" ? v(p) : v;
      localStorage.setItem(PANEL_OPEN_KEY, next ? "1" : "0");
      return next;
    });
  // set + persist open threads together, keyed by the current page (no cross-page race)
  const putOpenThreads = (v: Set<string> | ((p: Set<string>) => Set<string>)) =>
    setOpenThreads((p) => {
      const next = typeof v === "function" ? v(p) : v;
      localStorage.setItem(openKey(pageId), JSON.stringify([...next]));
      return next;
    });
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);
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
  // live-refresh comments so watcher status (seen/answering) and agent replies appear
  // without a reload; only swap state when the payload actually changed (keeps
  // in-progress edits and avoids re-render churn), and pause when the tab is hidden.
  useEffect(() => {
    const tick = () => {
      if (document.hidden) return;
      listComments(pageId).then((next) =>
        setComments((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
      ).catch(() => {});
    };
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, [pageId]);
  const [iconOpen, setIconOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const saveTimer = useRef<number | undefined>(undefined);
  const blocksRef = useRef<Block[]>([]);

  const reload = () => getPage(pageId).then(setPage).catch(() => {});
  const reloadComments = () => listComments(pageId).then(setComments).catch(() => {});
  const commentOps: CommentOps = {
    add: (blockId, anchor, body) =>
      createComment({ page_id: pageId, block_id: blockId, anchor: anchor.slice(0, 300), body }).then(reloadComments),
    update: (id, patch) => updateComment(id, patch).then(reloadComments),
    remove: (id) => deleteComment(id).then(reloadComments),
  };
  const setMode = (m: CommentMode) => {
    if (m === commentMode) return;
    setCommentMode(m);
    localStorage.setItem(COMMENT_MODE_KEY, m);
    setFocusThread(null);
    // carry the open state across so switching doesn't hide what you were reading
    if (m === "panel") {
      if (openThreads.size > 0) setPanelOpen(true);
      putOpenThreads(new Set());
    } else {
      if (panelOpen) {
        putOpenThreads(new Set(comments.filter((c) => showResolved || !c.resolved).map((c) => c.block_id)));
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
      const raw = p.content.length ? p.content : [{ type: "text", text: "", id: genId() } as Block];
      // durable ids up front so a comment made before the next edit can't orphan
      const { blocks: content, changed } = ensureIds(raw);
      setBlocks(content);
      blocksRef.current = content;
      if (changed) updatePage(pageId, { content }).catch(() => {});
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
      updatePage(pageId, { content: blocksRef.current }).catch(() => {});
    }, 800);
  };

  const patch = (p: Parameters<typeof updatePage>[1]) => updatePage(pageId, p).then(reload).then(onChanged);

  const newSubpage = () => createPage({ parent_id: pageId }).then((r) => (onChanged(), onOpenPage(r.id)));
  const newStory = () =>
    createPage({ parent_id: pageId, kind: "story" }).then((r) => (onChanged(), onOpenPage(r.id)));
  const slashInsert = (kind: "subpage" | "database", replaceIdx: number) => {
    // drop the "/…" block the user was typing in, then create the target
    const next = blocks.filter((_, j) => j !== replaceIdx);
    // needs an id like every other block — a comment on an id-less block is stored
    // against "" and orphans for good once ensureIds backfills a real one
    changeBlocks(next.length ? next : [{ type: "text", text: "", id: genId() } as Block]);
    if (kind === "subpage") newSubpage();
    else {
      createUdb("Untitled").then((r) => attachUdbToPage(r.id, pageId)).then(() => {
        reload();
        onChanged();
      });
    }
  };

  if (!page) return <p className="p-6 text-ink-muted">Loading…</p>;
  const client = board.clients.find((c) => c.id === page.client_id);
  const isProject = page.kind === "project";
  const isStory = page.kind === "story";
  // sessions come from the polled board (not the fetch-once getPage) so they stay live
  const sessions = board.sessions
    .filter((s) => s.page_id === pageId || s.objective_id === pageId)
    .sort((a, b) => (statusStyle(a.status).terminal ? 1 : 0) - (statusStyle(b.status).terminal ? 1 : 0));
  const done = sessions.filter((s) => statusStyle(s.status).terminal).length;
  const blockIds = new Set(blocks.filter(isText).map((b) => b.id).filter(Boolean) as string[]);
  const orphans = comments.filter((c) => !blockIds.has(c.block_id));
  const resolvedCount = comments.filter((c) => c.resolved && blockIds.has(c.block_id)).length;
  const openCount = comments.filter((c) => !c.resolved && blockIds.has(c.block_id)).length;
  const commentedIds = [
    ...new Set(
      comments.filter((c) => blockIds.has(c.block_id) && (showResolved || !c.resolved)).map((c) => c.block_id),
    ),
  ];
  const allOpen = commentedIds.length > 0 && commentedIds.every((id) => openThreads.has(id));
  // panel threads follow block order so the list reads like the page
  const panelThreads = blocks.filter(isText).flatMap((b) => {
    if (!b.id) return [];
    const list = comments.filter((c) => c.block_id === b.id && (showResolved || !c.resolved));
    return list.length ? [{ block: b, list }] : [];
  });

  return (
    <div className="flex min-h-0 flex-1">
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[820px] flex-col gap-4 px-8 py-7">
        <div className="flex items-center gap-2">
          <div className="relative">
            <button type="button"
              className="rounded-md p-1 text-[22px] leading-none transition-colors hover:bg-panel"
              title="page icon"
              onClick={() => setIconOpen(true)}
            >
              <EntityIcon icon={page.icon} fallback={isProject ? "◎" : isStory ? "◇" : "□"} className={page.icon ? "" : "text-ink-muted"} />
            </button>
            {iconOpen && (
              <IconPicker current={page.icon} onPick={(icon) => patch({ icon })} onClose={() => setIconOpen(false)} />
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
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
          {isProject && (
            <div className="relative shrink-0">
              <button type="button"
                title="project color"
                className="h-5 w-5 rounded-md border border-chipline"
                style={{ background: page.color ?? "#2f3542" }}
                onClick={() => setColorOpen((o) => !o)}
              />
              {colorOpen && (
                <Popover onClose={() => setColorOpen(false)} className="right-0 left-auto flex w-auto gap-1.5 p-2">
                  {PROJECT_COLORS.map((c) => (
                    <button type="button"
                      key={c}
                      className={`h-5 w-5 rounded-md ${page.color === c ? "ring-2 ring-ink ring-offset-1 ring-offset-[#171923]" : ""}`}
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
          <div className="shrink-0 pl-1">
            <PresenceBar people={presence} />
          </div>
        </div>

        {isStory && (
          <div className="flex items-center gap-3">
            <div className="w-[120px]">
              <Select value={page.status} options={PAGE_STATUS} onChange={(status) => patch({ status })} />
            </div>
            {client && <ClientChip name={client.name} color={client.color} onClick={() => onOpenClient(client.id)} />}
            {sessions.length > 0 && (
              <>
                <div className="h-[5px] w-[140px] overflow-hidden rounded-full bg-line">
                  <div
                    className="h-full rounded-full bg-copper"
                    style={{ width: `${(done / sessions.length) * 100}%` }}
                  />
                </div>
                <span className="text-[11.5px] font-medium text-ink-muted">{done} / {sessions.length} done</span>
              </>
            )}
          </div>
        )}

        {isStory && (
          <textarea
            key={page.id + page.story}
            rows={2}
            className="resize-none rounded-md border border-transparent bg-transparent px-2 py-1.5 text-xs leading-relaxed text-ink-soft outline-none transition-colors placeholder:italic placeholder:text-ink-muted/50 hover:bg-[#101219] focus:border-chipline focus:bg-[#101219]"
            defaultValue={page.story}
            placeholder="add the story — what are we trying to achieve? (click to edit)"
            onBlur={(e) => {
              if (e.target.value !== page.story) patch({ story: e.target.value });
            }}
          />
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
                    putOpenThreads(allOpen ? new Set() : new Set(commentedIds));
                  }}
                >
                  {allOpen ? "Close" : "Open"} all {openCount} comment{openCount > 1 ? "s" : ""}
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
                      for (const c of comments) if (c.resolved && blockIds.has(c.block_id)) n.add(c.block_id);
                      return n;
                    });
                  }
                }}
              >
                {showResolved ? "Hide" : "Show"} {resolvedCount} resolved comment{resolvedCount > 1 ? "s" : ""}
              </button>
            )}
            <div className="flex overflow-hidden rounded-md border border-line-soft text-[10.5px]">
              {(["inline", "panel"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`px-2 py-0.5 capitalize transition-colors ${
                    commentMode === m ? "bg-panel text-ink-soft" : "text-ink-muted/60 hover:text-ink-soft"
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
          onSlashInsert={slashInsert}
          onOpenReport={onOpenReport}
          comments={comments}
          commentOps={commentOps}
          showResolved={showResolved}
          mode={commentMode}
          openThreads={openThreads}
          focusThread={focusThread}
          flash={flash}
          meId={meId}
          onToggleThread={toggleThread}
        />

        {orphans.length > 0 && (
          <div className="flex flex-col gap-2 rounded-lg border border-line-soft bg-panel/30 p-3">
            <span className="text-[10.5px] font-medium tracking-[0.8px] text-ink-muted/70">
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
                  onUpdate={(patch) => commentOps.update(c.id, patch)}
                  onDelete={() => commentOps.remove(c.id)}
                />
              </div>
            ))}
          </div>
        )}

        {page.databases.map((d) => (
          <div key={d.id} className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink">
              <EntityIcon icon={d.icon} fallback="⌗" className="text-ink-muted" />
              {d.name}
            </div>
            <DatabaseView dbId={d.id} epoch={0} udbs={udbs} />
          </div>
        ))}

        <div className="flex flex-col gap-0.5">
            {page.children.map((c) => (
              <button type="button"
                key={c.id}
                className="flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] text-ink-soft hover:bg-panel"
                onClick={() => onOpenPage(c.id)}
              >
                <EntityIcon icon={c.icon} fallback={c.kind === "project" ? "◎" : c.kind === "story" ? "◇" : "□"} className="text-ink-muted" />
                <span className={c.title ? "" : "text-ink-muted/60 italic"}>{c.title || "Untitled"}</span>
              </button>
            ))}
            <button type="button"
              className="flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] text-ink-muted/70 hover:text-ink-soft"
              onClick={isProject ? newStory : newSubpage}
            >
              <span className="text-[11px]">＋</span> {isProject ? "New story" : "New sub-page"}
            </button>
          </div>

        {/* also shown when a just-promoted page (stale kind) already has sessions */}
        {(isStory || sessions.length > 0) && (
          <div className="flex flex-col gap-1 border-t border-line-soft pt-3">
            <span className="text-[10.5px] font-medium tracking-[0.8px] text-ink-muted/70">SESSIONS</span>
            {sessions.map((s) => (
              <div
                key={s.id}
                onClick={() => onOpenSession(s.id)}
                className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-[#14161c]"
              >
                <StatusDot status={s.status} size={7} />
                <span className={`text-xs font-medium ${statusStyle(s.status).terminal ? "text-ink-muted" : ""}`}>{s.title}</span>
                {s.branch && <span className="text-[10.5px] text-ink-muted">{s.branch}</span>}
                <span className="flex-1" />
                <span className="text-[10px] text-ink-muted/70">{statusStyle(s.status).label}</span>
              </div>
            ))}
            {sessions.length === 0 && <span className="py-1 text-[11.5px] text-ink-muted">no sessions yet</span>}
          </div>
        )}
      </div>
    </div>
    {commentMode === "panel" && panelOpen && (
      <aside className="flex w-[320px] shrink-0 flex-col border-l border-line bg-sidebar">
        <div className="flex items-center gap-2 border-b border-line-soft px-3.5 py-2.5">
          <span className="text-[12px] font-semibold text-ink">Comments</span>
          <span className="text-[10.5px] text-ink-muted">{openCount} open</span>
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
                onClick={() => flashBlock(block.id as string)}
              >
                “{block.text || "…"}”
              </button>
              {list.map((c) => (
                <CommentItem
                  key={c.id}
                  c={c}
                  canEdit={Boolean(meId) && c.author_id === meId}
                  answered={answeredIn(c, list)}
                  onUpdate={(patch) => commentOps.update(c.id, patch)}
                  onDelete={() => commentOps.remove(c.id)}
                />
              ))}
              <AddNote onAdd={(body) => commentOps.add(block.id as string, block.text, body)} />
            </div>
          ))}
          {panelThreads.length === 0 && <span className="px-1 text-[11px] text-ink-muted/60">No comments</span>}
        </div>
      </aside>
    )}
    </div>
  );
}

// Header-level delete used by App (kept here so the confirm copy lives with the page code).
export async function confirmDeletePage(page: { id: string; title: string }): Promise<boolean> {
  const ok = await appConfirm(
    `Delete "${page.title || "Untitled"}" and everything inside it (sub-pages and attached databases)?`,
  );
  if (ok) await deletePage(page.id);
  return ok;
}
