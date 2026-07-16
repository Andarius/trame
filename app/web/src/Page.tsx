import { useEffect, useRef, useState } from "react";
import {
  attachUdbToPage,
  type Block,
  type BoardData,
  createComment,
  createPage,
  createUdb,
  deleteComment,
  deletePage,
  getPage,
  listComments,
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

function CommentItem(
  { c, onUpdate, onDelete }: {
    c: PageComment;
    onUpdate: (patch: { body?: string; resolved?: boolean }) => void;
    onDelete: () => void;
  },
) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.body);
  return (
    <div className={`rounded-md border border-line-soft bg-panel/50 p-2 ${c.resolved ? "opacity-55" : ""}`}>
      <div className="mb-1 flex items-center gap-1.5">
        {c.author_avatar && (
          <img
            src={c.author_avatar}
            alt=""
            className="h-4 w-4 shrink-0 rounded-full object-cover"
          />
        )}
        {c.author && <span className="text-[10.5px] font-medium text-ink-soft">{c.author}</span>}
        <span className="text-[10px] text-ink-muted">{timeAgo(c.updated_at)}</span>
        {c.resolved && <span className="text-[9px] uppercase tracking-[0.5px] text-active">resolved</span>}
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
            rows={2}
            value={draft}
            className="w-full resize-none rounded bg-[#101219] p-1.5 text-[12px] leading-snug text-ink outline-none"
            onChange={(e) => setDraft(e.target.value)}
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
            className="cursor-text whitespace-pre-wrap text-[12px] leading-snug text-ink-soft"
            title="click to edit"
            onClick={() => setEditing(true)}
          >
            {c.body}
          </div>
        )}
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
// otherwise a hover-only "add" button. Opens the block's thread as a popover.
function CommentGutter(
  { blockId, anchor, comments, showResolved, ops }: {
    blockId: string;
    anchor: string;
    comments: PageComment[]; // already filtered to this block
    showResolved: boolean;
    ops: CommentOps;
  },
) {
  const [open, setOpen] = useState(false);
  // auto-opened threads (via "Show resolved") shouldn't grab focus/scroll like a click does
  const [autoOpened, setAutoOpened] = useState(false);
  // "Show resolved" reveals AND opens the threads that have resolved notes, so they're
  // readable inline without a second click; toggling off closes them again.
  useEffect(() => {
    if (comments.some((c) => c.resolved)) {
      setOpen(showResolved);
      setAutoOpened(showResolved);
    }
  }, [showResolved]);
  const unresolved = comments.filter((c) => !c.resolved);
  const visible = showResolved ? comments : unresolved;
  const marker = unresolved.length > 0 || (showResolved && comments.length > 0);
  return (
    <div className="relative">
      <button
        type="button"
        title={unresolved.length ? `${unresolved.length} comment${unresolved.length > 1 ? "s" : ""}` : "comment"}
        onClick={() => {
          setOpen((v) => !v);
          setAutoOpened(false);
        }}
        className={`flex items-center gap-0.5 rounded-md px-1 py-0.5 text-[11px] transition-opacity ${
          marker ? "opacity-100" : "opacity-0 group-hover:opacity-60 hover:!opacity-100"
        } ${unresolved.length ? "text-copper hover:bg-copper/10" : "text-ink-muted hover:bg-panel"}`}
      >
        💬{unresolved.length > 0 && <span className="text-[10px] font-medium">{unresolved.length}</span>}
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)} className="left-auto right-0 max-h-[60vh] w-[300px] overflow-y-auto p-2">
          <div className="flex flex-col gap-2">
            {visible.map((c) => (
              <CommentItem
                key={c.id}
                c={c}
                onUpdate={(patch) => ops.update(c.id, patch)}
                onDelete={() => ops.remove(c.id)}
              />
            ))}
            {visible.length === 0 && <span className="px-1 text-[11px] text-ink-muted/60">No comments yet</span>}
            <AddNote autoFocus={!autoOpened} onAdd={(body) => ops.add(blockId, anchor, body)} />
          </div>
        </Popover>
      )}
    </div>
  );
}

function BlockEditor(
  { blocks, onChange, onSlashInsert, onOpenReport, comments, commentOps, showResolved }: {
    blocks: Block[];
    onChange: (blocks: Block[]) => void;
    // subpage/database creation is async and owned by the page
    onSlashInsert: (kind: "subpage" | "database", replaceIdx: number) => void;
    onOpenReport: (path: string) => void;
    comments: PageComment[];
    commentOps: CommentOps;
    showResolved: boolean;
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
        return (
          <div
            key={b.id ?? i}
            className={`group relative -mx-1 flex items-start gap-2 px-1 ${
              hasOpen ? "rounded-md bg-copper/[0.05]" : ""
            }`}
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
                ops={commentOps}
              />
            </div>
          </div>
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
  useEffect(() => {
    setShowResolved(false);
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

  return (
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

        {resolvedCount > 0 && (
          <button
            type="button"
            className="-mb-2 self-start text-[11px] text-ink-muted/70 transition-colors hover:text-ink-soft"
            onClick={() => setShowResolved((v) => !v)}
          >
            {showResolved ? "Hide" : "Show"} {resolvedCount} resolved comment{resolvedCount > 1 ? "s" : ""}
          </button>
        )}

        <BlockEditor
          blocks={blocks}
          onChange={changeBlocks}
          onSlashInsert={slashInsert}
          onOpenReport={onOpenReport}
          comments={comments}
          commentOps={commentOps}
          showResolved={showResolved}
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
