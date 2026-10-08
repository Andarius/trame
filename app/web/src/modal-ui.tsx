export const label = "text-[10px] font-medium tracking-[0.8px] text-ink-muted/80";
export const input =
  "w-full bg-transparent outline-none placeholder:text-ink-muted/50 border-none p-0 text-ink";
export const STORY_PLACEHOLDER = "The brief — why this matters.\n\nDone when:\n·  …\n·  …";
export const pill =
  "appearance-none rounded-md border border-chipline bg-transparent px-2 py-1 text-[11.5px] text-ink-soft outline-none";

export function Footer(
  { hint, action, onClose, onSubmit, disabled }: {
    hint: string;
    action: string;
    onClose: () => void;
    onSubmit: () => void;
    disabled: boolean;
  },
) {
  return (
    <>
      <div className="h-px bg-line" />
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[10.5px] text-ink-muted/85">{hint}</span>
        <button type="button" className="rounded-md px-2.5 py-1.5 text-xs text-ink-muted hover:text-ink-soft" onClick={onClose}>
          Cancel
        </button>
        <button type="button"
          className="flex items-center gap-1.5 rounded-md bg-copper px-3 py-1.5 text-[12.5px] font-medium text-copper-ink disabled:opacity-40"
          onClick={onSubmit}
          disabled={disabled}
        >
          {action} <span className="text-[10.5px] opacity-70">⌘↵</span>
        </button>
      </div>
    </>
  );
}

export const segTrack = "flex w-fit gap-0.5 rounded-[7px] bg-panel p-[3px]";
export const seg = (on: boolean) =>
  `whitespace-nowrap rounded-[5px] px-2.5 py-[3px] text-[12.5px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper ${
    on ? "bg-tab-active text-ink shadow-sm" : "text-ink-muted hover:text-ink-soft"
  }`;

export function CheckRow({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-soft">
      <Check on={on} onClick={() => onChange(!on)} />
      {label}
    </label>
  );
}

export function Check({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] transition-colors disabled:opacity-30"
      disabled={disabled}
      onClick={onClick}
    >
      <span
        className={`flex h-full w-full items-center justify-center rounded ${
          on ? "border border-copper text-copper" : "border border-chipline text-transparent"
        }`}
      >
        ✓
      </span>
    </button>
  );
}
