import { useState } from "react";
import { SlidersIcon } from "./icons";
import { IconButton, MenuRow, Popover, SECTION_LABEL } from "./ui";

// A sidebar list's sliders button: pick how its rows are grouped.
export function GroupMenu<T extends string>(
  { value, options, onChange }: { value: T; options: Record<T, string>; onChange: (v: T) => void },
) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex">
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
        <Popover onClose={() => setOpen(false)} style={{ left: "auto", right: 0 }}>
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
