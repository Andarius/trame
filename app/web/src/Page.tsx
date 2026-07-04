import { useEffect, useRef, useState } from "react";
import {
  attachUdbToPage,
  type Block,
  type BoardData,
  createPage,
  createUdb,
  deletePage,
  getPage,
  type PageDetail,
  type UdbMeta,
  updatePage,
} from "./api";
import { appConfirm, ClientChip, EntityIcon, Popover, Select, STATUS, StatusDot } from "./ui";
import { IconPicker } from "./udb/cells";
import { DatabaseView } from "./udb/DatabaseTable";

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
];

function BlockEditor(
  { blocks, onChange, onSlashInsert }: {
    blocks: Block[];
    onChange: (blocks: Block[]) => void;
    // subpage/database creation is async and owned by the page
    onSlashInsert: (kind: "subpage" | "database", replaceIdx: number) => void;
  },
) {
  const refs = useRef<(HTMLTextAreaElement | null)[]>([]);
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  const [menuIdx, setMenuIdx] = useState<number | null>(null); // block showing the slash menu

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
  const insertAfter = (i: number) => {
    const next = [...blocks.slice(0, i + 1), { type: "text", text: "" } as Block, ...blocks.slice(i + 1)];
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
    onChange(blocks.map((b, j) => (j === i ? { type: key as TextBlock["type"], text: "" } : b)));
    setFocusIdx(i);
  };

  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "0";
    el.style.height = `${el.scrollHeight}px`;
  };

  return (
    <div className="flex flex-col">
      {blocks.map((b, i) => {
        if (!isText(b)) {
          // database/subpage markers live in the flow but render as the page sections below
          return null;
        }
        const filter = b.text.startsWith("/") ? b.text.slice(1).toLowerCase() : null;
        const items = filter === null ? [] : SLASH.filter((s) => s.label.toLowerCase().includes(filter));
        return (
          <div key={i} className="group relative flex items-start gap-2">
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
              }}
              onKeyDown={(e) => {
                if (menuIdx === i && items.length && e.key === "Enter") {
                  e.preventDefault();
                  return pick(i, items[0].key);
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
                {items.map((s) => (
                  <button
                    key={s.key}
                    className="flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left hover:bg-panel"
                    onClick={() => pick(i, s.key)}
                  >
                    <span className="text-xs font-medium text-ink">{s.label}</span>
                    <span className="text-[10.5px] text-ink-muted">{s.hint}</span>
                  </button>
                ))}
              </Popover>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function Page(
  { pageId, board, udbs, onOpenPage, onOpenSession, onChanged }: {
    pageId: string;
    board: BoardData;
    udbs: UdbMeta[];
    onOpenPage: (id: string) => void;
    onOpenSession: (id: string) => void;
    onChanged: () => void; // sidebar tree cares about title/icon/structure changes
  },
) {
  const [page, setPage] = useState<PageDetail | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [iconOpen, setIconOpen] = useState(false);
  const saveTimer = useRef<number | undefined>(undefined);
  const blocksRef = useRef<Block[]>([]);

  const reload = () => getPage(pageId).then(setPage).catch(() => {});
  useEffect(() => {
    getPage(pageId).then((p) => {
      setPage(p);
      const content = p.content.length ? p.content : [{ type: "text", text: "" } as Block];
      setBlocks(content);
      blocksRef.current = content;
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
  const slashInsert = (kind: "subpage" | "database", replaceIdx: number) => {
    // drop the "/…" block the user was typing in, then create the target
    const next = blocks.filter((_, j) => j !== replaceIdx);
    changeBlocks(next.length ? next : [{ type: "text", text: "" }]);
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
  // sessions come from the polled board (not the fetch-once getPage) so they stay live
  const sessions = board.sessions
    .filter((s) => s.page_id === pageId || s.objective_id === pageId)
    .sort((a, b) => (a.status === "done" ? 1 : 0) - (b.status === "done" ? 1 : 0));
  const done = sessions.filter((s) => s.status === "done").length;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[820px] flex-col gap-4 px-8 py-7">
        <div className="flex items-center gap-2">
          <div className="relative">
            <button
              className="rounded-md p-1 text-[22px] leading-none transition-colors hover:bg-panel"
              title="page icon"
              onClick={() => setIconOpen(true)}
            >
              <EntityIcon icon={page.icon} fallback={isProject ? "◎" : "▫"} className={page.icon ? "" : "text-ink-muted"} />
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
        </div>

        {isProject && (
          <div className="flex items-center gap-3">
            <div className="w-[120px]">
              <Select value={page.status} options={PAGE_STATUS} onChange={(status) => patch({ status })} />
            </div>
            {client && <ClientChip name={client.name} color={client.color} />}
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

        {isProject && (
          <textarea
            key={page.id + page.story}
            rows={2}
            className="resize-none border-none bg-transparent text-xs leading-relaxed text-ink-soft outline-none placeholder:italic placeholder:text-ink-muted/50"
            defaultValue={page.story}
            placeholder="add the story — what are we trying to achieve?"
            onBlur={(e) => {
              if (e.target.value !== page.story) patch({ story: e.target.value });
            }}
          />
        )}

        <BlockEditor blocks={blocks} onChange={changeBlocks} onSlashInsert={slashInsert} />

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
              <button
                key={c.id}
                className="flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] text-ink-soft hover:bg-panel"
                onClick={() => onOpenPage(c.id)}
              >
                <EntityIcon icon={c.icon} fallback={c.kind === "project" ? "◎" : "▫"} className="text-ink-muted" />
                <span className={c.title ? "" : "text-ink-muted/60 italic"}>{c.title || "Untitled"}</span>
              </button>
            ))}
            <button
              className="flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] text-ink-muted/70 hover:text-ink-soft"
              onClick={newSubpage}
            >
              <span className="text-[11px]">＋</span> New sub-page
            </button>
          </div>

        {isProject && (
          <div className="flex flex-col gap-1 border-t border-line-soft pt-3">
            <span className="text-[10.5px] font-medium tracking-[0.8px] text-ink-muted/70">SESSIONS</span>
            {sessions.map((s) => (
              <div
                key={s.id}
                onClick={() => onOpenSession(s.id)}
                className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-[#14161c]"
              >
                <StatusDot status={s.status} size={7} />
                <span className={`text-xs font-medium ${s.status === "done" ? "text-ink-muted" : ""}`}>{s.title}</span>
                {s.branch && <span className="text-[10.5px] text-ink-muted">{s.branch}</span>}
                <span className="flex-1" />
                <span className="text-[10px] text-ink-muted/70">{STATUS[s.status].label}</span>
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
