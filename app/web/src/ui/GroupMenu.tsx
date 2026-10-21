import { useState } from "react";
import { SlidersIcon } from "./icons";
import { IconButton, MenuRow, Popover, SECTION_LABEL } from "./ui";

// A sidebar list's sliders button: pick how its rows are grouped. `className` can hide it until its section's hover.
export function GroupMenu<T extends string>(
  { value, options, onChange, className = "", align = "right" }: {
    value: T;
    options: Record<T, string>;
    onChange: (v: T) => void;
    className?: string;
    align?: "left" | "right"; // the menu's edge lined up with the button's
  },
) {
  const [open, setOpen] = useState(false);
  return (
    <span className={`relative inline-flex ${open ? "" : className}`}>
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
        <Popover onClose={() => setOpen(false)} style={align === "right" ? { left: "auto", right: 0 } : undefined}>
          <div className={`px-2 pb-1 pt-0.5 ${SECTION_LABEL}`}>GROUP BY</div>
          {(Object.keys(options) as T[]).map((g) => (
            <MenuRow
              key={g}
              active={g === value}
              onClick={() => {
                onChange(g);
                setOpen(false);
              }}
            >
              <span className="w-3 text-center">{g === value ? "✓" : ""}</span>
              <span className="flex-1">{options[g]}</span>
            </MenuRow>
          ))}
        </Popover>
      )}
    </span>
  );
}
