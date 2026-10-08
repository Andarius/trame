import { type ComponentProps, type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ancestry } from "./tree.ts";
import { listTags, type Status, type StatusDef, type Tag, tagRevision, TAGS_CHANGED } from "./api";

// expand / collapse (full-screen) glyph — inline SVG so it renders on WebKitGTK
export function ExpandIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      <path d={open ? "M2 6h4V2M14 6h-4V2M2 10h4v4M14 10h-4v4" : "M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4"} />
    </svg>
  );
}

type StatusStyle = { label: string; color: string; terminal: boolean };

// Runtime registry of the kanban statuses. Statuses are now user-defined and synced,
// so App refreshes this from board.statuses on every load (setStatuses). The seeded
// built-ins are the fallback until the first board arrives; an unknown key (e.g. a
// status a teammate defined but hasn't synced yet) degrades to a neutral grey chip.
export const STATUS: Record<string, StatusStyle> = {
  active: { label: "Active", color: "#7bd88f", terminal: false },
  paused: { label: "Paused", color: "#e3c567", terminal: false },
  blocked: { label: "Blocked", color: "#e06c75", terminal: false },
  done: { label: "Done", color: "#6b7280", terminal: true },
};

// order preserved so callers that iterate columns follow the board's sort_key order
export let STATUS_ORDER: string[] = ["active", "paused", "blocked", "done"];

export function setStatuses(list: StatusDef[]) {
  if (!list.length) return; // never blank the registry on an empty/failed load
  for (const k of Object.keys(STATUS)) delete STATUS[k];
  for (const s of list) STATUS[s.key] = { label: s.label, color: s.color, terminal: s.terminal };
  STATUS_ORDER = list.map((s) => s.key);
}

export const statusStyle = (status: Status): StatusStyle =>
  STATUS[status] ?? { label: status || "Unknown", color: "#6b7280", terminal: false };

export function StatusDot({ status, size = 8 }: { status: Status; size?: number }) {
  return (
    <span
      className="inline-block shrink-0 rounded-full"
      style={{ width: size, height: size, background: statusStyle(status).color }}
    />
  );
}

// hex (not hsl) — callers append an alpha suffix (`c + "24"`) for tinted chips
const hslHex = (h: number, s: number, l: number) => {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const v = l -
      s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
};
// 24 hue steps instead of a tiny palette, so two projects rarely collide
export function clientColor(name: string, color?: string | null): string {
  if (color) return color;
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  return hslHex((Math.abs(h) % 24) * 15, 0.55, 0.62);
}

export function ClientChip(
  { name, color, onClick, title, active }: {
    name: string;
    color?: string | null;
    onClick?: () => void;
    title?: string;
    active?: boolean;
  },
) {
  const c = clientColor(name, color);
  const cls = "rounded px-1.5 py-0.5 text-[10px] font-medium leading-none";
  const style = { color: c, background: c + "24" };
  if (onClick) {
    return (
      <button
        type="button"
        className={`${cls} hover:brightness-125 ${
          active ? "ring-1 ring-copper/70" : ""
        }`}
        style={style}
        title={title ?? `Open ${name}`}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
      >
        {name}
      </button>
    );
  }
  return <span className={cls} style={style}>{name}</span>;
}

export function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "now";
  const m = s / 60, h = m / 60, d = h / 24;
  if (m < 60) return `${m | 0}m ago`;
  if (h < 24) return `${h | 0}h ago`;
  if (d < 2) return "yesterday";
  if (d < 7) return `${d | 0}d ago`;
  return `${(d / 7) | 0}w ago`;
}

