import { type ReactNode, useState } from "react";
import { SlidersIcon } from "./icons";
import { IconButton, MenuRow, Popover, SECTION_LABEL } from "./ui";

// another choice of a view menu, below GROUP BY (e.g. row spacing)
export type MenuChoice = { key: string; label: string; value: string; options: Record<string, string>; onChange: (v: string) => void };

// A sidebar list's sliders button: pick how its rows are grouped. `className` can hide it until its section's hover; open, it stays shown.
// `hints` show, under each option, a sample of what it looks like; `more` adds other choices below the groupings;
// `preview` draws the list beside the options, for the option hovered (else the picked one).
export function GroupMenu<T extends string>(
  { value, options, hints, more = [], preview, onChange, className = "" }: {
    value: T;
    options: Record<T, string>;
    hints?: Partial<Record<T, string>>;
    more?: MenuChoice[];
    preview?: (group: T, more: Record<string, string>) => ReactNode;
    onChange: (v: T) => void;
    className?: string;
  },
) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<{ key: string; value: string } | null>(null);
  const group = hover?.key === "" ? hover.value as T : value;
  const picked = Object.fromEntries(more.map((m) => [m.key, hover?.key === m.key ? hover.value : m.value]));
  const opts = (
    <div className="flex flex-col" onMouseLeave={() => setHover(null)}>
      <MenuSection label="GROUP BY" first>
        {(Object.keys(options) as T[]).map((g) => (
          <MenuOption
            key={g}
            active={g === value}
            label={options[g]}
            hint={preview ? undefined : hints?.[g]}
            onHover={() => setHover({ key: "", value: g })}
            onClick={() => {
              onChange(g);
              // a menu with other choices or a preview stays open to keep tuning
              if (!preview && !more.length) setOpen(false);
            }}
          />
        ))}
      </MenuSection>
      {more.map((m) => (
        <MenuSection key={m.key} label={m.label}>
          {Object.entries(m.options).map(([v, l]) => (
            <MenuOption
              key={v}
              active={v === m.value}
              label={l}
              onHover={() => setHover({ key: m.key, value: v })}
              onClick={() => m.onChange(v)}
            />
          ))}
        </MenuSection>
      ))}
    </div>
  );
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
        <Popover portal onClose={() => setOpen(false)} className="min-w-44">
          {preview
            ? (
              <div className="grid grid-cols-[auto_200px]">
                <div className="border-r border-line pr-1.5">{opts}</div>
                <div className="ml-1.5 overflow-hidden rounded-md bg-canvas p-2.5" aria-label="preview">{preview(group, picked)}</div>
              </div>
            )
            : opts}
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

// one choice of a menu section: a radio dot, its label, and an optional mono sample of what it looks like under it
function MenuOption(
  { active, label, hint, onHover, onClick }: { active: boolean; label: string; hint?: string; onHover?: () => void; onClick: () => void },
) {
  return (
    <MenuRow active={active} role="menuitemradio" aria-checked={active} onClick={onClick} onMouseEnter={onHover} className="items-start">
      <span
        aria-hidden="true"
        className={`mt-[3px] grid h-3 w-3 shrink-0 place-items-center rounded-full border ${active ? "border-copper" : "border-ink-faint/60"}`}
      >
        {active && <span className="h-1.5 w-1.5 rounded-full bg-copper" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="whitespace-nowrap">{label}</span>
        {hint && <span className="pt-0.5 font-mono text-[10.5px] text-ink-faint">{hint}</span>}
      </span>
    </MenuRow>
  );
}
