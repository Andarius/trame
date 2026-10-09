import { useEffect, useRef, useState } from "react";
import { type Block, getPage, type PageComment, type PageDetail, updatePage } from "../api";
import { genId, ensureIds } from "./page-ids";

/** Loads a page, live-refreshes it, and debounces block edits back to the server. */
export function usePageAutosave(
  pageId: string,
  onChanged: () => void,
  setComments: (c: PageComment[]) => void,
) {
  const [page, setPage] = useState<PageDetail | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
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
  useEffect(() => {
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

  return { page, setPage, blocks, blocksRef, reload, changeBlocks, patch };
}