// uuidv7 ids embed their creation time (first 48 bits = unix ms); null for other versions
export function uuid7Time(id: string): Date | null {
  if (id[14] !== "7") return null;
  const ms = parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

// Shift-click range: ids between the last-clicked anchor and `id`, or null when
// there is no usable anchor (caller falls back to a single toggle).
export function shiftRange(ordered: string[], anchorId: string | null, id: string): string[] | null {
  const ai = anchorId ? ordered.indexOf(anchorId) : -1;
  const i = ordered.indexOf(id);
  if (ai < 0 || i < 0) return null;
  const [lo, hi] = ai < i ? [ai, i] : [i, ai];
  return ordered.slice(lo, hi + 1);
}

// Centered overlay panel: Escape or a backdrop click closes it, ⌘/Ctrl+Enter submits
// when the caller takes an action.
export function Modal(
  { width = 560, full = false, label, onClose, onSubmit, children }: {
    width?: number;
    label?: string; // accessible name of the dialog
    // covers the main area (sidebar stays), content in a centered column
    full?: boolean;
    onClose: () => void;
    onSubmit?: () => void;
    children: ReactNode;
  },
) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSubmit?.();
    };
    addEventListener("keydown", h);
    return () => removeEventListener("keydown", h);
  }, [onClose, onSubmit]);
  // portalled: a modal opened from inside the page editor must not sit under the
  // block's [data-block-id], or selecting its text offers a comment on that block
  if (full) {
    return createPortal(
      <div role="dialog" aria-label={label} className="absolute inset-0 z-40 overflow-y-auto bg-canvas">
        <div className="mx-auto flex max-w-[860px] flex-col gap-3 px-6 py-8">{children}</div>
      </div>,
      document.querySelector("main") ?? document.body,
    );
  }
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 pt-[16vh]" onClick={onClose}>
      <div
        className="flex max-h-[76vh] flex-col gap-3 overflow-y-auto rounded-xl border border-overlay-border bg-panel-modal p-5 shadow-2xl shadow-black/50"
        style={{ width }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

// Anchored popover. A stack tracks nesting so Escape / outside clicks only close the
// topmost one (e.g. a Select open inside the PropertyEditor).
const popoverStack: symbol[] = [];

export function Popover(
  { onClose, children, className, style }: {
    onClose: () => void;
    children: ReactNode;
    className?: string;
    style?: CSSProperties;
  },
) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const id = Symbol();
    popoverStack.push(id);
    const isTop = () => popoverStack[popoverStack.length - 1] === id;
    const h = (e: MouseEvent) => {
      if (isTop() && ref.current && !ref.current.contains(e.target as Node)) onCloseRef.current();
    };
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTop()) {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k, true);
    return () => {
      popoverStack.splice(popoverStack.indexOf(id), 1);
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", k, true);
    };
  }, []);
  return (
    <div
      ref={ref}
      className={`absolute left-0 top-full z-40 mt-1 min-w-[210px] rounded-lg border border-chipline bg-panel-modal p-1.5 shadow-2xl shadow-black/60 ${className ?? ""}`}
      style={style}
    >
      {children}
    </div>
  );
}

const MENU_MIN = 320; // width a searchable list needs: title + project pill

