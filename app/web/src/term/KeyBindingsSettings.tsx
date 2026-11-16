import { useState } from "react";
import { pill } from "../modals/modal-ui";
import { IconButton } from "../ui/ui";
import { comboOf, DEFAULT_BINDINGS, getKeyBindings, type KeyBinding, setKeyBindings } from "./key-bindings";

// Settings' terminal key bindings: press a key combo, type what the shell gets
export function KeyBindingsSettings() {
  const [rows, setRows] = useState<KeyBinding[]>(getKeyBindings);
  const save = (next: KeyBinding[]) => {
    setRows(next);
    setKeyBindings(next.filter((b) => b.keys));
  };
  const edit = (i: number, patch: Partial<KeyBinding>) => save(rows.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((b, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            readOnly
            aria-label="Key combination"
            placeholder="press keys…"
            value={b.keys}
            className={`${pill} w-44 cursor-pointer font-mono text-[12px]`}
            onKeyDown={(e) => {
              if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) return;
              e.preventDefault();
              const keys = comboOf(e.nativeEvent);
              if (keys) edit(i, { keys });
            }}
          />
          <span className="text-ink-faint">→</span>
          <input
            aria-label="Sends"
            placeholder="^U, \e[H, text\r"
            value={b.send}
            onChange={(e) => edit(i, { send: e.target.value })}
            className={`${pill} w-44 font-mono text-[12px]`}
          />
          <IconButton tone="danger" className="px-1" title="remove" onClick={() => save(rows.filter((_, j) => j !== i))}>
            ✕
          </IconButton>
        </div>
      ))}
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="w-fit rounded-md px-1 py-0.5 text-[11.5px] text-ink-muted hover:text-ink-soft"
          onClick={() => setRows([...rows, { keys: "", send: "" }])}
        >
          + Add a key
        </button>
        <button
          type="button"
          className="w-fit rounded-md px-1 py-0.5 text-[11.5px] text-ink-muted hover:text-ink-soft"
          onClick={() => save([...DEFAULT_BINDINGS])}
        >
          Reset
        </button>
      </div>
    </div>
  );
}
