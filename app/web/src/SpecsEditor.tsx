// The session ticket's SPECS pane: the real page block editor (slash menu, block
// comments) mounted on the card's spec page — a lazy subpage of its story.
import { useEffect, useState } from "react";
import {
  attachUdbToPage,
  type Block,
  createPage,
  createUdb,
  ensureSpecsPage,
  getIdentity,
} from "./api";
import { BlockEditor, genId } from "./Page";
import { useBlockDoc } from "./useBlockDoc";

const sectionLbl = "text-[10px] font-medium tracking-[0.8px] text-ink-muted/70";

export function SpecsEditor(
  { sessionId, specsPageId, onLinked, onOpenPage }: {
    sessionId: string;
    specsPageId: string | null;
    onLinked: () => void; // board refresh so the new specs_page_id arrives
    onOpenPage?: (id: string) => void;
  },
) {
  const [pageId, setPageId] = useState(specsPageId);
  useEffect(() => setPageId(specsPageId), [specsPageId, sessionId]);
  const [meId, setMeId] = useState<string | null>(null);
  useEffect(() => {
    getIdentity().then((i) => setMeId(i.userId)).catch(() => {});
  }, []);
  const doc = useBlockDoc(pageId);

  const addSpecs = () =>
    ensureSpecsPage(sessionId).then((r) => {
      setPageId(r.page_id);
      onLinked();
    }).catch(() => {});

  const slashInsert = (kind: "subpage" | "database", replaceIdx: number) => {
    if (!pageId) return;
    const next = doc.blocks.filter((_, j) => j !== replaceIdx);
    doc.changeBlocks(
      next.length ? next : [{ type: "text", text: "", id: genId() } as Block],
    );
    if (kind === "subpage") {
      createPage({ parent_id: pageId }).then((r) => onOpenPage?.(r.id));
    } else {
      createUdb("Untitled").then((r) => attachUdbToPage(r.id, pageId))
        .then(doc.reload);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className={sectionLbl}>SPECS</span>
        <span className="flex-1" />
        {pageId && (
          <button
            type="button"
            title="open the spec page"
            className="rounded-md px-1.5 py-0.5 text-[11px] text-ink-muted transition-colors hover:bg-panel hover:text-ink"
            onClick={() => onOpenPage?.(pageId)}
          >
            open as page ↗
          </button>
        )}
      </div>
      {pageId
        ? (
          <BlockEditor
            blocks={doc.blocks}
            onChange={doc.changeBlocks}
            onSlashInsert={slashInsert}
            onOpenReport={() => {}}
            comments={doc.comments}
            commentOps={doc.commentOps}
            showResolved={false}
            mode="inline"
            openThreads={doc.openThreads}
            focusThread={doc.focusThread}
            flash={null}
            meId={meId}
            onToggleThread={doc.toggleThread}
          />
        )
        : (
          <button
            type="button"
            className="rounded-md border border-dashed border-chipline px-3 py-2 text-left text-[12.5px] text-ink-muted/70 transition-colors hover:border-copper/60 hover:text-copper"
            onClick={addSpecs}
          >
            ＋ add specs…
          </button>
        )}
    </div>
  );
}