// Custom <select> replacement — native selects render with the platform theme (a light
// GTK dropdown in the desktop webview) and can't be styled.
export function Select(
  { value, options, onChange, placeholder, className, triggerStyle }: {
    value: string;
    // dot = color swatch, icon = logo/emoji (project chips), chip = the owning project's pill
    options: {
      value: string;
      label: string;
      dot?: string;
      icon?: string | null;
      chip?: { name: string; color?: string | null };
    }[];
    onChange: (v: string) => void;
    placeholder?: string;
    className?: string; // trigger styling; defaults to the app's field look
    triggerStyle?: CSSProperties; // dynamic colors (e.g. status pill tint)
  },
) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0); // keyboard-highlighted row in the filtered list
  const current = options.find((o) => o.value === value);
  const searchable = options.length > 8;
  const needle = q.trim().toLowerCase();
  const haystack = (o: { label: string; chip?: { name: string } }) =>
    (o.chip ? `${o.label} ${o.chip.name}` : o.label).toLowerCase();
  const shown = needle ? options.filter((o) => haystack(o).includes(needle)) : options;
  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };
  const dot = (color?: string) =>
    color && <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: color }} />;
  // one fixed-width slot for every row so logos, dots and markerless rows keep their labels aligned
  const slot = options.some((o) => o.icon) ? 15 : options.some((o) => o.dot) ? 7 : 0;
  const marker = (o?: { dot?: string; icon?: string | null }) =>
    slot === 0 ? null : (
      <span
        className="flex shrink-0 items-center justify-center"
        style={{ width: slot, height: slot }}
      >
        {o?.icon ? <EntityIcon icon={o.icon} className="text-[11px]" size={slot} /> : dot(o?.dot)}
      </span>
    );
  // a wide searchable list hangs off the right edge when the trigger sits there (drawer)
  const rect = open ? wrap.current?.getBoundingClientRect() : undefined;
  const flip = searchable && !!rect && rect.left + MENU_MIN > globalThis.innerWidth;
  return (
    <div className="relative" ref={wrap}>
      <button
        type="button"
        className={`flex w-full items-center gap-2 text-left ${
          className ??
          "rounded-md border border-chipline bg-transparent px-2 py-1.5 text-xs text-ink outline-none focus:border-copper/60"
        }`}
        style={triggerStyle}
        onClick={() => {
          setQ("");
          setHi(0);
          setOpen(true);
        }}
      >
        {marker(current)}
        <span className={`flex-1 truncate ${current ? "" : "text-ink-muted/60"}`}>
          {current?.label ?? placeholder ?? "—"}
        </span>
        <span className="text-[10px] text-ink-muted/70">▾</span>
      </button>
      {open && (
        <Popover
          onClose={() => setOpen(false)}
          className="w-full"
          style={{
            ...(searchable ? { minWidth: MENU_MIN } : {}),
            ...(flip ? { left: "auto", right: 0 } : {}),
          }}
        >
          {searchable && (
            <input
              autoFocus
              value={q}
              placeholder="Search…"
              className="mb-1 w-full rounded-md border border-chipline bg-transparent px-2 py-1 text-xs text-ink outline-none placeholder:text-ink-muted/60 focus:border-copper/60"
              onChange={(e) => {
                setQ(e.target.value);
                setHi(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const d = e.key === "ArrowDown" ? 1 : -1;
                  setHi((i) => Math.max(0, Math.min(shown.length - 1, i + d)));
                } else if (e.key === "Enter" && shown[hi]) {
                  e.preventDefault();
                  pick(shown[hi].value);
                }
              }}
            />
          )}
          <div className="max-h-56 overflow-y-auto">
            {shown.map((o, i) => (
              <MenuRow
                key={o.value}
                dense
                ref={searchable && i === hi ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                active={searchable && i === hi}
                className={searchable && i === hi ? "bg-copper/10" : ""}
                onMouseDown={(e) => e.preventDefault()} // keep focus in the search box
                onClick={() => pick(o.value)}
              >
                {marker(o)}
                <span className="flex-1 truncate">{o.label}</span>
                {o.chip && (
                  <span className="shrink-0">
                    <ClientChip name={o.chip.name} color={o.chip.color} />
                  </span>
                )}
                {o.value === value && <span className="text-[10px] text-copper">✓</span>}
              </MenuRow>
            ))}
            {!shown.length && <div className="px-2 py-1 text-xs text-ink-muted/70">No match</div>}
          </div>
        </Popover>
      )}
    </div>
  );
}

// Styled replacement for window.confirm() (native dialogs are GTK-themed in the
// desktop webview). Call `appConfirm(...)` anywhere; <ConfirmHost/> (mounted once in
// App) renders the modal. Enter confirms, Escape cancels.
type ConfirmReq = { message: string; action: string; resolve: (ok: boolean) => void };
let confirmHost: ((req: ConfirmReq) => void) | null = null;

export function appConfirm(message: string, action = "Delete"): Promise<boolean> {
  if (!confirmHost) return Promise.resolve(globalThis.confirm(message)); // host not mounted — fall back
  return new Promise((resolve) => confirmHost!({ message, action, resolve }));
}

export function ConfirmHost() {
  const [req, setReq] = useState<ConfirmReq | null>(null);
  useEffect(() => {
    confirmHost = setReq;
    return () => {
      confirmHost = null;
    };
  }, []);
  useEffect(() => {
    if (!req) return;
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "Enter") return;
      e.stopImmediatePropagation();
      req.resolve(e.key === "Enter");
      setReq(null);
    };
    document.addEventListener("keydown", h, true);
    return () => document.removeEventListener("keydown", h, true);
  }, [req]);
  if (!req) return null;
  const done = (ok: boolean) => {
    req.resolve(ok);
    setReq(null);
  };
  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/45 pt-[24vh]" onClick={() => done(false)}>
      <div
        className="flex w-[420px] flex-col gap-4 rounded-xl border border-overlay-border bg-panel-modal p-5 shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="m-0 whitespace-pre-line text-[13px] leading-relaxed text-ink">{req.message}</p>
        <div className="flex items-center justify-end gap-2">
          <button type="button" className="rounded-md px-2.5 py-1.5 text-xs text-ink-muted hover:text-ink-soft" onClick={() => done(false)}>
            Cancel
          </button>
          <button type="button"
            className="rounded-md bg-blocked px-3 py-1.5 text-[12.5px] font-medium text-[#1a0d0e] hover:brightness-110"
            onClick={() => done(true)}
          >
            {req.action}
          </button>
        </div>
      </div>
    </div>
  );
}

