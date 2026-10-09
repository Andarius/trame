import { useEffect, useRef, useState } from "react";
import { type Block, createComment, deleteComment, listComments, type PageComment, updateComment } from "../api";
import { BOOL_CODEC, enumCodec, SET_CODEC, useLocalStorage } from "../ui/ui";
import {
  type CommentMode,
  type CommentOps,
  COMMENT_MODE_KEY,
  openKey,
  PANEL_OPEN_KEY,
} from "./comments";
import { isText } from "../editor/editor-text";

/** A page's comments plus its thread/panel/flash UI state. */
export function usePageComments(pageId: string) {
  const [comments, setComments] = useState<PageComment[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [commentMode, setCommentMode] = useLocalStorage<CommentMode>(COMMENT_MODE_KEY, "inline", enumCodec(["inline", "panel"]));
  // this page's expanded threads, persisted per page key (no cross-page race)
  const [openThreads, putOpenThreads] = useLocalStorage(openKey(pageId), new Set<string>(), SET_CODEC);
  const [focusThread, setFocusThread] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useLocalStorage(PANEL_OPEN_KEY, false, BOOL_CODEC);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);
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
  useEffect(() => {
    setShowResolved(false);
    setFocusThread(null);
  }, [pageId]);

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

  return {
    comments,
    setComments,
    showResolved,
    setShowResolved,
    commentMode,
    setMode,
    openThreads,
    putOpenThreads,
    focusThread,
    setFocusThread,
    panelOpen,
    setPanelOpen,
    flash,
    commentOps,
    toggleThread,
    flashBlock,
  };
}

/** The hook's state plus the counts and thread lists derived from the page's blocks. */
export function commentView(cs: ReturnType<typeof usePageComments>, blocks: Block[]) {
  const { comments, showResolved, openThreads } = cs;
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
  return { ...cs, blockIds, orphans, resolvedCount, openCount, commentedIds, allOpen, panelThreads };
}

export type CommentView = ReturnType<typeof commentView>;
