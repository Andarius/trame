import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { DateInput, EntityIcon, Popover } from "../ui";
import { Markdown } from "../md";
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

export const OPTION_COLORS = [
  "#7a9ee7",
  "#b590e7",
  "#c98a63",
  "#7bd88f",
  "#e3c567",
  "#e06c75",
  "#6b7280",
];

const cellInput =
  "w-full truncate rounded-md border border-transparent bg-transparent px-1.5 py-1 text-xs text-ink outline-none transition-colors hover:bg-panel/70 focus:border-chipline focus:bg-panel";

function fmtBare(v: unknown, cfg: PropConfig): string {
  if (v === null || v === undefined || v === "" || Number.isNaN(Number(v))) {
    return "";
  }
  const n = Number(v);
  return cfg.precision != null ? n.toFixed(cfg.precision) : String(n);
}

export function fmtNumber(v: unknown, cfg: PropConfig): string {
  const s = fmtBare(v, cfg);
  if (!s) return "";
  if (cfg.unit) return `${s} ${cfg.unit}`;
  if (cfg.format === "euro") return `${s} €`;
  if (cfg.format === "dollar") return `$${s}`;
  if (cfg.format === "percent") return `${s} %`;
  return s;
}

// Value-dependent color. "scale" interpolates a good→bad ramp over the column
// range (status tokens: active/paused/blocked); "rules" is a first-match ladder.
const RAMP = ["#7bd88f", "#e3c567", "#e06c75"] as const;

// Per-column min/max of the visible rows, provided by DatabaseTable for auto scale ranges.
export const ColumnRanges = createContext<
  Record<string, { min: number; max: number }>
>({});

// All properties of the table, provided by DatabaseTable — lets a cell resolve
// config that references sibling columns (e.g. unit_prop).
export const TableProps = createContext<UdbProp[]>([]);

// Per-row unit: the referenced select option's name, or the raw text value.
function rowUnit(
  cfg: PropConfig,
  row: UdbRow,
  props: UdbProp[],
): string | undefined {
  if (!cfg.unit_prop) return undefined;
  const p = props.find((x) => x.id === cfg.unit_prop);
  if (!p) return undefined;
  const raw = row.vals[p.id];
  if (p.type === "select") {
    return p.config.options?.find((o) => o.id === raw)?.name;
  }
  return typeof raw === "string" && raw ? raw : undefined;
}

function lerpHex(a: string, b: string, t: number): string {
  const c = (i: number) =>
    Math.round(
      parseInt(a.slice(i, i + 2), 16) * (1 - t) +
        parseInt(b.slice(i, i + 2), 16) * t,
    ).toString(16).padStart(2, "0");
  return `#${c(1)}${c(3)}${c(5)}`;
}

export function valueColor(
  v: number,
  cfg: PropConfig,
  range?: { min: number; max: number },
): string | null {
  const mode = cfg.color_mode ?? "fixed";
  if (mode === "fixed") return cfg.color ?? null;
  if (mode === "rules") {
    const rules = [...(cfg.rules ?? [])].sort((a, b) =>
      (a.lt ?? Infinity) - (b.lt ?? Infinity)
    );
    for (const r of rules) {
      if (r.lt === undefined || v < r.lt) return r.color;
    }
    return null;
  }
  const min = cfg.scale_min ?? range?.min ?? 0;
  const max = cfg.scale_max ?? range?.max ?? cfg.max ?? 100;
  if (max <= min) return RAMP[1];
  let t = Math.max(0, Math.min(1, (v - min) / (max - min)));
  if ((cfg.good ?? "low") === "high") t = 1 - t;
  return t < 0.5
    ? lerpHex(RAMP[0], RAMP[1], t * 2)
    : lerpHex(RAMP[1], RAMP[2], (t - 0.5) * 2);
}

// Background wash for color_apply="cell" — applied by the cell wrapper, not NumberViz.
export function cellWash(
  value: unknown,
  cfg: PropConfig,
  ranges: Record<string, { min: number; max: number }>,
  propId: string,
): string | undefined {
  if (cfg.color_apply !== "cell") return undefined;
  const n = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(n)) return undefined;
  const c = valueColor(n, cfg, ranges[propId]);
  return c ? c + "1c" : undefined;
}