// Custom date input (native <input type=date> pops a platform calendar in the webview).
// Value is an ISO yyyy-mm-dd string or empty.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const iso = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

export function DateInput(
  { value, onChange, className, placeholder }: {
    value: string;
    onChange: (v: string) => void;
    className?: string;
    placeholder?: string;
  },
) {
  const [open, setOpen] = useState(false);
  const today = new Date();
  const base = /^\d{4}-\d{2}/.test(value) ? value : iso(today.getFullYear(), today.getMonth(), 1);
  const [view, setView] = useState({ y: Number(base.slice(0, 4)), m: Number(base.slice(5, 7)) - 1 });
  const openIt = () => {
    if (/^\d{4}-\d{2}/.test(value)) setView({ y: Number(value.slice(0, 4)), m: Number(value.slice(5, 7)) - 1 });
    setOpen(true);
  };
  const move = (d: number) => setView(({ y, m }) => ({ y: y + Math.floor((m + d) / 12), m: (((m + d) % 12) + 12) % 12 }));
  const first = new Date(view.y, view.m, 1);
  const startPad = (first.getDay() + 6) % 7; // Monday-first
  const daysIn = new Date(view.y, view.m + 1, 0).getDate();
  const todayIso = iso(today.getFullYear(), today.getMonth(), today.getDate());
  return (
    <div className="relative">
      <button
        type="button"
        className={`text-left tabular-nums ${
          className ?? "w-full rounded-md border border-transparent bg-transparent px-1.5 py-1 text-xs outline-none transition-colors hover:bg-panel/70"
        } ${value ? "text-ink" : "text-ink-muted/50"}`}
        onClick={openIt}
      >
        {value || placeholder || "—"}
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)} className="w-[228px] p-2">
          <div className="mb-1 flex items-center">
            <button type="button" className="rounded px-1.5 text-[12px] text-ink-muted hover:bg-panel hover:text-ink" onClick={() => move(-1)}>‹</button>
            <span className="flex-1 text-center text-[11.5px] font-medium text-ink">{MONTHS[view.m]} {view.y}</span>
            <button type="button" className="rounded px-1.5 text-[12px] text-ink-muted hover:bg-panel hover:text-ink" onClick={() => move(1)}>›</button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 text-center">
            {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
              <span key={i} className="py-0.5 text-[9px] text-ink-muted/60">{d}</span>
            ))}
            {Array.from({ length: startPad }, (_, i) => <span key={`p${i}`} />)}
            {Array.from({ length: daysIn }, (_, i) => {
              const day = iso(view.y, view.m, i + 1);
              const selected = day === value;
              return (
                <button type="button"
                  key={day}
                  className={`rounded py-0.5 text-[10.5px] tabular-nums transition-colors ${
                    selected
                      ? "bg-copper font-medium text-copper-ink"
                      : day === todayIso
                      ? "text-copper hover:bg-panel"
                      : "text-ink-soft hover:bg-panel"
                  }`}
                  onClick={() => {
                    onChange(day);
                    setOpen(false);
                  }}
                >
                  {i + 1}
                </button>
              );
            })}
          </div>
          <div className="mt-1 flex items-center border-t border-line pt-1.5">
            {value && (
              <button type="button"
                className="text-[10.5px] text-ink-muted hover:text-blocked"
                onClick={() => {
                  onChange("");
                  setOpen(false);
                }}
              >
                Clear
              </button>
            )}
            <span className="flex-1" />
            <button type="button"
              className="text-[10.5px] text-ink-muted hover:text-ink-soft"
              onClick={() => {
                onChange(todayIso);
                setOpen(false);
              }}
            >
              Today
            </button>
          </div>
        </Popover>
      )}
    </div>
  );
}

