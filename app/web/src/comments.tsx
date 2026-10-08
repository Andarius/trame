import { useState } from "react";
import type { PageComment } from "./api";
import { Popover, timeAgo, IconButton } from "./ui";
import { Markdown } from "./md";
import { PROJECT_COLORS } from "./page-ids";

export type CommentOps = {
  add: (blockId: string, anchor: string, body: string) => void;
  update: (id: string, patch: { body?: string; resolved?: boolean }) => void;
  remove: (id: string) => void;
};

// "inline": threads expand under their block (GitHub-PR style).
// "panel": threads live in a right-side panel; bubbles open a quick popover.
export type CommentMode = "inline" | "panel";
export const COMMENT_MODE_KEY = "trame-comment-mode";
export const STORY_ORDER_KEY = "trame-story-order";
export const PANEL_OPEN_KEY = "trame-comments-panel-open";
// which inline threads are expanded — persisted per page so a refresh keeps them open
export const openKey = (pageId: string) => `trame-open-threads:${pageId}`;
export const loadOpenThreads = (pageId: string): Set<string> => {
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
export const isAgent = (c: PageComment) => c.author_id === AGENT_AUTHOR_ID;
// a reply is answered once a newer agent comment sits on the same block
export const answeredIn = (c: PageComment, blockComments: PageComment[]) =>
  blockComments.some((o) => isAgent(o) && o.updated_at > c.updated_at);

// Quote naming a comment's exact target inside its block: a table row (pipe-less
// anchor on a pipe-table block, see MdTable 💬) or a text selection (anchor that
// is a fragment of the block's current text). Block-level comments (anchor = the
// whole block, or a stale fragment) get no quote.
export const anchorQuoteOf = (
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
export function RowNote({ label, text }: { label: string; text: string }) {
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

export function CommentItem(
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
        <IconButton tone="danger" title="delete"
          onClick={onDelete}
          className="text-[11px] transition-colors"
        >
          ✕
        </IconButton>
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

export function AddNote(
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
export function CommentGutter(
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