// Notion-style "Show as": render a number as plain text, a progress bar, or a
// ring filled to value/max in the configured color. Falls back to plain text.
export function NumberViz(
  { value, cfg, propId }: { value: unknown; cfg: PropConfig; propId?: string },
) {
  const ranges = useContext(ColumnRanges);
  const label = fmtNumber(value, cfg);
  const has = value !== null && value !== undefined && value !== "" &&
    !Number.isNaN(Number(value));
  const showAs = cfg.show_as ?? "number";
  const vColor = has
    ? valueColor(Number(value), cfg, propId ? ranges[propId] : undefined)
    : null;
  if (showAs === "number" || !has) {
    if (!has) {
      return <>{label || <span className="text-ink-muted/40">&nbsp;</span>}</>;
    }
    const apply = cfg.color_apply ?? "none";
    const bare = fmtBare(value, cfg);
    const unit = cfg.unit
      ? <span className="ml-1 text-[10.5px] text-ink-muted">{cfg.unit}</span>
      : null;
    if (apply === "pill" && vColor) {
      return (
        <span
          className="inline-block rounded-full px-2 text-[11px] leading-[1.6]"
          style={{ color: vColor, background: vColor + "1f" }}
        >
          {label}
        </span>
      );
    }
    if (apply === "dot" && vColor) {
      return (
        <>
          <span
            className="mr-1.5 inline-block h-[7px] w-[7px] rounded-full align-[0.5px]"
            style={{ background: vColor }}
          />
          {bare}
          {unit}
        </>
      );
    }
    if (apply === "text" && vColor) {
      return (
        <>
          <span style={{ color: vColor }}>{bare}</span>
          {cfg.unit
            ? (
              <span className="ml-1 text-[10.5px]" style={{ color: vColor + "99" }}>
                {cfg.unit}
              </span>
            )
            : null}
        </>
      );
    }
    if (unit) return <>{bare}{unit}</>;
    return <>{label || <span className="text-ink-muted/40">&nbsp;</span>}</>;
  }
  const max = cfg.max && cfg.max > 0 ? cfg.max : 100;
  const frac = Math.max(0, Math.min(1, Number(value) / max));
  const color = vColor || "var(--color-copper)";
  const withValue = cfg.show_value !== false;
  if (showAs === "bar") {
    return (
      <span className="flex w-full items-center gap-1.5">
        <span className="relative h-1.5 min-w-6 flex-1 overflow-hidden rounded-full bg-line">
          <span
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ width: `${frac * 100}%`, background: color }}
          />
        </span>
        {withValue && (
          <span className="shrink-0 tabular-nums text-[11px] text-ink-soft">
            {label}
          </span>
        )}
      </span>
    );
  }
  const R = 7, C = 2 * Math.PI * R;
  return (
    <span className="flex items-center gap-1.5">
      <svg
        width="18"
        height="18"
        viewBox="0 0 18 18"
        className="-rotate-90 shrink-0"
      >
        <circle
          cx="9"
          cy="9"
          r={R}
          fill="none"
          stroke="var(--color-line)"
          strokeWidth="2.5"
        />
        <circle
          cx="9"
          cy="9"
          r={R}
          fill="none"
          stroke={color}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - frac)}
        />
      </svg>
      {withValue && (
        <span className="tabular-nums text-[11px] text-ink-soft">{label}</span>
      )}
    </span>
  );
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
  "🎯",
  "📊",
  "📈",
  "🧪",
  "🤖",
  "💡",
  "📚",
  "📣",
  "📡",
  "✍️",
  "💽",
  "🔥",
  "⭐",
  "✅",
  "❓",
  "🗂️",
  "🚀",
  "🧵",
  "🗄️",
  "🔑",
  "🧠",
  "📦",
  "🛠️",
  "🌍",
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

export async function dataUriToIcon(uri: string): Promise<string> {
  return uri.startsWith("data:image/svg") ? uri : await downscale(uri);
}