// Lucide icons for the default page glyphs, keyed by what pageGlyph returns; ticket/us tint over the row colour
const KIND_ICONS: Record<string, { tint?: string; paths: ReactNode }> = {
  ticket: {
    tint: "text-copper",
    paths: (
      <>
        <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
        <path d="M13 5v2" />
        <path d="M13 17v2" />
        <path d="M13 11v2" />
      </>
    ),
  },
  "◇": {
    tint: "text-active",
    paths: (
      <path d="M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z" />
    ),
  },
  "□": {
    paths: (
      <>
        <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
        <path d="M14 2v5a1 1 0 0 0 1 1h5" />
        <path d="M16 13H8" />
        <path d="M16 17H8" />
      </>
    ),
  },
};

function KindIcon({ glyph, className }: { glyph: string; className?: string }) {
  const k = KIND_ICONS[glyph];
  return (
    <span data-glyph={glyph} className={`inline-flex items-center self-center align-middle ${className ?? ""}`}>
      <svg width="1.15em" height="1.15em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={k.tint}
      >
        {k.paths}
      </svg>
    </span>
  );
}

// Row/database icon: an emoji glyph, or an image when it looks like a URL / data URI.
/** One label/value row of the card view's field grid (plugins add theirs through `CardFields`). */
export function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-3 py-1.5">
      <span className="text-[11.5px] text-ink-muted">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function EntityIcon(
  { icon, fallback, className, size }: {
    icon: string | null | undefined;
    fallback?: string;
    className?: string;
    size?: number; // px override for image icons (default 15)
  },
) {
  if (!icon || KIND_ICONS[icon]) {
    const k = icon || fallback;
    if (k && KIND_ICONS[k]) return <KindIcon glyph={k} className={className} />;
    return fallback ? <span className={className}>{fallback}</span> : null;
  }
  if (/^(https?:|data:)/.test(icon)) {
    return (
      <img
        src={icon}
        alt=""
        style={size ? { width: size, height: size } : undefined}
        className={`inline-block h-[15px] w-[15px] rounded-[3px] object-contain ${className ?? ""}`}
      />
    );
  }
  return <span className={className}>{icon}</span>;
}

export function ObjectiveChip(
  { title, onClick, active, glyph = "◇", icon }: {
    title: string;
    onClick?: () => void;
    active?: boolean;
    glyph?: string;
    icon?: string | null;
  },
) {
  const cls = `inline-flex w-fit items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] leading-none ${
    active ? "border-copper/60 text-copper" : "border-chipline/60 text-ink-soft"
  } ${onClick ? "cursor-pointer hover:border-copper/50 hover:text-copper" : ""}`;
  const inner = (
    <>
      <EntityIcon icon={icon} fallback={glyph} className={`text-[9px] ${active ? "text-copper" : "text-ink-muted"}`} />
      {title}
    </>
  );
  return onClick
    ? (
      <button type="button" className={cls} title={`Show only “${title}” sessions`}
        onClick={(e) => {
          e.stopPropagation(); // don't also open the card's drawer
          onClick();
        }}
      >
        {inner}
      </button>
    )
    : <span className={cls}>{inner}</span>;
}

// Options for story/page pickers: stories (◇) first, then plain pages (□) which get
// promoted to stories when a session attaches. Duplicate titles are disambiguated with
// the parent page's title. Values are page ids.
export function pageOptions(
  stories: { id: string; title: string }[],
  pages: {
    id: string;
    parent_id: string | null;
    kind: string;
    title: string;
    icon: string | null;
    color: string | null;
  }[],
): { value: string; label: string; icon: string; chip?: { name: string; color: string | null } }[] {
  const titleCount = new Map<string, number>();
  for (const p of pages) titleCount.set(p.title, (titleCount.get(p.title) ?? 0) + 1);
  const byId = new Map(pages.map((p) => [p.id, p]));
  const disambig = (p: { parent_id: string | null; title: string }) => {
    const parent = p.parent_id ? byId.get(p.parent_id) : undefined;
    return (titleCount.get(p.title) ?? 0) > 1 && parent ? `${p.title} · ${parent.title}` : p.title;
  };
  // the owning project as a colored pill — same-looking titles read apart at a glance
  const chipOf = (id: string) => {
    for (const p of ancestry(byId.get(id), byId)) {
      if (p.kind === "project") return { name: p.title, color: p.color };
    }
  };
  return [
    ...stories.map((o) => ({ value: o.id, label: o.title, icon: "◇", chip: chipOf(o.id) })),
    ...pages.filter((p) => p.kind === "page").map((p) => ({
      value: p.id,
      label: disambig(p),
      icon: "□",
      chip: chipOf(p.id),
    })),
  ];
}

