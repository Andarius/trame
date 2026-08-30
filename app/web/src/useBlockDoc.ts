// Load/edit/comment loop for one page's blocks, for editors embedded outside the
// page view (the Drawer's specs). Page.tsx keeps its own inline copy for now.
import { useEffect, useRef, useState } from "react";
import {
  type Block,
  createComment,
  deleteComment,
  getPage,
  listComments,
  type PageComment,
  type PageDetail,
  updateComment,
  updatePage,
} from "./api";
import { type CommentOps, ensureIds, genId } from "./Page";

export function useBlockDoc(pageId: string | null) {
  const [page, setPage] = useState<PageDetail | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [comments, setComments] = useState<PageComment[]>([]);
  const [openThreads, setOpenThreads] = useState<Set<string>>(new Set());
  const [focusThread, setFocusThread] = useState<string | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const savingRef = useRef(0); // in-flight updatePage calls
  const blocksRef = useRef<Block[]>([]);

  useEffect(() => {
    if (!pageId) return;
    setOpenThreads(new Set());
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
      // flush a pending debounce so unmount doesn't lose the last edit
      if (saveTimer.current !== undefined) {
        clearTimeout(saveTimer.current);
        saveTimer.current = undefined;
        updatePage(pageId, { content: blocksRef.current }).catch(() => {});
      }
    };
  }, [pageId]);

  // live-refresh content written by others (agents via MCP, another tab) — never
  // while the user is mid-edit; comments refresh regardless.
  useEffect(() => {
    if (!pageId) return;
    const busy = () => {
      if (saveTimer.current !== undefined || savingRef.current > 0) return true;
      const tag = document.activeElement?.tagName;
      return tag === "TEXTAREA" || tag === "INPUT";
    };
    const tick = () => {
      if (document.hidden) return;
      listComments(pageId).then((next) =>
        setComments((prev) =>
          JSON.stringify(prev) === JSON.stringify(next) ? prev : next
        )
      ).catch(() => {});
      if (busy()) return;
      getPage(pageId).then((p) => {
        if (busy()) return; // an edit started while the fetch was in flight
        if (
          p.content.length &&
          JSON.stringify(p.content) !== JSON.stringify(blocksRef.current)
        ) {
          const { blocks: content } = ensureIds(p.content);
          setBlocks(content);
          blocksRef.current = content;
        }
        setPage((prev) => JSON.stringify(prev) === JSON.stringify(p) ? prev : p);
      }).catch(() => {});
    };
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, [pageId]);

  const changeBlocks = (next: Block[]) => {
    if (!pageId) return;
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

  const reload = () => {
    if (pageId) getPage(pageId).then(setPage).catch(() => {});
  };
  const reloadComments = () => {
    if (pageId) listComments(pageId).then(setComments).catch(() => {});
  };
  const commentOps: CommentOps = {
    add: (blockId, anchor, body) =>
      createComment({
        page_id: pageId!,
        block_id: blockId,
        anchor: anchor.slice(0, 300),
        body,
      }).then(reloadComments),
    update: (id, patch) => updateComment(id, patch).then(reloadComments),
    remove: (id) => deleteComment(id).then(reloadComments),
  };
  const toggleThread = (blockId: string) => {
    const opening = !openThreads.has(blockId);
    setFocusThread(opening ? blockId : null);
    setOpenThreads((prev) => {
      const next = new Set(prev);
      if (opening) next.add(blockId);
      else next.delete(blockId);
      return next;
    });
  };

  return {
    page,
    blocks,
    comments,
    changeBlocks,
    commentOps,
    openThreads,
    focusThread,
    toggleThread,
    reload,
  };
}
