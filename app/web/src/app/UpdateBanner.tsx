import { openInBrowser, type UpdateInfo, updateLabel } from "../api";
import { IconButton } from "../ui/ui";

export function UpdateBanner(
  { update, updateState, updateError, dismissed, onUpdate, onDismiss }: {
    update: UpdateInfo | null;
    updateState: "idle" | "busy" | "done";
    updateError?: string;
    dismissed: boolean;
    onUpdate: () => void;
    onDismiss: () => void;
  },
) {
  if (!update || !(update.available || update.applied) || dismissed) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[60] flex w-[320px] flex-col gap-2.5 rounded-xl border border-overlay-border bg-panel-modal p-3.5 shadow-2xl shadow-black/50">
      {updateState === "done"
        ? (
          <>
            <p className="m-0 text-[12.5px] font-medium text-ink">
              ✓ Updated to {updateLabel(update)}
            </p>
            <p className="m-0 text-[11.5px] leading-relaxed text-ink-muted">
              {update.rebuild ? "Rebuilt with your plugins" : "Downloaded in the background"} — restart Trame to run it.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-md px-2 py-1 text-[11.5px] text-ink-muted hover:text-ink-soft"
                onClick={onDismiss}
              >
                Later
              </button>
              <button
                type="button"
                className="rounded-md bg-copper px-2.5 py-1 text-[11.5px] font-medium text-copper-ink hover:brightness-110"
                onClick={onUpdate}
              >
                Restart now
              </button>
            </div>
          </>
        )
        : (
          <>
            <p className="m-0 text-[12.5px] font-medium text-ink">
              <span className="text-copper">↑</span> {updateLabel(update)} available
            </p>
            <p className="m-0 text-[11.5px] text-ink-muted">
              You're on v{update.current}.{" "}
              <button
                type="button"
                className="text-ink-muted underline decoration-chipline underline-offset-2 hover:text-ink-soft"
                onClick={() => openInBrowser(update.releaseUrl)}
              >
                Release notes
              </button>
              {update.rebuild && " Updating rebuilds Trame with your plugins (a few minutes)."}
            </p>
            {updateError && <p className="m-0 text-[11.5px] text-blocked">{updateError}</p>}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-md px-2 py-1 text-[11.5px] text-ink-muted hover:text-ink-soft"
                onClick={onDismiss}
              >
                Later
              </button>
              <button
                type="button"
                className="rounded-md bg-copper px-2.5 py-1 text-[11.5px] font-medium text-copper-ink hover:brightness-110 disabled:opacity-60"
                disabled={updateState === "busy"}
                onClick={onUpdate}
              >
                {updateState === "busy"
                  ? update.rebuild ? "Rebuilding…" : "Updating…"
                  : update.canSelfUpdate
                  ? "Update now"
                  : "Open release"}
              </button>
            </div>
          </>
        )}
    </div>
  );
}

export function SelectionBar(
  { count, onDelete, onClear }: { count: number; onDelete: () => void; onClear: () => void },
) {
  return (
    <div className="fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-line bg-panel px-3.5 py-2 shadow-xl shadow-black/40">
      <span className="text-[12px] text-ink-soft">
        {count} selected
      </span>
      <button
        type="button"
        onClick={onDelete}
        className="rounded-md border border-blocked/50 px-2.5 py-1 text-[11.5px] text-blocked hover:bg-blocked/10"
      >
        Delete
      </button>
      <IconButton
        onClick={onClear}
        title="Clear selection (Esc)"
        className="text-[13px] text-ink-muted hover:text-ink-soft"
      >
        ✕
      </IconButton>
    </div>
  );
}
