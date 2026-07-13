import { useEffect, useState } from "react";
import {
  createUdbProp,
  deleteUdbProp,
  getUdb,
  type PropConfig,
  type PropType,
  type SelectOption,
  type UdbMeta,
  type UdbProp,
  updateUdbProp,
} from "../api";
import { appConfirm, Popover, Select } from "../ui";
import { OPTION_COLORS } from "./cells";

const TYPES: { key: PropType; label: string; glyph: string }[] = [
  { key: "text", label: "Text", glyph: "≡" },
  { key: "number", label: "Number", glyph: "#" },
  { key: "select", label: "Select", glyph: "▾" },
  { key: "multi_select", label: "Multi-select", glyph: "≔" },
  { key: "date", label: "Date", glyph: "◷" },
  { key: "url", label: "URL", glyph: "↗" },
  { key: "checkbox", label: "Checkbox", glyph: "☑" },
  { key: "relation", label: "Relation", glyph: "⇄" },
  { key: "formula", label: "Formula", glyph: "ƒ" },
  { key: "rollup", label: "Rollup", glyph: "∑" },
];

export const TYPE_GLYPH: Record<string, string> = Object.fromEntries(
  [...TYPES.map((t) => [t.key, t.glyph]), ["title", "Aa"]],
);

const FORMULA_PLACEHOLDER = "impact * confidence * ease\nround(x, 1), nullif(y, 0), case when … end";
const lbl = "text-[10px] font-medium tracking-[0.6px] text-ink-muted/75";
const field =
  "w-full rounded-md border border-chipline bg-transparent px-2 py-1.5 text-xs text-ink outline-none focus:border-copper/60";

