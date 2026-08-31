import {
  type CSSProperties,
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
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
  type PageComment,
  type PageDetail,
  pingPresence,
  type Presence,
  type Session,
  type SessionLink,
  startWatcher,
  type UdbMeta,
  updateComment,
  updatePage,
  uploadAsset,
} from "./api";
import {
  appConfirm,
  ClientChip,
  EntityIcon,
  inSubtree,
  pagesById,
  Popover,
  Select,
  StatusDot,
  statusStyle,
  storyOf,
  timeAgo,
  uuid7Time,
} from "./ui";
import { Markdown } from "./md";
import { blocksToMarkdown } from "./page-serialize";

// Stable block id so a comment survives edits/reorders of the surrounding text.
export const genId = () => crypto.randomUUID().slice(0, 8);
const isTextType = (t: Block["type"]) =>
  t === "text" || t === "heading" || t === "todo";
// Backfill ids on text blocks that predate them; `changed` tells the caller to persist.
export function ensureIds(blocks: Block[]): { blocks: Block[]; changed: boolean } {
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
import {
  normalizeMarks,
  removeMark,
  setMark,
  stripMarks,
  todayMark,
  touchTodo,
} from "../../todo-marks.ts";
import { DatabaseView } from "./udb/DatabaseTable";
import { FolderBlock } from "./FolderBlock";
import { HtmlBlock } from "./HtmlBlock";

// project chip palette (matches the client palette + a few extras)
const PROJECT_COLORS = [
  "#7a9ee7",
  "#b590e7",
  "#c98a63",
  "#7bd88f",
  "#e3c567",
  "#e06c75",
  "#56b6c2",
  "#8b93a3",
];

const PAGE_STATUS = [
  { value: "open", label: "Open" },
  { value: "done", label: "Done" },
  { value: "archived", label: "Archived" },
];

type TextBlock = Extract<Block, { type: "text" | "heading" | "todo" }>;
const isText = (b: Block): b is TextBlock =>
  b.type === "text" || b.type === "heading" || b.type === "todo";

const SLASH: { key: string; label: string; hint: string }[] = [
  { key: "text", label: "Text", hint: "plain paragraph" },
  { key: "heading", label: "Heading", hint: "section title" },
  { key: "todo", label: "To-do", hint: "checkbox item" },
  { key: "tab", label: "Tab section", hint: "heading that becomes a tab" },
  { key: "fold", label: "Folded section", hint: "collapsible heading" },
  { key: "subpage", label: "Sub-page", hint: "nest a page here" },
  { key: "database", label: "Database", hint: "table on this page" },
  { key: "folder", label: "Folder", hint: "live files from a directory" },
  { key: "html", label: "HTML", hint: "embedded interactive doc" },
];

// colors offered when typing "{{" — keys must match PILL_COLORS in md.tsx
const PILLS: { key: string; dot: string; hint: string }[] = [
  { key: "green", dot: "bg-active", hint: "done / ok" },
  { key: "yellow", dot: "bg-paused", hint: "pending / warn" },
  { key: "red", dot: "bg-blocked", hint: "blocked / error" },
  { key: "copper", dot: "bg-copper", hint: "accent" },
  { key: "gray", dot: "bg-chipline", hint: "neutral" },
];

// pixel position of `index` inside a textarea (mirror-div technique), relative to
// the textarea's top-left; y is the bottom of the caret's line, top its top
function caretXY(
  el: HTMLTextAreaElement,
  index: number,
): { x: number; y: number; top: number } {
  const div = document.createElement("div");
  const s = getComputedStyle(el);
  for (
    const p of [
      "fontFamily",
      "fontSize",
      "fontWeight",
      "lineHeight",
      "letterSpacing",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "boxSizing",
      "tabSize",
    ] as const
  ) div.style[p] = s[p];
  div.style.position = "absolute";
  div.style.visibility = "hidden";
  div.style.whiteSpace = "pre-wrap";
  div.style.overflowWrap = "break-word";
  div.style.width = `${el.clientWidth}px`;
  div.textContent = el.value.slice(0, index);
  const span = document.createElement("span");
  span.textContent = "\u200b";
  div.appendChild(span);
  document.body.appendChild(div);
  const x = span.offsetLeft;
  const top = span.offsetTop;
  const y = top + span.offsetHeight;
  div.remove();
  return { x, y, top };
}

// markdown delimiters behind the selection toolbar / shortcuts (see INLINE in md.tsx)
const INLINE_DELIMS = {
  bold: "**",
  italic: "*",
  strike: "~~",
  code: "`",
} as const;
type InlineKind = keyof typeof INLINE_DELIMS;

// Toggle the kind's delimiter around [start, end) — whitespace at the selection's
// edges stays outside so the result still parses as emphasis. Returns the new
// text plus the range to re-select.
function toggleInline(
  text: string,
  start: number,
  end: number,
  kind: InlineKind,
): { text: string; start: number; end: number } {
  const d = INLINE_DELIMS[kind];
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  const n = d.length;
  const inner = text.slice(start, end);
  if (inner.length >= 2 * n && inner.startsWith(d) && inner.endsWith(d)) {
    return {
      text: text.slice(0, start) + inner.slice(n, -n) + text.slice(end),
      start,
      end: end - 2 * n,
    };
  }
  if (text.slice(start - n, start) === d && text.slice(end, end + n) === d) {
    return {
      text: text.slice(0, start - n) + inner + text.slice(end + n),
      start: start - n,
      end: end - n,
    };
  }
  return {
    text: `${text.slice(0, start)}${d}${inner}${d}${text.slice(end)}`,
    start: start + n,
    end: end + n,
  };
}

// Wrap the selection as a markdown link: a selected URL becomes [](url) with the
// caret in the label, anything else [sel]() with the caret in the parens.
function linkify(
  text: string,
  start: number,
  end: number,
): { text: string; caret: number } {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  const inner = text.slice(start, end);
  const isUrl = /^https?:\/\/\S+$/.test(inner);
  return isUrl
    ? {
      text: `${text.slice(0, start)}[](${inner})${text.slice(end)}`,
      caret: start + 1,
    }
    : {
      text: `${text.slice(0, start)}[${inner}]()${text.slice(end)}`,
      caret: end + 3,
    };
}

export type CommentOps = {
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
  PROJECT_COLORS[
    [...name].reduce((a, ch) => a + ch.charCodeAt(0), 0) % PROJECT_COLORS.length
  ];

// mirrors AGENT_AUTHOR_ID in app/agent-comments.ts — agent-authored comments
const AGENT_AUTHOR_ID = "00000000-0000-4000-8000-0000000000aa";
const isAgent = (c: PageComment) => c.author_id === AGENT_AUTHOR_ID;
// a reply is answered once a newer agent comment sits on the same block
const answeredIn = (c: PageComment, blockComments: PageComment[]) =>
  blockComments.some((o) => isAgent(o) && o.updated_at > c.updated_at);

// Quote naming a comment's exact target inside its block: a table row (pipe-less
// anchor on a pipe-table block, see MdTable 💬) or a text selection (anchor that
// is a fragment of the block's current text). Block-level comments (anchor = the
// whole block, or a stale fragment) get no quote.
const anchorQuoteOf = (
  c: PageComment,
  blockText: string,
): { label: string; text: string } | null => {
  if (!c.anchor || c.anchor === blockText) return null;
  if (/^\s*\|/.test(blockText)) {
    return c.anchor.includes("|") ? null : { label: "on row", text: c.anchor };
  }
  return blockText.includes(c.anchor)
    ? { label: "on", text: c.anchor }
    : null;
};

// "on row: …" / "on: …" quote above a comment so it names its target
function RowNote({ label, text }: { label: string; text: string }) {
  return (
    <span className="truncate border-l-2 border-line pl-2 text-[11px] italic text-ink-muted/70">
      {label}: “{text}”
    </span>
  );
}

// Badges describe what the AGENT is doing about this human reply — the agent's name
// is in the label so it never reads as if the human author is the one acting.
const AGENT_BADGE = {
  seen: {
    verb: (a: string) => `${a} saw this`,
    cls: "text-ink-muted",
    pulse: false,
  },
  answering: {
    verb: (a: string) => `${a} is answering…`,
    cls: "text-copper",
    pulse: true,
  },
  failed: {
    verb: (a: string) => `${a} couldn't answer`,
    cls: "text-blocked/80",
    pulse: false,
  },
} as const;
const cap = (s: string) => s ? s[0].toUpperCase() + s.slice(1) : "An agent";

// A dim one-line footer for an agent answer: "haiku · 1.2k→340 tok · 4.3s".
function formatMeta(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as {
      model?: string;
      in?: number;
      out?: number;
      ms?: number;
    };
    const model = (m.model ?? "").replace(/^claude-/, "").replace(
      /(-[\d.]+)+$/,
      "",
    );
    const tok = (n?: number) =>
      n == null ? "?" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
    const parts = [];
    if (model) parts.push(model);
    if (m.in != null || m.out != null) {
      parts.push(`${tok(m.in)}→${tok(m.out)} tok`);
    }
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
      className={`rounded-md border border-line-soft bg-panel/50 p-2 ${
        c.resolved ? "opacity-55" : ""
      }`}
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
        {c.author && (
          <span className="text-[10.5px] font-medium" style={{ color: tint }}>
            {c.author}
          </span>
        )}
        <span className="text-[10px] text-ink-muted">
          {timeAgo(c.updated_at)}
        </span>
        {c.resolved && (
          <span className="text-[9px] uppercase tracking-[0.5px] text-active">
            resolved
          </span>
        )}
        {(() => {
          const badge = c.agent_status
            ? AGENT_BADGE[c.agent_status as keyof typeof AGENT_BADGE]
            : undefined;
          return badge && !answered && !c.resolved && !isAgent(c) && (
            <span
              className={`flex items-center gap-0.5 rounded-full bg-panel px-1.5 py-px text-[9px] ${badge.cls} ${
                badge.pulse ? "animate-pulse" : ""
              }`}
            >
              {c.agent_status === "answering"
                ? "⟳"
                : c.agent_status === "seen"
                ? "✓"
                : "⚠"}
              {badge.verb(cap(c.agent_status_agent))}
            </span>
          );
        })()}
        <span className="flex-1" />
        <button
          type="button"
          title={c.resolved ? "reopen" : "resolve"}
          onClick={() => onUpdate({ resolved: !c.resolved })}
          className="text-[12px] text-ink-muted transition-colors hover:text-active"
        >
          {c.resolved ? "↺" : "✓"}
        </button>
        <button
          type="button"
          title="delete"
          onClick={onDelete}
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
            className="w-full resize-none overflow-hidden rounded bg-well p-1.5 text-[12px] leading-snug text-ink outline-none"
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
            className={canEdit ? "cursor-text" : undefined}
            title={canEdit ? "click to edit" : undefined}
            onClick={() => canEdit && setEditing(true)}
          >
            <Markdown
              text={c.body}
              className="text-[12px] leading-snug text-ink-soft"
            />
          </div>
        )}
      {formatMeta(c.meta) && (
        <div className="mt-1 text-[9px] tracking-[0.3px] text-ink-muted/50">
          {formatMeta(c.meta)}
        </div>
      )}
    </div>
  );
}

