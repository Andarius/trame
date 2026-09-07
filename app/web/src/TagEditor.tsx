import { type CSSProperties, useEffect, useState } from "react";
import { splitTagLabel, TAG_COLORS, tagKey } from "../../tags.ts";
import { ensureTag, listTags, type Tag, updateTag } from "./api";
import { Popover } from "./ui";

/** Fill + text for a hue, mixed with the theme's ink so one hex reads in both. */
const tint = (color: string): CSSProperties => ({
  background: `color-mix(in srgb, ${color} var(--tag-tint), transparent)`,
  color:
    `color-mix(in srgb, ${color} calc(100% - var(--tag-shade)), var(--color-ink))`,
});

/** The namespace half before anyone colours it: a wash of ink, not of hue. */
const NEUTRAL_NS: CSSProperties = {
  background: "color-mix(in srgb, var(--color-ink-muted) 10%, transparent)",
  color: "var(--color-ink-muted)",
};

/**
 * Tag chips on a page, with a picker to add one.
 *
 * A page stores tag KEYS, not ids: a key with no vocabulary row still renders,
 * as its own slug. That is the whole point of storing the key — a page pulled
 * from another device before its tags arrived is readable rather than blank.
 *
 * A label with a colon renders split: `cockpit:devops` is a dim `cockpit` half
 * and a coloured `devops` half. The prefix repeats on every tag a source writes,
 * so it stops earning full contrast — and its colour comes from the tag row of
 * the namespace ITSELF (`cockpit`), which is why every `cockpit:*` pill shares
 * one hue instead of each carrying its own copy.
 */
export function TagEditor(
  { tags, onChange }: { tags: string[]; onChange: (next: string[]) => void },
) {
  const [open, setOpen] = useState(false);
  const [known, setKnown] = useState<Tag[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  // which half of which chip has its swatches open
  const [picking, setPicking] = useState<{ key: string; ns: boolean } | null>(
    null,
  );

  // On mount, not on open: the chips below render a label out of this list, so
  // waiting for the picker showed every tag as its raw key until you clicked.
  useEffect(() => {
    listTags().then(setKnown).catch(() => {});
  }, [open]);

  const byKey = new Map(known.map((t) => [t.key, t]));
  const trimmed = query.trim();
  // A row that only exists to colour a namespace is not itself a tag to put on
  // a page — offering `cockpit` next to `cockpit:devops` would just be a trap.
  const namespaces = new Set(
    known.map((t) => splitTagLabel(t.label).ns).filter((n): n is string => !!n)
      .map(tagKey),
  );
  const matches = known.filter((t) =>
    !tags.includes(t.key) &&
    !namespaces.has(t.key) &&
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

  // Colouring a namespace creates its vocabulary row on the spot: until someone
  // picks a hue there is nothing to store, so the row is the pick.
  const recolor = async (
    row: Tag | undefined,
    label: string,
    color: string,
  ) => {
    if (row) await updateTag(row.id, { color });
    else await ensureTag(label, color);
    setPicking(null);
    setKnown(await listTags());
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((key) => {
        const t = byKey.get(key);
        const { ns, value } = splitTagLabel(t?.label ?? key);
        const nsRow = ns ? byKey.get(tagKey(ns)) : undefined;
        const valStyle = tint(t?.color ?? TAG_COLORS[0]);
        const picked = picking?.key === key;
        return (
          <span
            key={key}
            className="group relative inline-flex items-stretch text-[11px] leading-[1.45]"
          >
            {ns && (
              <button
                type="button"
                title={`Colour every ${ns}: tag`}
                className="cursor-pointer rounded-l-full py-px pl-[9px] pr-[7px]"
                style={nsRow ? tint(nsRow.color) : NEUTRAL_NS}
                onClick={() =>
                  setPicking(picked && picking.ns ? null : { key, ns: true })}
              >
                {ns}
              </button>
            )}
            <button
              type="button"
              title={t ? "Colour this tag" : `Unknown tag: ${key}`}
              disabled={!t}
              className={`cursor-pointer py-px pl-[9px] pr-[7px] font-medium ${
                ns ? "" : "rounded-l-full"
              }`}
              style={valStyle}
              onClick={() =>
                setPicking(picked && !picking.ns ? null : { key, ns: false })}
            >
              {value}
            </button>
            <button
              type="button"
              title="Remove"
              className="rounded-r-full py-px pr-[6px] text-[8px] opacity-0 transition-opacity hover:opacity-100 group-hover:opacity-55"
              style={valStyle}
              onClick={() => onChange(tags.filter((k) => k !== key))}
            >
              ✕
            </button>
            {picked && (
              <Popover
                onClose={() => setPicking(null)}
                style={{ minWidth: 0 }}
              >
                <div className="flex gap-1">
                  {TAG_COLORS.map((c) => {
                    const row = picking.ns ? nsRow : t;
                    return (
                      <button
                        type="button"
                        key={c}
                        title={c}
                        className={`h-[19px] w-[19px] rounded-md ${
                          row?.color === c
                            ? "ring-2 ring-ink ring-offset-1 ring-offset-panel-modal"
                            : ""
                        }`}
                        style={{ background: c }}
                        onClick={() =>
                          recolor(
                            row,
                            picking.ns ? ns! : (t?.label ?? key),
                            c,
                          )}
                      />
                    );
                  })}
                </div>
              </Popover>
            )}
          </span>
        );
      })}

      <div className="relative">
        <button
          type="button"
          title="add a tag"
          className="rounded-full border border-dashed border-chipline px-[7px] text-[11px] leading-[1.45] text-ink-muted hover:border-solid hover:text-ink-soft"
          onClick={() => setOpen((o) => !o)}
        >
          +
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