// The session tree model: a session anchors to one page (page_id); story and project
// are DERIVED by walking ancestors up from the anchor. Filters use subtree semantics.
export {
  inSubtree,
  matchesSessionFilter,
  pagesById,
  projectOf,
  sessionAnchor,
  sessionTagKeys,
  storyOf,
} from "./tree.ts";
// ◎ project; a page whose marks give it a role (a mirrored ticket, a linked story) shows that role
export const pageGlyph = (kind: string, role?: string | null) =>
  kind === "project" ? "◎" : role === "ticket" ? "ticket" : kind === "story" || role === "linked-story" ? "◇" : "□";

// Share one vocabulary fetch across chips, refreshing after local tag edits.
// A label with a colon renders split, like the page-header editor: a dim `team`
// half and a coloured `devops` half, the namespace hue read from the row of the
// namespace itself. --tag-tint/--tag-shade follow the theme when defined.
let tagVocab: Promise<Tag[]> | null = null;
let tagVocabRevision = -1;
const tagSlug = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const tagTint = (color: string): CSSProperties => ({
  background: `color-mix(in srgb, ${color} var(--tag-tint, 16%), transparent)`,
  color: `color-mix(in srgb, ${color} calc(100% - var(--tag-shade, 30%)), var(--color-ink, currentColor))`,
});
// double-click opens: drop the word the double-click just selected, then open
export const dblOpen = (open: () => void) => () => {
  document.getSelection()?.removeAllRanges();
  open();
};