// Notion-style avatar stack: who's on the page + which agents are watching.
function PresenceBar({ people }: { people: Presence[] }) {
  if (people.length === 0) return null;
  // viewers first, then watchers; server dedups by id, but two tabs can yield two
  // viewer entries for one person — dedup the rendered avatars by name (keep first).
  const seen = new Set<string>();
  const sorted = [...people]
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "viewer" ? -1 : 1))
    .filter((p) => (seen.has(p.name) ? false : (seen.add(p.name), true)));
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

// Ghosted avatar next to the presence stack: an agent with threads on this page but
// no active watcher. Clicking asks the server to open the comment watcher in a
// terminal; when none can open (headless/bundled build) the command is copied instead.
function StartWatcherButton(
  { agent, name, avatar, pageId }: {
    agent: string;
    name: string;
    avatar: string;
    pageId: string;
  },
) {
  const [state, setState] = useState<"idle" | "starting" | "copied">("idle");
  const start = async () => {
    setState("starting");
    try {
      const r = await startWatcher(agent, pageId);
      if (!r.launched) {
        await navigator.clipboard?.writeText(r.cmd);
        setState("copied");
        setTimeout(() => setState("idle"), 2500);
      }
      // launched: stay "starting" until the watcher's heartbeat reaches presence
      // and this button unmounts
    } catch {
      setState("idle");
    }
  };
  const title = state === "copied"
    ? "No terminal opened — command copied, paste it in a shell"
    : state === "starting"
    ? `Starting ${name} watcher…`
    : `Start ${name} watcher`;
  return (
    <button
      type="button"
      title={title}
      disabled={state === "starting"}
      onClick={start}
      className={`relative -ml-1.5 first:ml-0 ${
        state === "starting" ? "" : "opacity-40 hover:opacity-90"
      }`}
    >
      <img
        src={avatar}
        alt={name}
        className={`h-6 w-6 rounded-full object-cover ring-2 ring-canvas ${
          state === "starting" ? "" : "grayscale"
        }`}
      />
      <span
        className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-canvas ${
          state === "starting" ? "animate-pulse bg-copper" : "bg-chipline"
        }`}
      />
    </button>
  );
}

function AddNote(
  { onAdd, autoFocus }: { onAdd: (body: string) => void; autoFocus?: boolean },
) {
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
  {
    blockId,
    anchor,
    comments,
    showResolved,
    mode,
    inlineOpen,
    onToggleInline,
    meId,
    ops,
  }: {
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
        title={unresolved.length
          ? `${unresolved.length} comment${unresolved.length > 1 ? "s" : ""}`
          : "comment"}
        onClick={() => (mode === "inline"
          ? onToggleInline()
          : setOpen((v) => !v))}
        className={`flex items-center gap-0.5 rounded-md px-1 py-0.5 text-[11px] transition-opacity ${
          marker || active
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-60 hover:!opacity-100"
        } ${
          unresolved.length
            ? "text-copper hover:bg-copper/10"
            : "text-ink-muted hover:bg-panel"
        }`}
      >
        💬{unresolved.length > 0 && (
          <span className="text-[10px] font-medium">{unresolved.length}</span>
        )}
      </button>
      {mode === "panel" && open && (
        <Popover
          onClose={() => setOpen(false)}
          className="left-auto right-0 max-h-[60vh] w-[300px] overflow-y-auto p-2"
        >
          <div className="flex flex-col gap-2">
            {visible.map((c) => {
              const q = anchorQuoteOf(c, anchor);
              return (
                <div key={c.id} className="flex flex-col gap-1">
                  {q && <RowNote label={q.label} text={q.text} />}
                  <CommentItem
                    c={c}
                    canEdit={Boolean(meId) && c.author_id === meId}
                    answered={answeredIn(c, comments)}
                    onUpdate={(patch) => ops.update(c.id, patch)}
                    onDelete={() => ops.remove(c.id)}
                  />
                </div>
              );
            })}
            {visible.length === 0 && (
              <span className="px-1 text-[11px] text-ink-muted/60">
                No comments yet
              </span>
            )}
            <AddNote
              autoFocus
              onAdd={(body) => ops.add(blockId, anchor, body)}
            />
          </div>
        </Popover>
      )}
    </div>
  );
}

// Lucide paths inlined (GearIcon-style) — a static lucide-react import would pull
// the whole library into the main chunk since cells.tsx dynamic-imports it.
const TOOL_PATHS = {
  copy: (
    <>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </>
  ),
  edit: (
    <>
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </>
  ),
  delete: (
    <>
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
      <line x1="10" x2="10" y1="11" y2="17" />
      <line x1="14" x2="14" y1="11" y2="17" />
    </>
  ),
  open: (
    <>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </>
  ),
  replace: (
    <>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </>
  ),
};
type ToolIconName = keyof typeof TOOL_PATHS;

function ToolIcon({ name }: { name: ToolIconName }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {TOOL_PATHS[name]}
    </svg>
  );
}

const FENCE_LANGS = [
  "plain",
  "typescript",
  "python",
  "bash",
  "json",
  "sql",
  "mermaid",
] as const;

// simple-icons brand marks (fill), inlined like TOOL_PATHS to stay off the main chunk
const SI_TYPESCRIPT =
  "M1.125 0C.502 0 0 .502 0 1.125v21.75C0 23.498.502 24 1.125 24h21.75c.623 0 1.125-.502 1.125-1.125V1.125C24 .502 23.498 0 22.875 0zm17.363 9.75c.612 0 1.154.037 1.627.111a6.38 6.38 0 0 1 1.306.34v2.458a3.95 3.95 0 0 0-.643-.361 5.093 5.093 0 0 0-.717-.26 5.453 5.453 0 0 0-1.426-.2c-.3 0-.573.028-.819.086a2.1 2.1 0 0 0-.623.242c-.17.104-.3.229-.393.374a.888.888 0 0 0-.14.49c0 .196.053.373.156.529.104.156.252.304.443.444s.423.276.696.41c.273.135.582.274.926.416.47.197.892.407 1.266.628.374.222.695.473.963.753.268.279.472.598.614.957.142.359.214.776.214 1.253 0 .657-.125 1.21-.373 1.656a3.033 3.033 0 0 1-1.012 1.085 4.38 4.38 0 0 1-1.487.596c-.566.12-1.163.18-1.79.18a9.916 9.916 0 0 1-1.84-.164 5.544 5.544 0 0 1-1.512-.493v-2.63a5.033 5.033 0 0 0 3.237 1.2c.333 0 .624-.03.872-.09.249-.06.456-.144.623-.25.166-.108.29-.234.373-.38a1.023 1.023 0 0 0-.074-1.089 2.12 2.12 0 0 0-.537-.5 5.597 5.597 0 0 0-.807-.444 27.72 27.72 0 0 0-1.007-.436c-.918-.383-1.602-.852-2.053-1.405-.45-.553-.676-1.222-.676-2.005 0-.614.123-1.141.369-1.582.246-.441.58-.804 1.004-1.089a4.494 4.494 0 0 1 1.47-.629 7.536 7.536 0 0 1 1.77-.201zm-15.113.188h9.563v2.166H9.506v9.646H6.789v-9.646H3.375z";
const SI_PYTHON =
  "M14.25.18l.9.2.73.26.59.3.45.32.34.34.25.34.16.33.1.3.04.26.02.2-.01.13V8.5l-.05.63-.13.55-.21.46-.26.38-.3.31-.33.25-.35.19-.35.14-.33.1-.3.07-.26.04-.21.02H8.77l-.69.05-.59.14-.5.22-.41.27-.33.32-.27.35-.2.36-.15.37-.1.35-.07.32-.04.27-.02.21v3.06H3.17l-.21-.03-.28-.07-.32-.12-.35-.18-.36-.26-.36-.36-.35-.46-.32-.59-.28-.73-.21-.88-.14-1.05-.05-1.23.06-1.22.16-1.04.24-.87.32-.71.36-.57.4-.44.42-.33.42-.24.4-.16.36-.1.32-.05.24-.01h.16l.06.01h8.16v-.83H6.18l-.01-2.75-.02-.37.05-.34.11-.31.17-.28.25-.26.31-.23.38-.2.44-.18.51-.15.58-.12.64-.1.71-.06.77-.04.84-.02 1.27.05zm-6.3 1.98l-.23.33-.08.41.08.41.23.34.33.22.41.09.41-.09.33-.22.23-.34.08-.41-.08-.41-.23-.33-.33-.22-.41-.09-.41.09zm13.09 3.95l.28.06.32.12.35.18.36.27.36.35.35.47.32.59.28.73.21.88.14 1.04.05 1.23-.06 1.23-.16 1.04-.24.86-.32.71-.36.57-.4.45-.42.33-.42.24-.4.16-.36.09-.32.05-.24.02-.16-.01h-8.22v.82h5.84l.01 2.76.02.36-.05.34-.11.31-.17.29-.25.25-.31.24-.38.2-.44.17-.51.15-.58.13-.64.09-.71.07-.77.04-.84.01-1.27-.04-1.07-.14-.9-.2-.73-.25-.59-.3-.45-.33-.34-.34-.25-.34-.16-.33-.1-.3-.04-.25-.02-.2.01-.13v-5.34l.05-.64.13-.54.21-.46.26-.38.3-.32.33-.24.35-.2.35-.14.33-.1.3-.06.26-.04.21-.02.13-.01h5.84l.69-.05.59-.14.5-.21.41-.28.33-.32.27-.35.2-.36.15-.36.1-.35.07-.32.04-.28.02-.21V6.07h2.09l.14.01zm-6.47 14.25l-.23.33-.08.41.08.41.23.33.33.23.41.08.41-.08.33-.23.23-.33.08-.41-.08-.41-.23-.33-.33-.23-.41-.08-.41.08z";
const SI_BASH =
  "M21.038,4.9l-7.577-4.498C13.009,0.134,12.505,0,12,0c-0.505,0-1.009,0.134-1.462,0.403L2.961,4.9 C2.057,5.437,1.5,6.429,1.5,7.503v8.995c0,1.073,0.557,2.066,1.462,2.603l7.577,4.497C10.991,23.866,11.495,24,12,24 c0.505,0,1.009-0.134,1.461-0.402l7.577-4.497c0.904-0.537,1.462-1.529,1.462-2.603V7.503C22.5,6.429,21.943,5.437,21.038,4.9z M15.17,18.946l0.013,0.646c0.001,0.078-0.05,0.167-0.111,0.198l-0.383,0.22c-0.061,0.031-0.111-0.007-0.112-0.085L14.57,19.29 c-0.328,0.136-0.66,0.169-0.872,0.084c-0.04-0.016-0.057-0.075-0.041-0.142l0.139-0.584c0.011-0.046,0.036-0.092,0.069-0.121 c0.012-0.011,0.024-0.02,0.036-0.026c0.022-0.011,0.043-0.014,0.062-0.006c0.229,0.077,0.521,0.041,0.802-0.101 c0.357-0.181,0.596-0.545,0.592-0.907c-0.003-0.328-0.181-0.465-0.613-0.468c-0.55,0.001-1.064-0.107-1.072-0.917 c-0.007-0.667,0.34-1.361,0.889-1.8l-0.007-0.652c-0.001-0.08,0.048-0.168,0.111-0.2l0.37-0.236 c0.061-0.031,0.111,0.007,0.112,0.087l0.006,0.653c0.273-0.109,0.511-0.138,0.726-0.088c0.047,0.012,0.067,0.076,0.048,0.151 l-0.144,0.578c-0.011,0.044-0.036,0.088-0.065,0.116c-0.012,0.012-0.025,0.021-0.038,0.028c-0.019,0.01-0.038,0.013-0.057,0.009 c-0.098-0.022-0.332-0.073-0.699,0.113c-0.385,0.195-0.52,0.53-0.517,0.778c0.003,0.297,0.155,0.387,0.681,0.396 c0.7,0.012,1.003,0.318,1.01,1.023C16.105,17.747,15.736,18.491,15.17,18.946z M19.143,17.859c0,0.06-0.008,0.116-0.058,0.145 l-1.916,1.164c-0.05,0.029-0.09,0.004-0.09-0.056v-0.494c0-0.06,0.037-0.093,0.087-0.122l1.887-1.129 c0.05-0.029,0.09-0.004,0.09,0.056V17.859z M20.459,6.797l-7.168,4.427c-0.894,0.523-1.553,1.109-1.553,2.187v8.833 c0,0.645,0.26,1.063,0.66,1.184c-0.131,0.023-0.264,0.039-0.398,0.039c-0.42,0-0.833-0.114-1.197-0.33L3.226,18.64 c-0.741-0.44-1.201-1.261-1.201-2.142V7.503c0-0.881,0.46-1.702,1.201-2.142l7.577-4.498c0.363-0.216,0.777-0.33,1.197-0.33 c0.419,0,0.833,0.114,1.197,0.33l7.577,4.498c0.624,0.371,1.046,1.013,1.164,1.732C21.686,6.557,21.12,6.411,20.459,6.797z";
const SI_MERMAID =
  "M23.99 2.115A12.223 12.223 0 0 0 12 10.149 12.223 12.223 0 0 0 .01 2.115a12.23 12.23 0 0 0 5.32 10.604 6.562 6.562 0 0 1 2.845 5.423v3.754h7.65v-3.754a6.561 6.561 0 0 1 2.844-5.423 12.223 12.223 0 0 0 5.32-10.604Z";

const brandLogo = (d: string, color: string) => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill={color}
    aria-hidden="true"
  >
    <path d={d} />
  </svg>
);
const strokeLogo = (paths: JSX.Element, color?: string) => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke={color ?? "currentColor"}
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {paths}
  </svg>
);
const LANG_LOGOS: Record<(typeof FENCE_LANGS)[number], JSX.Element> = {
  plain: strokeLogo(
    <>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
    </>,
  ),
  typescript: brandLogo(SI_TYPESCRIPT, "#3178C6"),
  python: brandLogo(SI_PYTHON, "#5A9FD4"),
  bash: brandLogo(SI_BASH, "#4EAA25"),
  json: strokeLogo(
    <>
      <path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1" />
      <path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" />
    </>,
    "#d4a72c",
  ),
  sql: strokeLogo(
    <>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5V19A9 3 0 0 0 21 19V5" />
      <path d="M3 12A9 3 0 0 0 21 12" />
    </>,
    "#699eca",
  ),
  mermaid: brandLogo(SI_MERMAID, "#FF3670"),
};

// Hover toolbar in a block's top-right corner (snippet/image/todo quick actions).
function CornerToolbar(
  { chip, onChip, actions }: {
    chip?: string; // snippet language label; opens the picker
    onChip?: (lang: string) => void;
    actions: {
      icon: ToolIconName;
      title: string;
      danger?: boolean;
      onClick: () => void;
    }[];
  },
) {
  const [menu, setMenu] = useState(false);
  return (
    <div
      // preventDefault keeps focus in the block's textarea while clicking actions
      onMouseDown={(e) => e.preventDefault()}
      className={`absolute right-1 top-1 z-10 ${
        menu ? "flex" : "hidden group-hover:flex"
      } items-center gap-0.5 rounded-md border border-overlay-border bg-card p-0.5 shadow-lg shadow-black/40`}
    >
      {chip !== undefined && (
        <div className="relative mr-0.5 border-r border-line pr-1">
          <button
            type="button"
            title="Language"
            onClick={() => setMenu((m) => !m)}
            className="flex items-center gap-1 rounded px-1.5 font-mono text-[10px] text-copper hover:text-ink"
          >
            {LANG_LOGOS[(chip || "plain") as keyof typeof LANG_LOGOS]}
            {chip || "plain"} ▾
          </button>
          {menu && (
            <Popover
              onClose={() => setMenu(false)}
              className="!left-auto !right-0 w-[130px] !min-w-0"
            >
              {FENCE_LANGS.map((l) => (
                <button
                  key={l}
                  type="button"
                  className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left font-mono text-[11px] hover:bg-panel ${
                    l === (chip || "plain") ? "text-copper" : "text-ink-soft"
                  }`}
                  onClick={() => {
                    setMenu(false);
                    onChip?.(l);
                  }}
                >
                  {LANG_LOGOS[l]}
                  {l}
                </button>
              ))}
            </Popover>
          )}
        </div>
      )}
      {actions.map((a) => (
        <button
          type="button"
          key={a.title}
          title={a.title}
          onClick={a.onClick}
          className={`flex h-5 w-5 items-center justify-center rounded text-ink-muted hover:bg-panel ${
            a.danger ? "hover:text-blocked" : "hover:text-ink"
          }`}
        >
          <ToolIcon name={a.icon} />
        </button>
      ))}
    </div>
  );
}

