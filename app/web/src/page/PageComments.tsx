import { IconButton, SECTION_LABEL } from "../ui/ui";
import { AddNote, anchorQuoteOf, answeredIn, CommentItem, RowNote } from "./comments";
import type { CommentView } from "./comments-state";

/** Open-all / show-resolved / inline-panel toggles above the page's blocks. */
export function CommentsToolbar({ cv }: { cv: CommentView }) {
  const {
    openCount,
    resolvedCount,
    commentMode,
    setFocusThread,
    putOpenThreads,
    allOpen,
    commentedIds,
    setPanelOpen,
    panelOpen,
    showResolved,
    setShowResolved,
    comments,
    blockIds,
    setMode,
  } = cv;
  if (!(openCount > 0 || resolvedCount > 0)) return null;
  return (
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
  );
}

/** Comments whose block no longer exists. */
export function OrphanComments({ cv, meId }: { cv: CommentView; meId: string | null }) {
  const { orphans, commentOps } = cv;
  if (orphans.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line-soft bg-panel/30 p-3">
      <span className={`${SECTION_LABEL}`}>
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
  );
}

/** Side panel listing the page's threads in block order (panel mode). */
export function CommentsPanel({ cv, meId }: { cv: CommentView; meId: string | null }) {
  const {
    commentMode,
    panelOpen,
    openCount,
    resolvedCount,
    showResolved,
    setShowResolved,
    setPanelOpen,
    panelThreads,
    flashBlock,
    commentOps,
  } = cv;
  if (!(commentMode === "panel" && panelOpen)) return null;
  return (
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
        <IconButton
          title="close"
          className="text-[11px] text-ink-muted transition-colors hover:text-ink-soft"
          onClick={() => setPanelOpen(false)}
        >
          ✕
        </IconButton>
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
  );
}
