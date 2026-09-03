import { useEffect, useState } from "react";
import { ensureTag, listTags, type Tag } from "./api";
import { Popover } from "./ui";

/**
 * Tag chips on a page, with a picker to add one.
 *
 * A page stores tag KEYS, not ids: a key with no vocabulary row still renders,
 * as its own slug. That is the whole point of storing the key — a page pulled
 * from another device before its tags arrived is readable rather than blank.
 */
export function TagEditor(
  { tags, onChange }: { tags: string[]; onChange: (next: string[]) => void },
) {
  const [open, setOpen] = useState(false);
  const [known, setKnown] = useState<Tag[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  // On mount, not on open: the chips below render a label out of this list, so
  // waiting for the picker showed every tag as its raw key until you clicked.
  useEffect(() => {
    listTags().then(setKnown).catch(() => {});
  }, [open]);

  const byKey = new Map(known.map((t) => [t.key, t]));
  const trimmed = query.trim();
  const matches = known.filter((t) =>
    !tags.includes(t.key) &&
    t.label.toLowerCase().includes(trimmed.toLowerCase())
  );
  // Only offer creation when nothing already carries that label, so two tags
  // never end up indistinguishable in the picker.
  const canCreate = trimmed.length > 1 &&
    !known.some((t) => t.label.toLowerCase() === trimmed.toLowerCase());

  const add = async (label: string) => {
    setBusy(true);
    try {
      const { key } = await ensureTag(label);
      if (!tags.includes(key)) onChange([...tags, key]);
      setQuery("");
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1">
      {tags.map((key) => {
        const t = byKey.get(key);
        return (
          <span
            key={key}
            className="group inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[11px] text-ink-muted"
            style={t
              ? { borderColor: `${t.color}66`, color: t.color }
              : undefined}
          >
            {t?.label ?? key}
            <button
              type="button"
              title="remove"
              className="opacity-0 transition-opacity hover:text-ink group-hover:opacity-100"
              onClick={() => onChange(tags.filter((k) => k !== key))}
            >
              ✕
            </button>
          </span>
        );
      })}

      <div className="relative">
        <button
          type="button"
          title="add a tag"
          className="rounded-md border border-dashed border-chipline px-1.5 py-0.5 text-[11px] text-ink-muted hover:text-ink-soft"
          onClick={() => setOpen((o) => !o)}
        >
          ＋
        </button>
        {open && (
          <Popover
            onClose={() => setOpen(false)}
            className="left-0 w-56 p-1.5"
          >
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canCreate && !busy) add(trimmed);
              }}
              placeholder="Find or create a tag…"
              className="mb-1 w-full rounded-md border border-line bg-panel px-2 py-1 text-[11.5px] text-ink outline-none focus:border-chipline"
            />
            <div className="max-h-48 overflow-y-auto">
              {matches.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  disabled={busy}
                  onClick={() => add(t.label)}
                  className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11.5px] text-ink-soft hover:bg-panel disabled:opacity-50"
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: t.color }}
                  />
                  <span className="truncate">{t.label}</span>
                </button>
              ))}
              {canCreate && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => add(trimmed)}
                  className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11.5px] text-ink-muted hover:bg-panel disabled:opacity-50"
                >
                  ＋ Create “{trimmed}”
                </button>
              )}
              {!canCreate && matches.length === 0 && (
                <div className="px-1.5 py-1 text-[11.5px] text-ink-muted">
                  No tags
                </div>
              )}
            </div>
          </Popover>
        )}
      </div>
    </div>
  );
}