export function PropertyEditor(
  { dbId, prop, allProps, udbs, sortDir, onSort, onClose, onSaved }: {
    dbId: string;
    prop: UdbProp | null; // null = create
    allProps: UdbProp[];
    udbs: UdbMeta[];
    sortDir?: 1 | -1 | null; // current sort direction on THIS column, if any
    onSort?: (dir: 1 | -1 | null) => void; // null = clear sort
    onClose: () => void;
    onSaved: () => void;
  },
) {
  const [name, setName] = useState(prop?.name ?? "");
  const [type, setType] = useState<PropType>(prop?.type ?? "text");
  const [config, setConfig] = useState<PropConfig>(prop?.config ?? {});
  const [error, setError] = useState<string | null>(null);
  const [targetProps, setTargetProps] = useState<UdbProp[]>([]);

  const relationProps = allProps.filter((p) => p.type === "relation");
  const rollupRel = relationProps.find((p) => p.id === config.relation_prop);
  useEffect(() => {
    if (type === "rollup" && rollupRel?.config.target_db) {
      getUdb(rollupRel.config.target_db).then((u) => setTargetProps(u.properties)).catch(() => {});
    }
  }, [type, rollupRel?.config.target_db]);

  const set = (patch: PropConfig) => setConfig((c) => ({ ...c, ...patch }));

  const save = async () => {
    setError(null);
    try {
      if (prop) await updateUdbProp(prop.id, { name: name || prop.name, config });
      else await createUdbProp(dbId, { name: name || "Untitled", type, config });
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async () => {
    if (!prop) return;
    const extra = prop.type === "relation" ? " (removes both sides of the relation)" : "";
    if (await appConfirm(`Delete column "${prop.name}"?${extra}`)) {
      deleteUdbProp(prop.id).then(() => {
        onSaved();
        onClose();
      });
    }
  };

  const options = config.options ?? [];
  const patchOption = (i: number, patch: Partial<SelectOption>) =>
    set({ options: options.map((o, j) => (j === i ? { ...o, ...patch } : o)) });

  return (
    <Popover onClose={onClose} className="w-[260px] p-2.5">
      <div className="flex flex-col gap-2.5">
        {prop && onSort && (
          <div className="flex items-center gap-1">
            <button type="button"
              className={`flex flex-1 items-center justify-center gap-1 rounded-md border py-1 text-[11px] transition-colors ${
                sortDir === 1 ? "border-copper/60 text-copper" : "border-chipline text-ink-muted hover:text-ink-soft"
              }`}
              onClick={() => {
                onSort(1);
                onClose();
              }}
            >
              ▲ Ascending
            </button>
            <button type="button"
              className={`flex flex-1 items-center justify-center gap-1 rounded-md border py-1 text-[11px] transition-colors ${
                sortDir === -1 ? "border-copper/60 text-copper" : "border-chipline text-ink-muted hover:text-ink-soft"
              }`}
              onClick={() => {
                onSort(-1);
                onClose();
              }}
            >
              ▼ Descending
            </button>
            {sortDir != null && (
              <button type="button"
                className="rounded-md border border-chipline px-2 py-1 text-[11px] text-ink-muted hover:text-blocked"
                title="clear sort"
                onClick={() => {
                  onSort(null);
                  onClose();
                }}
              >
                ✕
              </button>
            )}
          </div>
        )}
        <label className="flex flex-col gap-1">
          <span className={lbl}>NAME</span>
          <input autoFocus className={field} value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        {!prop && (
          <label className="flex flex-col gap-1">
            <span className={lbl}>TYPE</span>
            <Select
              value={type}
              options={TYPES.map((t) => ({ value: t.key, label: `${t.glyph} ${t.label}` }))}
              onChange={(v) => setType(v as PropType)}
            />
          </label>
        )}

        {type === "number" && (
          <label className="flex flex-col gap-1">
            <span className={lbl}>FORMAT</span>
            <Select
              value={config.format ?? "plain"}
              options={[
                { value: "plain", label: "Plain" },
                { value: "euro", label: "Euro (€)" },
                { value: "dollar", label: "Dollar ($)" },
                { value: "percent", label: "Percent (%)" },
              ]}
              onChange={(v) => set({ format: v as PropConfig["format"] })}
            />
          </label>
        )}

        {(type === "select" || type === "multi_select") && (
          <div className="flex flex-col gap-1">
            <span className={lbl}>OPTIONS</span>
            {options.map((o, i) => (
              <div key={o.id} className="flex items-center gap-1.5">
                <button type="button"
                  className="h-3.5 w-3.5 shrink-0 rounded-full border border-black/30"
                  style={{ background: o.color }}
                  title="cycle color"
                  onClick={() =>
                    patchOption(i, {
                      color: OPTION_COLORS[(OPTION_COLORS.indexOf(o.color) + 1) % OPTION_COLORS.length],
                    })}
                />
                <input
                  className={`${field} py-1`}
                  value={o.name}
                  onChange={(e) => patchOption(i, { name: e.target.value })}
                />
                <button type="button"
                  className="px-0.5 text-ink-muted hover:text-blocked"
                  onClick={() => set({ options: options.filter((_, j) => j !== i) })}
                >
                  ✕
                </button>
              </div>
            ))}
            <button type="button"
              className="w-fit rounded px-1 py-0.5 text-[11px] text-ink-muted hover:text-ink-soft"
              onClick={() =>
                set({
                  options: [...options, {
                    id: crypto.randomUUID().slice(0, 8),
                    name: `Option ${options.length + 1}`,
                    color: OPTION_COLORS[options.length % OPTION_COLORS.length],
                  }],
                })}
            >
              ＋ Add option
            </button>
          </div>
        )}

        {type === "date" && (
          <button
            type="button"
            className="flex w-fit items-center gap-2 text-xs text-ink-soft"
            onClick={() => set({ end: !config.end || undefined })}
          >
            <span
              className={`flex h-4 w-4 items-center justify-center rounded border text-[10px] transition-colors ${
                config.end ? "border-copper bg-copper text-copper-ink" : "border-chipline text-transparent"
              }`}
            >
              ✓
            </span>
            End date (range)
          </button>
        )}

        {type === "relation" && !prop && (
          <>
            <label className="flex flex-col gap-1">
              <span className={lbl}>RELATED TO</span>
              <Select
                value={config.target_db ?? ""}
                placeholder="choose database…"
                options={udbs.map((d) => ({ value: d.id, label: d.name }))}
                onChange={(v) => set({ target_db: v })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={lbl}>REVERSE PROPERTY NAME</span>
              <input
                className={field}
                placeholder="(defaults to this database's name)"
                value={config.reverse_name ?? ""}
                onChange={(e) => set({ reverse_name: e.target.value || undefined })}
              />
            </label>
          </>
        )}
        {type === "relation" && prop && (
          <p className="m-0 text-[11px] text-ink-muted">
            ⇄ {udbs.find((d) => d.id === prop.config.target_db)?.name ?? "?"} ·{" "}
            {prop.config.owner ? "owner side" : "reverse side"}
          </p>
        )}

        {type === "formula" && (
          <label className="flex flex-col gap-1">
            <span className={lbl}>SQL EXPRESSION</span>
            <textarea
              className={`${field} min-h-[64px] resize-y font-mono text-[11px]`}
              placeholder={FORMULA_PLACEHOLDER}
              value={config.expr ?? ""}
              onChange={(e) => set({ expr: e.target.value })}
            />
            <span className="text-[10px] text-ink-muted/70">
              reference columns by name — bare (<code>impact</code>) or quoted (<code>"ICE score"</code>)
            </span>
          </label>
        )}

        {type === "rollup" && (
          <>
            <label className="flex flex-col gap-1">
              <span className={lbl}>RELATION</span>
              <Select
                value={config.relation_prop ?? ""}
                placeholder="choose relation…"
                options={relationProps.map((p) => ({ value: p.id, label: p.name }))}
                onChange={(v) => set({ relation_prop: v })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={lbl}>CALCULATE</span>
              <Select
                value={config.agg ?? "count"}
                options={["count", "sum", "avg", "min", "max", "latest"].map((a) => ({ value: a, label: a }))}
                onChange={(v) => set({ agg: v as PropConfig["agg"] })}
              />
            </label>
            {config.agg !== "count" && (
              <label className="flex flex-col gap-1">
                <span className={lbl}>TARGET PROPERTY</span>
                <Select
                  value={config.target_prop ?? ""}
                  placeholder="choose property…"
                  options={targetProps
                    .filter((p) => !["relation", "formula", "rollup"].includes(p.type))
                    .map((p) => ({ value: p.id, label: p.name }))}
                  onChange={(v) => set({ target_prop: v })}
                />
              </label>
            )}
            {config.agg === "latest" && (
              <label className="flex flex-col gap-1">
                <span className={lbl}>LATEST BY (DATE)</span>
                <Select
                  value={config.date_prop ?? ""}
                  options={[
                    { value: "", label: "last edited" },
                    ...targetProps.filter((p) => p.type === "date").map((p) => ({ value: p.id, label: p.name })),
                  ]}
                  onChange={(v) => set({ date_prop: v || undefined })}
                />
              </label>
            )}
          </>
        )}

        {error && <p className="m-0 whitespace-pre-wrap text-[11px] leading-snug text-blocked">{error}</p>}

        <div className="flex items-center gap-2 border-t border-line pt-2">
          {prop && prop.type !== "title" && (
            <button type="button" className="text-[11px] text-ink-muted hover:text-blocked" onClick={remove}>Delete</button>
          )}
          <span className="flex-1" />
          <button type="button" className="rounded-md px-2 py-1 text-xs text-ink-muted hover:text-ink-soft" onClick={onClose}>
            Cancel
          </button>
          <button type="button"
            className="rounded-md bg-copper px-2.5 py-1 text-xs font-medium text-copper-ink hover:brightness-110"
            onClick={save}
          >
            {prop ? "Save" : "Add"}
          </button>
        </div>
      </div>
    </Popover>
  );
}
