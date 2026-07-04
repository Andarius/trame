import { useEffect, useRef, useState } from "react";
import { DateInput, Popover } from "../ui";
import {
  type Derived,
  getStatus,
  getUdb,
  listUdbIcons,
  openInBrowser,
  type PropConfig,
  type RelChip,
  type SelectOption,
  setUdbLink,
  type Udb,
  type UdbProp,
  type UdbRow,
  updateUdbProp,
} from "../api";

export const OPTION_COLORS = ["#7a9ee7", "#b590e7", "#c98a63", "#7bd88f", "#e3c567", "#e06c75", "#6b7280"];

const cellInput =
  "w-full truncate rounded-md border border-transparent bg-transparent px-1.5 py-1 text-xs text-ink outline-none transition-colors hover:bg-panel/70 focus:border-chipline focus:bg-panel";

export function fmtNumber(v: unknown, cfg: PropConfig): string {
  if (v === null || v === undefined || v === "" || Number.isNaN(Number(v))) return "";
  const n = Number(v);
  const s = cfg.precision != null ? n.toFixed(cfg.precision) : String(n);
  if (cfg.format === "euro") return `${s} €`;
  if (cfg.format === "dollar") return `$${s}`;
  if (cfg.format === "percent") return `${s} %`;
  return s;
}

export function OptionChip({ opt }: { opt: SelectOption }) {
  return (
    <span
      className="truncate rounded px-1.5 py-0.5 text-[10.5px] font-medium leading-none"
      style={{ color: opt.color, background: opt.color + "24" }}
    >
      {opt.name}
    </span>
  );
}

export { Popover };

const QUICK_ICONS = [
  "🎯", "📊", "📈", "🧪", "🤖", "💡", "📚", "📣",
  "📡", "✍️", "💽", "🔥", "⭐", "✅", "❓", "🗂️",
  "🚀", "🧵", "🗄️", "🔑", "🧠", "📦", "🛠️", "🌍",
];

// SVGs pass through untouched; raster images are downscaled to 64px so data URIs
// stay small enough to live in a synced text column.
async function downscale(src: string): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = src;
  });
  const S = 64;
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  const scale = Math.min(S / img.width, S / img.height, 1);
  const w = img.width * scale, h = img.height * scale;
  ctx.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
  return canvas.toDataURL("image/png");
}

async function dataUriToIcon(uri: string): Promise<string> {
  return uri.startsWith("data:image/svg") ? uri : await downscale(uri);
}