async function fileToIcon(file: File): Promise<string> {
  if (file.type === "image/svg+xml") {
    const text = await file.text();
    return `data:image/svg+xml;base64,${
      btoa(unescape(encodeURIComponent(text)))
    }`;
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
  const [tab, setTab] = useState<"emoji" | "library" | "icons" | "upload">(
    "emoji",
  );
  const [value, setValue] = useState("");
  const [used, setUsed] = useState<string[] | null>(null);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Lucide icon library — lazily imported (its own chunk) the first time the tab opens
  const [lib, setLib] = useState<Record<string, LucideIcon> | null>(null);
  const [q, setQ] = useState("");
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
    const res = await fetch("/api/pick-image", { method: "POST" }).then((r) =>
      r.json()
    ).catch(() => null);
    if (res?.dataUri) pick(await dataUriToIcon(res.dataUri));
    else if (res?.error && !res.cancelled) setUploadErr(res.error);
  };

  useEffect(() => {
    if (tab === "icons" && used === null) {
      listUdbIcons().then(setUsed).catch(() => setUsed([]));
    }
    if (tab === "library" && lib === null) {
      import("lucide-react").then((m) => setLib(m.icons)).catch(() =>
        setLib({})
      );
    }
  }, [tab, used, lib]);

  // A Lucide icon (stroke=currentColor) → a neutral-stroked SVG data-uri, so it
  // renders as an image via EntityIcon (offline, theme-independent — the stroke
  // is a fixed mid-grey rather than a theme token since a stored data-uri can't
  // react to a later theme change; picked to stay legible on both light and dark).
  const pickSvg = (svg: SVGSVGElement | null) => {
    if (!svg) return;
    const c = svg.cloneNode(true) as SVGSVGElement;
    c.setAttribute("stroke", "#8b93a3");
    c.removeAttribute("width");
    c.removeAttribute("height");
    const s = new XMLSerializer().serializeToString(c);
    pick(`data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(s)))}`);
  };

  // Ctrl+V anywhere in the picker: image data or an image link
  useEffect(() => {
    const h = async (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) =>
        i.type.startsWith("image/")
      );
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
      type="button"
      className={`border-b-2 px-0.5 pb-1 text-[11.5px] transition-colors ${
        tab === t
          ? "border-ink font-medium text-ink"
          : "border-transparent text-ink-muted hover:text-ink-soft"
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
          {tabBtn("library", "Icons")}
          {tabBtn("icons", "Recent")}
          {tabBtn("upload", "Upload")}
          <span className="flex-1" />
          {current && (
            <button
              type="button"
              className="pb-1 text-[11.5px] text-ink-muted hover:text-blocked"
              onClick={() => pick(null)}
            >
              Remove
            </button>
          )}
        </div>

        {tab === "emoji" && (
          <>
            <div className="grid grid-cols-8 gap-0.5">
              {QUICK_ICONS.map((g) => (
                <button
                  type="button"
                  key={g}
                  className="rounded p-1 text-[14px] leading-none hover:bg-panel"
                  onClick={() => pick(g)}
                >
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
              onKeyDown={(e) =>
                e.key === "Enter" && value.trim() && pick(value.trim())}
            />
          </>
        )}

        {tab === "library" && (
          <>
            <input
              autoFocus
              className="w-full rounded-md border border-chipline bg-transparent px-2 py-1 text-xs text-ink outline-none placeholder:text-ink-muted/50 focus:border-copper/60"
              placeholder="search icons…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {lib === null
              ? (
                <span className="py-2 text-[11px] text-ink-muted/60">
                  loading…
                </span>
              )
              : (() => {
                const needle = q.toLowerCase().replace(/\s+/g, "");
                const names = Object.keys(lib)
                  .filter((n) => n.toLowerCase().includes(needle))
                  .slice(0, 120);
                return (
                  <div className="grid max-h-44 grid-cols-7 gap-1 overflow-y-auto text-ink-soft">
                    {names.map((n) => {
                      const Icon = lib[n];
                      return (
                        <button
                          type="button"
                          key={n}
                          title={n}
                          className="flex items-center justify-center rounded p-1.5 hover:bg-panel"
                          onClick={(e) =>
                            pickSvg(e.currentTarget.querySelector("svg"))}
                        >
                          <Icon size={18} />
                        </button>
                      );
                    })}
                  </div>
                );
              })()}
          </>
        )}

        {tab === "icons" && (
          used === null
            ? (
              <span className="py-2 text-[11px] text-ink-muted/60">
                loading…
              </span>
            )
            : used.length === 0
            ? (
              <span className="py-2 text-[11px] text-ink-muted/60">
                No uploaded icons yet — add one via Upload.
              </span>
            )
            : (
              <div className="grid max-h-44 grid-cols-7 gap-1 overflow-y-auto">
                {used.map((icon) => (
                  <button
                    type="button"
                    key={icon}
                    className="flex items-center justify-center rounded p-1 hover:bg-panel"
                    onClick={() => pick(icon)}
                  >
                    <img
                      src={icon}
                      alt=""
                      className="h-5 w-5 rounded-[3px] object-contain"
                    />
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
              type="button"
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-chipline bg-panel px-3 py-2.5 text-xs text-ink-soft transition-colors hover:border-copper/50"
              onClick={upload}
            >
              🖼 Upload an image
            </button>
            <span className="text-[10.5px] text-ink-muted/70">
              or Ctrl+V to paste an image or link
            </span>
            {uploadErr && (
              <span className="text-[10.5px] text-blocked">{uploadErr}</span>
            )}
          </div>
        )}
      </div>
    </Popover>
  );
}

// Full-text modal for long text cells: markdown view, click to edit, Escape/✕ to close.
function TextModal(
  { value, title, mono, commit, onClose }: {
    value: string;
    title?: string;
    mono?: boolean;
    commit: (v: unknown) => void;
    onClose: () => void;
  },
) {
  const [v, setV] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    document.addEventListener("keydown", h, true);
    return () => document.removeEventListener("keydown", h, true);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/45 pt-[10vh]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[76vh] w-[640px] max-w-[92vw] flex-col rounded-xl border border-overlay-border bg-panel-modal shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line-soft px-4 py-2">
          <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-ink-soft">
            {title}
          </span>
          <span className="text-[10.5px] text-ink-muted/70">
            {editing ? "click outside the text to save" : "click text to edit"}
          </span>
          <button
            type="button"
            className="rounded px-1.5 text-[13px] leading-none text-ink-muted hover:bg-panel hover:text-ink"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {editing
            ? (
              <textarea
                autoFocus
                className={`field-sizing-content w-full resize-none whitespace-pre-wrap break-words rounded-md border border-chipline bg-panel px-2 py-1.5 text-xs leading-relaxed text-ink outline-none ${
                  mono ? "font-mono text-[11px]" : ""
                }`}
                rows={4}
                value={v}
                onChange={(e) => setV(e.target.value)}
                onBlur={() => {
                  setEditing(false);
                  if (v !== value) commit(v || null);
                }}
              />
            )
            : (
              <div
                className="cursor-text text-xs leading-relaxed text-ink"
                onClick={() => setEditing(true)}
              >
                {v
                  ? <Markdown text={v} />
                  : <span className="text-ink-muted/40">Empty</span>}
              </div>
            )}
        </div>
      </div>
    </div>
  );
}

function TextCell(
  { value, title, mono, commit, panel }: {
    value: string;
    title?: string;
    mono?: boolean;
    commit: (v: unknown) => void;
    panel?: boolean;
  },
) {
  const [v, setV] = useState(value);
  const [editing, setEditing] = useState(false);
  const [modal, setModal] = useState(false);
  useEffect(() => setV(value), [value]);
  // panel (row detail): render Markdown, click to edit into a growing textarea.
  // table: a single-line truncating input.
  if (panel) {
    if (editing) {
      return (
        <textarea
          autoFocus
          className={`field-sizing-content w-full resize-none whitespace-pre-wrap break-words rounded-md border border-chipline bg-panel px-1.5 py-1 text-xs leading-relaxed text-ink outline-none ${
            mono ? "font-mono text-[11px]" : ""
          }`}
          rows={1}
          value={v}
          onChange={(e) => setV(e.target.value)}
          onBlur={() => {
            setEditing(false);
            if (v !== value) commit(v || null);
          }}
        />
      );
    }
    return (
      <div
        className="min-h-[28px] cursor-text rounded-md border border-transparent px-1.5 py-1 text-xs text-ink transition-colors hover:bg-panel/50"
        title="click to edit"
        onClick={() => setEditing(true)}
      >
        {v
          ? <Markdown text={v} />
          : <span className="text-ink-muted/40">Empty</span>}
      </div>
    );
  }
  return (
    <div className="group flex items-center">
      <input
        className={`${cellInput} ${mono ? "font-mono text-[11px]" : ""}`}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => v !== value && commit(v || null)}
        onKeyDown={(e) =>
          e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      {value && (
        <button
          type="button"
          className="px-1 text-[11px] text-ink-muted opacity-0 transition-opacity hover:text-copper group-hover:opacity-100"
          title="open full text"
          onClick={() => setModal(true)}
        >
          ⤢
        </button>
      )}
      {modal && (
        <TextModal
          value={value}
          title={title}
          mono={mono}
          commit={commit}
          onClose={() => setModal(false)}
        />
      )}
    </div>
  );
}

function NumberCell(
  { value, cfg, propId, commit }: {
    value: unknown;
    cfg: PropConfig;
    propId: string;
    commit: (v: unknown) => void;
  },
) {
  const ranges = useContext(ColumnRanges);
  const shown = value === null || value === undefined ? "" : String(value);
  const [v, setV] = useState(shown);
  const [editing, setEditing] = useState(false);
  useEffect(() => setV(shown), [shown]);
  if (!editing) {
    const viz = cfg.show_as && cfg.show_as !== "number";
    return (
      <button
        type="button"
        className={`${cellInput} tabular-nums ${
          viz ? "text-left" : "text-right"
        }`}
        style={{ background: cellWash(value, cfg, ranges, propId) }}
        onClick={() => setEditing(true)}
      >
        <NumberViz value={value} cfg={cfg} propId={propId} />
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
      onKeyDown={(e) =>
        e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

function CheckboxCell(
  { value, commit }: { value: unknown; commit: (v: unknown) => void },
) {
  const on = value === true;
  return (
    <button
      type="button"
      className={`mx-1.5 my-1 flex h-4 w-4 items-center justify-center rounded border text-[10px] transition-colors ${
        on
          ? "border-copper bg-copper text-copper-ink"
          : "border-chipline text-transparent hover:border-copper/50"
      }`}
      onClick={() => commit(!on)}
    >
      ✓
    </button>
  );
}

function DateCell(
  { value, cfg, commit }: {
    value: unknown;
    cfg: PropConfig;
    commit: (v: unknown) => void;
  },
) {
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

function UrlCell(
  { value, commit }: { value: string; commit: (v: unknown) => void },
) {
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
        onKeyDown={(e) =>
          e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      {value && (
        <button
          type="button"
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
      const next = selected.includes(id)
        ? selected.filter((x) => x !== id)
        : [...selected, id];
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
  const shown = options.filter((o) =>
    o.name.toLowerCase().includes(filter.toLowerCase())
  );
  return (
    <div className="relative">
      <button
        type="button"
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
            onKeyDown={(e) =>
              e.key === "Enter" && !shown.length && createOption()}
          />
          <div className="flex max-h-52 flex-col overflow-y-auto">
            {shown.map((o) => (
              <button
                type="button"
                key={o.id}
                className="flex items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-panel"
                onClick={() => toggle(o.id)}
              >
                <OptionChip opt={o} />
                <span className="flex-1" />
                {selected.includes(o.id) && (
                  <span className="text-[10px] text-copper">✓</span>
                )}
              </button>
            ))}
            {filter.trim() && !options.some((o) =>
              o.name.toLowerCase() === filter.trim().toLowerCase()
            ) && (
              <button
                type="button"
                className="rounded-md px-2 py-1 text-left text-xs text-ink-muted hover:bg-panel"
                onClick={createOption}
              >
                ＋ create “{filter.trim()}”
              </button>
            )}
            {!shown.length && !filter.trim() && (
              <span className="px-2 py-1 text-[11px] text-ink-muted/60">
                no options yet — type to create
              </span>
            )}
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
    .map((r) => ({
      id: r.id,
      title: String(r.vals[titleProp?.id ?? ""] ?? ""),
      icon: r.icon,
    }))
    .filter((r) => r.title.toLowerCase().includes(filter.toLowerCase()));
  const linked = new Set(chips.map((c) => c.id));
  const toggle = (id: string) => {
    setUdbLink(prop.id, row.id, id, linked.has(id)).then(onSaved);
  };
  return (
    <div className="relative">
      <button
        type="button"
        className="flex min-h-[26px] w-full flex-wrap items-center gap-1 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-panel/70"
        onClick={() => setOpen(true)}
      >
        {chips.map((c) => (
          <span
            key={c.id}
            className="flex max-w-full items-center gap-1 truncate rounded border border-chipline/60 px-1.5 py-0.5 text-[10.5px] leading-none text-ink-soft"
          >
            {c.icon && (
              <EntityIcon icon={c.icon} className="shrink-0 text-[11px]" />
            )}
            <span className="truncate">{c.title || "untitled"}</span>
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
                type="button"
                key={c.id}
                className="flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-ink-soft hover:bg-panel"
                onClick={() => toggle(c.id)}
              >
                {c.icon && (
                  <EntityIcon icon={c.icon} className="shrink-0 text-[13px]" />
                )}
                <span className="flex-1 truncate">{c.title || "untitled"}</span>
                {linked.has(c.id) && (
                  <span className="text-[10px] text-copper">✓</span>
                )}
              </button>
            ))}
            {!candidates.length && (
              <span className="px-2 py-1 text-[11px] text-ink-muted/60">
                {target ? "no matches" : "loading…"}
              </span>
            )}
          </div>
        </Popover>
      )}
    </div>
  );
}

export function DerivedCell(
  { value, cfg, kind, propId, panel }: {
    value: Derived;
    cfg: PropConfig;
    kind: "formula" | "rollup";
    propId?: string;
    panel?: boolean;
  },
) {
  const ranges = useContext(ColumnRanges);
  if (value !== null && typeof value === "object" && "error" in value) {
    return (
      <span
        className="px-1.5 py-1 text-[11px] text-blocked"
        title={value.error}
      >
        ! <span className="text-blocked/60">error</span>
      </span>
    );
  }
  const isNum = value !== null && value !== "" && !Number.isNaN(Number(value));
  const viz = isNum && cfg.show_as && cfg.show_as !== "number";
  return (
    <span
      className={`block px-1.5 py-1 text-xs tabular-nums text-ink-soft ${
        isNum && !viz ? "text-right" : ""
      } ${panel ? "whitespace-pre-wrap break-words" : "truncate"}`}
      style={propId
        ? { background: cellWash(value, cfg, ranges, propId) }
        : undefined}
      title={kind === "formula" ? cfg.expr : undefined}
    >
      {isNum
        ? <NumberViz value={value} cfg={cfg} propId={propId} />
        : String(value ?? "")}
    </span>
  );
}

export function Cell(
  { prop, row, onPatch, onSaved, onPropChanged, panel }: {
    prop: UdbProp;
    row: UdbRow;
    onPatch: (propId: string, value: unknown) => void;
    onSaved: () => void;
    onPropChanged: () => void;
    panel?: boolean; // row-detail panel: text wraps to full multiline instead of truncating
  },
) {
  const allProps = useContext(TableProps);
  const v = row.vals[prop.id];
  const commit = (value: unknown) => onPatch(prop.id, value);
  switch (prop.type) {
    case "title":
    case "text":
      return (
        <TextCell
          value={typeof v === "string" ? v : ""}
          title={prop.name}
          commit={commit}
          panel={panel}
        />
      );
    case "number": {
      const unit = rowUnit(prop.config, row, allProps);
      return (
        <NumberCell
          value={v ?? null}
          cfg={unit ? { ...prop.config, unit } : prop.config}
          propId={prop.id}
          commit={commit}
        />
      );
    }
    case "checkbox":
      return <CheckboxCell value={v} commit={commit} />;
    case "date":
      return <DateCell value={v} cfg={prop.config} commit={commit} />;
    case "url":
      return <UrlCell value={typeof v === "string" ? v : ""} commit={commit} />;
    case "select":
      return (
        <SelectCell
          prop={prop}
          value={v}
          multi={false}
          commit={commit}
          onPropChanged={onPropChanged}
        />
      );
    case "multi_select":
      return (
        <SelectCell
          prop={prop}
          value={v}
          multi
          commit={commit}
          onPropChanged={onPropChanged}
        />
      );
    case "relation":
      return <RelationCell prop={prop} row={row} onSaved={onSaved} />;
    case "formula":
    case "rollup":
      return (
        <DerivedCell
          value={row.derived[prop.id] ?? null}
          cfg={prop.config}
          kind={prop.type}
          propId={prop.id}
          panel={panel}
        />
      );
    default:
      return null;
  }
}