// rounded pill buttons, one per option, the current one tinted copper
export function SegToggle<T extends string>({ options, value, onChange }: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium transition-colors ${
            value === o.value ? "bg-copper/15 text-copper" : "text-ink-muted hover:bg-hover hover:text-ink-soft"
          }`}
        >
          {o.label}
        </button>
      ))}
    </>
  );
}

// uppercase section headings ("IN PROGRESS", "CARDS"); the small one labels fields
export const SECTION_LABEL = "text-[10.5px] font-medium tracking-[0.8px] text-ink-muted/70";
export const FIELD_LABEL = "text-[10px] font-medium tracking-[0.8px] text-ink-muted/70";

export function TagChips({ keys, onClick }: { keys?: string[]; onClick?: (key: string) => void }) {
  const [vocab, setVocab] = useState<Map<string, Tag> | null>(null);
  useEffect(() => {
    const refresh = () => {
      if (!tagVocab || tagVocabRevision !== tagRevision) {
        tagVocab = listTags();
        tagVocabRevision = tagRevision;
      }
      tagVocab.then((ts) => setVocab(new Map(ts.map((t) => [t.key, t]))))
        .catch(() => {});
    };
    refresh();
    addEventListener(TAGS_CHANGED, refresh);
    return () => removeEventListener(TAGS_CHANGED, refresh);
  }, []);
  if (!keys?.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {keys.map((k) => {
        const t = vocab?.get(k);
        const label = t?.label ?? k;
        const colon = label.indexOf(":");
        const ns = colon > 0 ? label.slice(0, colon) : null;
        const name = colon > 0 ? label.slice(colon + 1) : label;
        const nsRow = ns ? vocab?.get(tagSlug(ns)) : undefined;
        const Chip = onClick ? "button" : "span";
        return (
          <Chip
            key={k}
            type={onClick ? "button" : undefined}
            aria-label={onClick ? `Filter by tag ${label}` : undefined}
            onPointerDown={onClick ? (e) => e.stopPropagation() : undefined}
            onDoubleClick={onClick ? (e) => e.stopPropagation() : undefined}
            onClick={onClick ? (e) => { e.stopPropagation(); onClick(k); } : undefined}
            className="flex gap-1 rounded-full px-1.5 py-px text-[9.5px] font-medium leading-[14px]"
            style={tagTint(t?.color ?? nsRow?.color ?? "#6b7280")}
          >
            {ns && <span className="opacity-60">{ns}</span>}
            <span>{name}</span>
          </Chip>
        );
      })}
    </div>
  );
}

// ✕ / × close and remove buttons; tone sets the muted → hover colors, className the size and reveal
export function IconButton(
  { tone, className = "", ...props }: { tone?: "close" | "danger" } & ComponentProps<"button">,
) {
  const color = tone === "danger" ? "text-ink-muted hover:text-blocked" : tone === "close" ? "text-ink-muted hover:text-ink" : "";
  return <button type="button" {...props} className={`${color} ${className}`.trim() || undefined} />;
}

type Codec<T> = { parse: (raw: string) => T; stringify: (v: T) => string };
export const STRING_CODEC: Codec<string> = { parse: (r) => r, stringify: (v) => v };
export const BOOL_CODEC: Codec<boolean> = { parse: (r) => r === "1", stringify: (v) => (v ? "1" : "0") };
export const SET_CODEC: Codec<Set<string>> = {
  parse: (r) => new Set<string>(JSON.parse(r)),
  stringify: (v) => JSON.stringify([...v]),
};
// string enum: anything outside `opts` reads as the first option
export const enumCodec = <T extends string>(opts: readonly T[]): Codec<T> => ({
  parse: (r) => (opts as readonly string[]).includes(r) ? r as T : opts[0],
  stringify: (v) => v,
});

// useState persisted in localStorage; blocked storage or a bad value falls back to `init`
export function useLocalStorage<T>(key: string, init: T, codec: Codec<T>) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? init : codec.parse(raw);
    } catch {
      return init;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, codec.stringify(value));
    } catch { /* storage blocked */ }
  }, [key, value]);
  return [value, setValue] as const;
}

// className tokens that replace the matching MenuRow default instead of stacking on it
const MENU_SLOTS: [string, RegExp][] = [
  ["rounded", /^rounded/],
  ["gap", /^gap-/],
  ["px", /^px-/],
  ["items", /^items-/],
  ["size", /^text-(xs|\[\d)/],
  ["color", /^text-ink(-|$)/],
];

// full-width row of a popover menu; active reads as selected (ink text); className overrides rounded/gap/px/items/text size+color, the rest is appended
export function MenuRow(
  { dense, active, className = "", ...props }: { dense?: boolean; active?: boolean } & ComponentProps<"button">,
) {
  const slots: Record<string, string> = {
    rounded: "rounded-md", gap: "gap-2", px: "px-2", items: "items-center", size: "text-xs",
    color: active ? "text-ink" : "text-ink-soft",
  };
  const rest: string[] = [];
  for (const tok of className.split(/\s+/).filter(Boolean)) {
    const slot = MENU_SLOTS.find(([, re]) => re.test(tok));
    if (slot) slots[slot[0]] = tok;
    else rest.push(tok);
  }
  return (
    <button
      type="button"
      {...props}
      className={`flex w-full ${slots.items} ${slots.gap} ${slots.rounded} ${slots.px} ${dense ? "py-1" : "py-1.5"} text-left ${slots.size} hover:bg-panel ${slots.color} ${rest.join(" ")}`.trim()}
    />
  );
}

// the green "live" / "data" pill shared by the html and folder blocks
export const LIVE_PILL = "rounded-full border border-chip-active-border bg-chip-active-bg px-2 py-[1px] text-[10px] font-semibold text-active";

// live-agent status dot: working = live, waiting = wait, off = faint
export function PresenceDot({ state, className = "" }: { state: "working" | "waiting" | "off"; className?: string }) {
  const color = state === "working" ? "bg-live" : state === "waiting" ? "bg-wait" : "bg-ink-faint";
  return <span className={`h-1.5 w-1.5 rounded-full ${color} ${className}`.trim()} />;
}

// thin track with a filled share (0..1); className sets the track width, color the fill
export function ProgressBar({ value, color, className = "" }: { value: number; color: string; className?: string }) {
  return (
    <span className={`inline-block h-1 overflow-hidden rounded-full bg-line ${className}`.trim()}>
      <span className={`block h-full rounded-full ${color}`} style={{ width: `${value * 100}%` }} />
    </span>
  );
}

// muted one-line "nothing here" message
export function EmptyState({ children, className = "py-1" }: { children: ReactNode; className?: string }) {
  return <span className={`${className} text-[11px] text-ink-muted/60`}>{children}</span>;
}
