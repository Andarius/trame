import { type ReactNode, useState } from "react";
import { SlidersIcon } from "./icons";
import { IconButton, MenuRow, Popover, SECTION_LABEL } from "./ui";

// A sidebar list's sliders button: pick how its rows are grouped. `className` can hide it until its section's hover; open, it stays shown.
// `hints` show, on the right of each option, a sample of what it looks like.
export function GroupMenu<T extends string>(
  { value, options, hints, onChange, className = "" }: {
    value: T;
    options: Record<T, string>;
    hints?: Partial<Record<T, string>>; // a mono sample of what each option looks like
    onChange: (v: T) => void;
    className?: string;
  },
) {
  const [open, setOpen] = useState(false);
  return (
    <span className={`relative inline-flex ${className} ${open ? "opacity-100!" : ""}`}>
      <IconButton
        tone="close"
        className="px-1"
        title={`group by: ${options[value].toLowerCase()}`}
        aria-label="Grouping"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <SlidersIcon />
      </IconButton>
      {open && (
        <Popover portal onClose={() => setOpen(false)} className="min-w-52">
          <MenuSection label="GROUP BY" first>
            {(Object.keys(options) as T[]).map((g) => (
              <MenuOption
                key={g}
                active={g === value}
                label={options[g]}
                hint={hints?.[g]}
                onClick={() => {
                  onChange(g);
                  setOpen(false);
                }}
              />
            ))}
          </MenuSection>
        </Popover>
      )}
    </span>
  );
}

// a titled group of options; any after the first gets a divider
function MenuSection({ label, first, children }: { label: string; first?: boolean; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className={first ? "" : "mt-1 border-t border-line pt-1"}>
      <div className={`px-2 pb-0.5 pt-1 ${SECTION_LABEL}`}>{label}</div>
      {children}
    </div>
  );
}

// one choice of a menu section: a radio dot, its label, and an optional mono hint of what it looks like
function MenuOption({ active, label, hint, onClick }: { active: boolean; label: string; hint?: string; onClick: () => void }) {
  return (
    <MenuRow active={active} role="menuitemradio" aria-checked={active} onClick={onClick}>
      <span
        aria-hidden="true"
        className={`grid h-3 w-3 shrink-0 place-items-center rounded-full border ${active ? "border-copper" : "border-ink-faint/60"}`}
      >
        {active && <span className="h-1.5 w-1.5 rounded-full bg-copper" />}
      </span>
      <span className="flex-1">{label}</span>
      {hint && <span className="pl-3 font-mono text-[10.5px] text-ink-faint">{hint}</span>}
    </MenuRow>
  );
}
