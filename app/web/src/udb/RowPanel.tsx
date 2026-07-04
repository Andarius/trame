import { useEffect, useRef, useState } from "react";
import { deleteUdbRow, patchUdbRow, type UdbProp, type UdbRow } from "../api";
import { appConfirm, EntityIcon } from "../ui";
import { Cell, IconPicker } from "./cells";
import { TYPE_GLYPH } from "./PropertyEditor";

const sectionLbl = "text-[10px] font-medium tracking-[0.8px] text-ink-muted/70";

export function RowPanel(
  { db, properties, row, onClose, onSaved }: {
    db: { id: string; name: string };
    properties: UdbProp[];
    row: UdbRow;
    onClose: () => void;
    onSaved: () => void;
  },
) {
  const titleProp = properties.find((p) => p.type === "title");
  const [title, setTitle] = useState(String(row.vals[titleProp?.id ?? ""] ?? ""));
  const [iconOpen, setIconOpen] = useState(false);
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(flashTimer.current), []);

  const flashSaved = () => {
    setFlash(true);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(false), 1500);
  };
  const patch = (propId: string, value: unknown) =>
    patchUdbRow(row.id, { [propId]: value }).then(() => {
      onSaved();
      flashSaved();
    });

  const remove = async () => {
    if (await appConfirm("Delete this row?")) deleteUdbRow(row.id).then(onClose).then(onSaved);
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", h);
    return () => removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <div className="flex h-full w-[400px] shrink-0 flex-col overflow-y-auto border-l border-line bg-sidebar shadow-[-16px_0_40px_rgba(0,0,0,0.35)]">
      <div className="flex items-center gap-2 px-4 pb-1 pt-3.5">
        <span className={sectionLbl}>{db.name.toUpperCase()}</span>
        <span className="flex-1" />
        <button type="button"
          className="rounded-md px-1.5 py-0.5 text-[13px] text-ink-muted transition-colors hover:bg-panel hover:text-ink"
          title="close (esc)"
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      <div className="flex flex-col gap-3 px-4 pb-4">
        <div className="flex items-start gap-1.5">
          <div className="relative">
            <button type="button"
              className="mt-0.5 rounded p-1 text-[15px] leading-none transition-colors hover:bg-panel"
              title="row icon"
              onClick={() => setIconOpen(true)}
            >
              <EntityIcon icon={row.icon} fallback="◌" className={row.icon ? "" : "text-ink-muted/60"} />
            </button>
            {iconOpen && (
              <IconPicker
                current={row.icon}
                onPick={(icon) =>
                  patchUdbRow(row.id, {}, icon).then(() => {
                    onSaved();
                    flashSaved();
                  })}
                onClose={() => setIconOpen(false)}
              />
            )}
          </div>
          <textarea
            className="field-sizing-content flex-1 resize-none rounded-md border border-transparent bg-transparent px-1 py-0.5 text-[15px] font-semibold leading-snug text-ink outline-none transition-colors hover:bg-panel/60 focus:border-chipline focus:bg-panel"
            rows={2}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => titleProp && title !== String(row.vals[titleProp.id] ?? "") && patch(titleProp.id, title || null)}
          />
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-1 border-t border-line-soft px-4 py-3.5">
        {properties.filter((p) => p.type !== "title").map((p) => (
          <div key={p.id} className="grid grid-cols-[110px_1fr] items-start gap-x-2">
            <span className="flex items-center gap-1.5 truncate pt-[7px] text-[11px] text-ink-muted" title={p.type}>
              <span className="text-[10px] opacity-60">{TYPE_GLYPH[p.type] ?? "?"}</span>
              {p.name}
            </span>
            <div className="min-w-0">
              <Cell prop={p} row={row} onPatch={patch} onSaved={onSaved} onPropChanged={onSaved} />
            </div>
          </div>
        ))}
        {properties.length <= 1 && <span className="py-1 text-[11px] text-ink-muted/60">No columns yet.</span>}
      </div>

      <div className="sticky bottom-0 mt-auto flex items-center gap-2 border-t border-line bg-sidebar px-4 py-2.5">
        <button type="button" className="text-[11px] text-ink-muted transition-colors hover:text-blocked" onClick={remove}>
          Delete row
        </button>
        <span className="flex-1" />
        <span
          className={`text-[10.5px] transition-opacity duration-300 ${flash ? "opacity-100" : "opacity-0"}`}
          style={{ color: "var(--color-active)" }}
        >
          ✓ Saved
        </span>
        <span className="text-[10px] text-ink-muted/50">auto-saves · esc to close</span>
      </div>
    </div>
  );
}
