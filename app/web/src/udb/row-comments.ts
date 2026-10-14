import { useCallback, useEffect, useMemo, useState } from "react";
import { createComment, deleteComment, getIdentity, listComments, type PageComment, updateComment } from "../api";
import { isRowThread, ROW_PREFIX } from "../page/comments";

export type RowCommentOps = {
  add: (rowId: string, title: string, body: string) => void;
  update: (id: string, patch: { body?: string; resolved?: boolean }) => void;
  remove: (id: string) => void;
};

/** Row threads of the database's page (live-polled like block comments), grouped by row id. */
export function useRowComments(pageId: string | null) {
  const [comments, setComments] = useState<PageComment[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  useEffect(() => {
    getIdentity().then((i) => setMeId(i.userId)).catch(() => {});
  }, []);
  const reload = useCallback(() => {
    if (!pageId) return Promise.resolve(setComments([]));
    return listComments(pageId).then((all) => {
      const next = all.filter(isRowThread);
      setComments((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    }).catch(() => {});
  }, [pageId]);
  useEffect(() => {
    reload();
    const t = setInterval(() => !document.hidden && reload(), 5000);
    return () => clearInterval(t);
  }, [reload]);
  // per-row lists stay referentially stable while the payload is unchanged (memoized rows)
  const byRow = useMemo(() => {
    const m = new Map<string, PageComment[]>();
    for (const c of comments) {
      const id = c.block_id.slice(ROW_PREFIX.length);
      m.set(id, [...(m.get(id) ?? []), c]);
    }
    return m;
  }, [comments]);
  const ops: RowCommentOps | null = useMemo(() =>
    pageId
      ? {
        add: (rowId, title, body) =>
          createComment({ page_id: pageId, block_id: ROW_PREFIX + rowId, anchor: title.slice(0, 300), body })
            .then(reload),
        update: (id, patch) => updateComment(id, patch).then(reload),
        remove: (id) => deleteComment(id).then(reload),
      }
      : null, [pageId, reload]);
  return { byRow, ops, meId };
}