async function fileToIcon(file: File): Promise<string> {
  if (file.type === "image/svg+xml") {
    const text = await file.text();
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(text)))}`;
  }
  const url = URL.createObjectURL(file);
  try {
    return await downscale(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function IconPicker(
  { current, onPick, onClose }: {
    current: string | null | undefined;
    onPick: (icon: string | null) => void;
    onClose: () => void;
  },
) {
  const [tab, setTab] = useState<"emoji" | "icons" | "upload">("emoji");
  const [value, setValue] = useState("");
  const [used, setUsed] = useState<string[] | null>(null);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pick = (icon: string | null) => {
    onPick(icon);
    onClose();
  };

  // the desktop webview cannot show <input type=file> dialogs (like window.open) —
  // route through the backend's native picker there; browsers use the input directly
  const upload = async () => {
    setUploadErr(null);
    const status = await getStatus().catch(() => null);
    if (!status?.desktop) {
      fileRef.current?.click();
      return;
    }
    const res = await fetch("/api/pick-image", { method: "POST" }).then((r) => r.json()).catch(() => null);
    if (res?.dataUri) pick(await dataUriToIcon(res.dataUri));
    else if (res?.error && !res.cancelled) setUploadErr(res.error);
  };

  useEffect(() => {
    if (tab === "icons" && used === null) listUdbIcons().then(setUsed).catch(() => setUsed([]));
  }, [tab, used]);

  // Ctrl+V anywhere in the picker: image data or an image link
  useEffect(() => {
    const h = async (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
      if (item) {
        e.preventDefault();
        const f = item.getAsFile();
        if (f) pick(await fileToIcon(f));
        return;
      }
      const text = e.clipboardData?.getData("text").trim() ?? "";
      if (/^(https?:|data:)/.test(text)) {
        e.preventDefault();
        pick(text);
      }
    };
    document.addEventListener("paste", h);
    return () => document.removeEventListener("paste", h);
  });

  const tabBtn = (t: typeof tab, label: string) => (
    <button
      className={`border-b-2 px-0.5 pb-1 text-[11.5px] transition-colors ${
        tab === t ? "border-ink font-medium text-ink" : "border-transparent text-ink-muted hover:text-ink-soft"
      }`}
      onClick={() => setTab(t)}
    >
      {label}
    </button>
  );

  return (
    <Popover onClose={onClose} className="w-[268px] p-2.5">
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline gap-3 border-b border-line pb-0">
          {tabBtn("emoji", "Emoji")}
          {tabBtn("icons", "Icons")}
          {tabBtn("upload", "Upload")}
          <span className="flex-1" />
          {current && (
            <button className="pb-1 text-[11.5px] text-ink-muted hover:text-blocked" onClick={() => pick(null)}>
              Remove
            </button>
          )}
        </div>

        {tab === "emoji" && (
          <>
            <div className="grid grid-cols-8 gap-0.5">
              {QUICK_ICONS.map((g) => (
                <button key={g} className="rounded p-1 text-[14px] leading-none hover:bg-panel" onClick={() => pick(g)}>
                  {g}
                </button>
              ))}
            </div>
            <input
              autoFocus
              className="w-full rounded-md border border-chipline bg-transparent px-2 py-1 text-xs text-ink outline-none placeholder:text-ink-muted/50 focus:border-copper/60"
              placeholder="any emoji — Enter to set"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && value.trim() && pick(value.trim())}
            />
          </>
        )}

        {tab === "icons" && (
          used === null
            ? <span className="py-2 text-[11px] text-ink-muted/60">loading…</span>
            : used.length === 0
            ? <span className="py-2 text-[11px] text-ink-muted/60">No uploaded icons yet — add one via Upload.</span>
            : (
              <div className="grid max-h-44 grid-cols-7 gap-1 overflow-y-auto">
                {used.map((icon) => (
                  <button
                    key={icon}
                    className="flex items-center justify-center rounded p-1 hover:bg-panel"
                    onClick={() => pick(icon)}
                  >
                    <img src={icon} alt="" className="h-5 w-5 rounded-[3px] object-contain" />
                  </button>
                ))}
              </div>
            )
        )}

        {tab === "upload" && (
          <div className="flex flex-col items-center gap-2 py-1.5">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) pick(await fileToIcon(f));
              }}
            />
            <button
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-chipline bg-panel px-3 py-2.5 text-xs text-ink-soft transition-colors hover:border-copper/50"
              onClick={upload}
            >
              🖼 Upload an image
            </button>
            <span className="text-[10.5px] text-ink-muted/70">or Ctrl+V to paste an image or link</span>
            {uploadErr && <span className="text-[10.5px] text-blocked">{uploadErr}</span>}
          </div>
        )}
      </div>
    </Popover>
  );
}

function TextCell({ value, mono, commit }: { value: string; mono?: boolean; commit: (v: unknown) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      className={`${cellInput} ${mono ? "font-mono text-[11px]" : ""}`}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && commit(v || null)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

function NumberCell({ value, cfg, commit }: { value: unknown; cfg: PropConfig; commit: (v: unknown) => void }) {
  const shown = value === null || value === undefined ? "" : String(value);
  const [v, setV] = useState(shown);
  const [editing, setEditing] = useState(false);
  useEffect(() => setV(shown), [shown]);
  if (!editing) {
    return (
      <button
        className={`${cellInput} text-right tabular-nums`}
        onClick={() => setEditing(true)}
      >
        {fmtNumber(value, cfg) || <span className="text-ink-muted/40">&nbsp;</span>}
      </button>
    );
  }
  return (
    <input
      autoFocus
      className={`${cellInput} text-right tabular-nums`}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (v === shown) return;
        const n = v.trim() === "" ? null : Number(v.replace(",", "."));
        if (n === null || !Number.isNaN(n)) commit(n);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

function CheckboxCell({ value, commit }: { value: unknown; commit: (v: unknown) => void }) {
  const on = value === true;
  return (
    <button
      className={`mx-1.5 my-1 flex h-4 w-4 items-center justify-center rounded border text-[10px] transition-colors ${
        on ? "border-copper bg-copper text-copper-ink" : "border-chipline text-transparent hover:border-copper/50"
      }`}
      onClick={() => commit(!on)}
    >
      ✓
    </button>
  );
}

function DateCell({ value, cfg, commit }: { value: unknown; cfg: PropConfig; commit: (v: unknown) => void }) {
  const d = (value ?? {}) as { start?: string; end?: string };
  const set = (patch: Partial<{ start: string; end: string }>) => {
    const next = { ...d, ...patch };
    if (!next.start && !next.end) return commit(null);
    commit(next);
  };
  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <div className="min-w-0 flex-1">
        <DateInput value={d.start ?? ""} onChange={(v) => set({ start: v })} />
      </div>
      {cfg.end && (
        <>
          <span className="text-[10px] text-ink-muted/50">→</span>
          <div className="min-w-0 flex-1">
            <DateInput value={d.end ?? ""} onChange={(v) => set({ end: v })} />
          </div>
        </>
      )}
    </div>
  );
}

function UrlCell({ value, commit }: { value: string; commit: (v: unknown) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <div className="group flex items-center">
      <input
        className={cellInput}
        value={v}
        placeholder=""
        onChange={(e) => setV(e.target.value)}
        onBlur={() => v !== value && commit(v || null)}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      {value && (
        <button
          className="px-1 text-[11px] text-ink-muted opacity-0 transition-opacity hover:text-copper group-hover:opacity-100"
          title="open in browser"
          onClick={() => openInBrowser(value)}
        >
          ↗
        </button>
      )}
    </div>
  );
}

function SelectCell(
  { prop, value, multi, commit, onPropChanged }: {
    prop: UdbProp;
    value: unknown;
    multi: boolean;
    commit: (v: unknown) => void;
    onPropChanged: () => void;
  },
) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const options = prop.config.options ?? [];
  const selected: string[] = multi
    ? (Array.isArray(value) ? value as string[] : [])
    : (typeof value === "string" && value ? [value] : []);
  const toggle = (id: string) => {
    if (multi) {
      const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
      commit(next.length ? next : null);
    } else {
      commit(selected.includes(id) ? null : id);
      setOpen(false);
    }
  };
  const createOption = async () => {
    const name = filter.trim();
    if (!name) return;
    const opt: SelectOption = {
      id: crypto.randomUUID().slice(0, 8),
      name,
      color: OPTION_COLORS[options.length % OPTION_COLORS.length],
    };
    await updateUdbProp(prop.id, { config: { options: [...options, opt] } });
    setFilter("");
    onPropChanged();
    toggle(opt.id);
  };
  const shown = options.filter((o) => o.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="relative">
      <button
        className="flex min-h-[26px] w-full flex-wrap items-center gap-1 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-panel/70"
        onClick={() => setOpen(true)}
      >
        {selected.map((id) => {
          const o = options.find((x) => x.id === id);
          return o ? <OptionChip key={id} opt={o} /> : null;
        })}
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)}>
          <input
            autoFocus
            className="mb-1 w-full rounded-md border border-chipline bg-transparent px-2 py-1 text-xs text-ink outline-none placeholder:text-ink-muted/50"
            placeholder={multi ? "filter or create…" : "filter…"}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !shown.length && createOption()}
          />
          <div className="flex max-h-52 flex-col overflow-y-auto">
            {shown.map((o) => (
              <button
                key={o.id}
                className="flex items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-panel"
                onClick={() => toggle(o.id)}
              >
                <OptionChip opt={o} />
                <span className="flex-1" />
                {selected.includes(o.id) && <span className="text-[10px] text-copper">✓</span>}
              </button>
            ))}
            {filter.trim() && !options.some((o) => o.name.toLowerCase() === filter.trim().toLowerCase()) && (
              <button className="rounded-md px-2 py-1 text-left text-xs text-ink-muted hover:bg-panel" onClick={createOption}>
                ＋ create “{filter.trim()}”
              </button>
            )}
            {!shown.length && !filter.trim() && <span className="px-2 py-1 text-[11px] text-ink-muted/60">no options yet — type to create</span>}
          </div>
        </Popover>
      )}
    </div>
  );
}

function RelationCell(
  { prop, row, onSaved }: { prop: UdbProp; row: UdbRow; onSaved: () => void },
) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [target, setTarget] = useState<Udb | null>(null);
  const chips: RelChip[] = row.relations[prop.id] ?? [];
  useEffect(() => {
    if (open && !target && prop.config.target_db) {
      getUdb(prop.config.target_db).then(setTarget).catch(() => {});
    }
  }, [open, target, prop.config.target_db]);
  const titleProp = target?.properties.find((p) => p.type === "title");
  const candidates = (target?.rows ?? [])
    .map((r) => ({ id: r.id, title: String(r.vals[titleProp?.id ?? ""] ?? "") }))
    .filter((r) => r.title.toLowerCase().includes(filter.toLowerCase()));
  const linked = new Set(chips.map((c) => c.id));
  const toggle = (id: string) => {
    setUdbLink(prop.id, row.id, id, linked.has(id)).then(onSaved);
  };
  return (
    <div className="relative">
      <button
        className="flex min-h-[26px] w-full flex-wrap items-center gap-1 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-panel/70"
        onClick={() => setOpen(true)}
      >
        {chips.map((c) => (
          <span
            key={c.id}
            className="max-w-full truncate rounded border border-chipline/60 px-1.5 py-0.5 text-[10.5px] leading-none text-ink-soft"
          >
            {c.title || "untitled"}
          </span>
        ))}
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)}>
          <input
            autoFocus
            className="mb-1 w-full rounded-md border border-chipline bg-transparent px-2 py-1 text-xs text-ink outline-none placeholder:text-ink-muted/50"
            placeholder="search rows…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="flex max-h-52 flex-col overflow-y-auto">
            {candidates.map((c) => (
              <button
                key={c.id}
                className="flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-ink-soft hover:bg-panel"
                onClick={() => toggle(c.id)}
              >
                <span className="flex-1 truncate">{c.title || "untitled"}</span>
                {linked.has(c.id) && <span className="text-[10px] text-copper">✓</span>}
              </button>
            ))}
            {!candidates.length && <span className="px-2 py-1 text-[11px] text-ink-muted/60">{target ? "no matches" : "loading…"}</span>}
          </div>
        </Popover>
      )}
    </div>
  );
}

export function DerivedCell({ value, cfg, kind }: { value: Derived; cfg: PropConfig; kind: "formula" | "rollup" }) {
  if (value !== null && typeof value === "object" && "error" in value) {
    return (
      <span className="px-1.5 py-1 text-[11px] text-blocked" title={value.error}>
        ! <span className="text-blocked/60">error</span>
      </span>
    );
  }
  const isNum = value !== null && value !== "" && !Number.isNaN(Number(value));
  return (
    <span
      className={`truncate px-1.5 py-1 text-xs tabular-nums text-ink-soft ${isNum ? "text-right" : ""}`}
      title={kind === "formula" ? cfg.expr : undefined}
    >
      {isNum ? fmtNumber(value, cfg) : String(value ?? "")}
    </span>
  );
}

export function Cell(
  { prop, row, onPatch, onSaved, onPropChanged }: {
    prop: UdbProp;
    row: UdbRow;
    onPatch: (propId: string, value: unknown) => void;
    onSaved: () => void;
    onPropChanged: () => void;
  },
) {
  const v = row.vals[prop.id];
  const commit = (value: unknown) => onPatch(prop.id, value);
  switch (prop.type) {
    case "title":
    case "text":
      return <TextCell value={typeof v === "string" ? v : ""} commit={commit} />;
    case "number":
      return <NumberCell value={v ?? null} cfg={prop.config} commit={commit} />;
    case "checkbox":
      return <CheckboxCell value={v} commit={commit} />;
    case "date":
      return <DateCell value={v} cfg={prop.config} commit={commit} />;
    case "url":
      return <UrlCell value={typeof v === "string" ? v : ""} commit={commit} />;
    case "select":
      return <SelectCell prop={prop} value={v} multi={false} commit={commit} onPropChanged={onPropChanged} />;
    case "multi_select":
      return <SelectCell prop={prop} value={v} multi commit={commit} onPropChanged={onPropChanged} />;
    case "relation":
      return <RelationCell prop={prop} row={row} onSaved={onSaved} />;
    case "formula":
    case "rollup":
      return <DerivedCell value={row.derived[prop.id] ?? null} cfg={prop.config} kind={prop.type} />;
    default:
      return null;
  }
}