// Floating toolbar over a text selection (Notion-style). Anchored absolutely
// inside the block row by default; the rendered-view variant passes fixed coords.
function FormatBar(
  { style, fixed, actions }: {
    style: CSSProperties;
    fixed?: boolean;
    actions: { label: string; title: string; cls?: string; onClick: () => void }[];
  },
) {
  return (
    <div
      // preventDefault keeps the selection (and textarea focus) while clicking
      onMouseDown={(e) => e.preventDefault()}
      className={`${
        fixed ? "fixed" : "absolute"
      } z-40 flex items-center gap-0.5 rounded-md border border-overlay-border bg-card p-0.5 shadow-lg shadow-black/40`}
      style={style}
    >
      {actions.map((a) => (
        <button
          type="button"
          key={a.title}
          title={a.title}
          onClick={a.onClick}
          className={`flex h-6 min-w-6 items-center justify-center whitespace-nowrap rounded px-1 text-[12px] text-ink-soft hover:bg-panel hover:text-ink ${
            a.cls ?? ""
          }`}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

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
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  const [menuIdx, setMenuIdx] = useState<number | null>(null); // block showing the slash menu
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
  // outside a textarea restores; text edits keep the browser's native undo
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
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
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
          title: (b as TextBlock).text.replace(/\s*\{\{tab\}\}\s*/i, " ")
            .trim(),
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

  return (
    <div ref={rootRef} className="flex flex-col">
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
              const title = (b as TextBlock).text
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
                      title="double-click to rename"
                      className={`-mb-px border-b-2 px-3 py-1.5 text-[12.5px] transition-colors ${
                        ti === active
                          ? "border-copper font-medium text-copper"
                          : "border-transparent text-ink-muted hover:text-ink-soft"
                      }`}
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
            <FolderBlock
              key={b.id ?? i}
              block={b}
              onPatch={(patch) => setBlock(i, patch)}
              onRemove={() => remove(i)}
              onOpenReport={onOpenReport}
            />
          );
        }
        if (b.type === "html") {
          return (
            <HtmlBlock
              key={b.id ?? i}
              block={b}
              onPatch={(patch) => setBlock(i, patch)}
              onRemove={() => remove(i)}
            />
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
        const editing = activeId === bid || !stripMarks(b.text).trim() ||
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
        const editCls = isSnippet
          ? "my-1 rounded-md bg-panel px-2 font-mono text-[12px] leading-relaxed text-ink-soft"
          : isImage
          ? "rounded-md bg-panel px-2 font-mono text-[11px] leading-relaxed text-ink-muted"
          : isTable
          ? "my-1 rounded-md bg-panel px-2 font-mono text-[11.5px] leading-relaxed text-ink-soft"
          : `bg-transparent ${textCls}`;
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
                overIdx === i && dragIdx !== null && dragIdx !== i
                  ? "shadow-[0_-2px_0_0_#c98a63]"
                  : ""
              }`}
              // nested blocks shift right; overrides the base pl-6 (24px)
              style={b.indent ? { paddingLeft: 24 + b.indent * 20 } : undefined}
              onMouseMove={() => {
                if (dragIdx !== null && overIdx !== i) setOverIdx(i);
              }}
            >
              <button
                type="button"
                title="Drag to move"
                onMouseDown={(e) => {
                  e.preventDefault(); // no text selection while dragging
                  setDragIdx(i);
                }}
                // fixed width keeps it inside the 24px block gutter (pl-6) — with
                // p-1 the glyph's font-dependent width could overlap the todo
                // checkbox and swallow its clicks
                className={`absolute left-0.5 top-[2px] w-[18px] overflow-hidden py-1 text-center cursor-grab select-none text-[13px] leading-none text-ink-muted hover:text-ink ${
                  dragIdx === null ? "hidden group-hover:block" : "block"
                }`}
              >
                ⋮⋮
              </button>
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
                      <span className="h-3 w-3 rounded-full border-[1.5px] border-copper hover:bg-copper/20" />
                    )}
                </button>
              )}
              <div
                // kept mounted (not conditionally excluded) so the sibling textarea below
                // never shifts position and gets remounted, which would drop its ref/focus
                style={editing && !isImage ? { display: "none" } : undefined}
                title={isTable
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
                <Markdown
                  text={b.text}
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
                  getItemLink={(item) => {
                    const l = links?.find((x) =>
                      x.block_id === b.id && x.anchor === item
                    );
                    return l
                      ? {
                        title: l.session_title ?? "session",
                        color: statusStyle(l.session_status ?? "active").color,
                        open: () => onOpenSession?.(l.session_id!),
                      }
                      : null;
                  }}
                  onLinkItem={b.id && onLinkItem
                    ? (item) => onLinkItem(b.id as string, item)
                    : undefined}
                />
              </div>
              <textarea
                ref={(el) => {
                  refs.current[i] = el;
                  if (el) grow(el);
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
                    insertAfter(i);
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
              {isTable && (
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
    onOpenSession: (id: string) => void;
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
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [comments, setComments] = useState<PageComment[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [commentMode, setCommentMode] = useState<CommentMode>(
    () => (localStorage.getItem(COMMENT_MODE_KEY) === "panel"
      ? "panel"
      : "inline"),
  );
  const [openThreads, setOpenThreads] = useState<Set<string>>(() =>
    loadOpenThreads(pageId)
  );
  const [focusThread, setFocusThread] = useState<string | null>(null);
  const [panelOpen, setPanelOpenState] = useState(() =>
    localStorage.getItem(PANEL_OPEN_KEY) === "1"
  );
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
  const [idCopied, setIdCopied] = useState(false);
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
    localStorage.setItem(COMMENT_MODE_KEY, m);
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

  if (!page) return <p className="p-6 text-ink-muted">Loading…</p>;
  const client = board.projects.find((c) => c.id === page.client_id);
  const isProject = page.kind === "project";
  const isStory = page.kind === "story";
  // sessions come from the polled board (not the fetch-once getPage) so they stay live.
  // subtree semantics: anything anchored to this page or any page nested under it.
  const byId = pagesById(board.pages);
  const childStoryIds = new Set(
    page.children.filter((c) => c.kind === "story").map((c) => c.id),
  );
  const sessions = board.sessions
    .filter((s) => inSubtree(s, pageId, byId))
    .sort((a, b) =>
      (statusStyle(a.status).terminal ? 1 : 0) -
      (statusStyle(b.status).terminal ? 1 : 0)
    );
  const done = sessions.filter((s) => statusStyle(s.status).terminal).length;
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
  const sessionRow = (s: Session) => (
    <div
      key={s.id}
      onClick={() => onOpenSession(s.id)}
      className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-hover"
    >
      <StatusDot status={s.status} size={7} />
      <span
        className={`text-xs font-medium ${
          statusStyle(s.status).terminal ? "text-ink-muted" : ""
        }`}
      >
        {s.title}
      </span>
      {s.branch && (
        <span className="text-[10.5px] text-ink-muted">{s.branch}</span>
      )}
      <span className="flex-1" />
      <span className="text-[10px] text-ink-muted/70">
        {statusStyle(s.status).label}
      </span>
    </div>
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
                  fallback={isProject ? "◎" : isStory ? "◇" : "□"}
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
            return (
              <div className="-mt-2.5 flex items-center gap-1.5 px-1 text-[10.5px] text-ink-muted/70">
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
                <button
                  type="button"
                  title={`Copy page id: ${page.id}`}
                  className={`ml-1 rounded-md border border-line-soft px-2 py-0.5 transition-colors ${
                    idCopied
                      ? "border-copper/50 text-copper"
                      : "hover:bg-panel hover:text-ink-soft"
                  }`}
                  onClick={() => {
                    navigator.clipboard?.writeText(page.id).then(() => {
                      setIdCopied(true);
                      setTimeout(() => setIdCopied(false), 1500);
                    }).catch(() => {});
                  }}
                >
                  {idCopied ? "copied ✓" : "copy id"}
                </button>
                <button
                  type="button"
                  title="show this page as Markdown"
                  className="rounded-md border border-line-soft px-2 py-0.5 transition-colors hover:bg-panel hover:text-ink-soft"
                  onClick={() => setMdOpen(true)}
                >
                  markdown
                </button>
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
                  <button
                    type="button"
                    className="rounded-md px-1.5 py-0.5 text-[13px] text-ink-muted transition-colors hover:bg-panel hover:text-ink"
                    title="close"
                    onClick={() => setMdOpen(false)}
                  >
                    ✕
                  </button>
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
                <Select
                  value={page.status}
                  options={PAGE_STATUS}
                  onChange={(status) => patch({ status })}
                />
              </div>
              {client && (
                <ClientChip
                  name={client.name}
                  color={client.color}
                  onClick={() => onOpenClient(client.id)}
                />
              )}
              {sessions.length > 0 && (
                <>
                  <div className="h-[5px] w-[140px] overflow-hidden rounded-full bg-line">
                    <div
                      className="h-full rounded-full bg-copper"
                      style={{ width: `${(done / sessions.length) * 100}%` }}
                    />
                  </div>
                  <span className="text-[11.5px] font-medium text-ink-muted">
                    {done} / {sessions.length} done
                  </span>
                </>
              )}
            </div>
          )}

          {isStory && (
            <textarea
              key={page.id + page.story}
              rows={2}
              className="resize-none rounded-md border border-transparent bg-transparent px-2 py-1.5 text-xs leading-relaxed text-ink-soft outline-none transition-colors placeholder:italic placeholder:text-ink-muted/50 hover:bg-well focus:border-chipline focus:bg-well"
              defaultValue={page.story}
              placeholder="add the story — what are we trying to achieve? (click to edit)"
              onBlur={(e) => {
                if (e.target.value !== page.story) {
                  patch({ story: e.target.value });
                }
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
            flash={flash}
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
                <div className="mb-1.5 text-[10.5px] font-medium tracking-[0.8px] text-ink-muted/70">
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
            {page.children.map((c) => (
              <button
                type="button"
                key={c.id}
                className={`flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] text-ink-soft hover:bg-panel${
                  c.status === "done"
                    ? " opacity-60"
                    : c.status === "archived"
                    ? " opacity-40"
                    : ""
                }`}
                onClick={() => onOpenPage(c.id)}
              >
                <EntityIcon
                  icon={c.icon}
                  fallback={c.kind === "project"
                    ? "◎"
                    : c.kind === "story"
                    ? "◇"
                    : "□"}
                  className="text-ink-muted"
                />
                <span className={c.title ? "" : "text-ink-muted/60 italic"}>
                  {c.title || "Untitled"}
                </span>
                {c.status === "archived" && (
                  <span className="text-[10.5px] text-ink-muted/60">
                    archived
                  </span>
                )}
              </button>
            ))}
            <button
              type="button"
              className="flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] text-ink-muted/70 hover:text-ink-soft"
              onClick={isProject ? newStory : newSubpage}
            >
              <span className="text-[11px]">＋</span>{" "}
              {isProject ? "New story" : "New sub-page"}
            </button>
          </div>

          {/* also shown when a just-promoted page (stale kind) already has sessions */}
          {(isStory || sessions.length > 0) && (
            <div className="flex flex-col gap-1 border-t border-line-soft pt-3">
              <span className="text-[10.5px] font-medium tracking-[0.8px] text-ink-muted/70">
                SESSIONS
              </span>
              {sessionsByStory.map(({ story, list }) => {
                const doneInStory = list.filter((s) =>
                  statusStyle(s.status).terminal
                ).length;
                return (
                  <div
                    key={story.id}
                    className="flex flex-col gap-0.5 pt-2 first:pt-0"
                  >
                    <div className="flex items-center gap-2 px-1">
                      <EntityIcon
                        icon={story.icon}
                        fallback="◇"
                        className="text-[11px] text-ink-muted"
                      />
                      <span className="text-[12px] font-semibold text-ink-soft">
                        {story.title || "Untitled"}
                      </span>
                      <div className="h-1 w-[60px] overflow-hidden rounded-full bg-line">
                        <div
                          className="h-full rounded-full bg-copper"
                          style={{
                            width: `${(doneInStory / list.length) * 100}%`,
                          }}
                        />
                      </div>
                      <span className="text-[10px] text-ink-muted">
                        {doneInStory} / {list.length}
                      </span>
                    </div>
                    <div className="flex flex-col pl-1">
                      {list.map(sessionRow)}
                    </div>
                  </div>
                );
              })}
              {ungroupedSessions.map(sessionRow)}
              {sessions.length === 0 && (
                <span className="py-1 text-[11.5px] text-ink-muted">
                  no sessions yet
                </span>
              )}
            </div>
          )}
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
