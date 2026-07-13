import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import type { Status, StatusDef } from "./api";

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

const FALLBACK = ["#7a9ee7", "#b590e7", "#c98a63", "#7bd88f", "#e3c567"];
export function clientColor(name: string, color?: string | null): string {
  if (color) return color;
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  return FALLBACK[Math.abs(h) % FALLBACK.length];
}

export function ClientChip(
  { name, color, onClick }: { name: string; color?: string | null; onClick?: () => void },
) {
  const c = clientColor(name, color);
  const cls = "rounded px-1.5 py-0.5 text-[10px] font-medium leading-none";
  const style = { color: c, background: c + "24" };
  if (onClick) {
    return (
      <button
        type="button"
        className={`${cls} hover:brightness-125`}
        style={style}
        title={`Open ${name}`}
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
      className={`absolute left-0 top-full z-40 mt-1 min-w-[210px] rounded-lg border border-chipline bg-[#171923] p-1.5 shadow-2xl shadow-black/60 ${className ?? ""}`}
      style={style}
    >
      {children}
    </div>
  );
}

// Custom <select> replacement — native selects render with the platform theme (a light
// GTK dropdown in the desktop webview) and can't be styled.
export function Select(
  { value, options, onChange, placeholder, className }: {
    value: string;
    options: { value: string; label: string; dot?: string }[]; // dot = color swatch (project chips)
    onChange: (v: string) => void;
    placeholder?: string;
    className?: string; // trigger styling; defaults to the app's field look
  },
) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  const dot = (color?: string) =>
    color && <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: color }} />;
  return (
    <div className="relative">
      <button
        type="button"
        className={`flex w-full items-center gap-2 text-left ${
          className ??
          "rounded-md border border-chipline bg-transparent px-2 py-1.5 text-xs text-ink outline-none focus:border-copper/60"
        }`}
        onClick={() => setOpen(true)}
      >
        {dot(current?.dot)}
        <span className={`flex-1 truncate ${current ? "" : "text-ink-muted/60"}`}>
          {current?.label ?? placeholder ?? "—"}
        </span>
        <span className="text-[10px] text-ink-muted/70">▾</span>
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)} className="max-h-56 w-full overflow-y-auto">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-ink-soft hover:bg-panel"
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {dot(o.dot)}
              <span className="flex-1 truncate">{o.label}</span>
              {o.value === value && <span className="text-[10px] text-copper">✓</span>}
            </button>
          ))}
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
        className="flex w-[420px] flex-col gap-4 rounded-xl border border-[#323649] bg-[#171923] p-5 shadow-2xl shadow-black/50"
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

// Row/database icon: an emoji glyph, or an image when it looks like a URL / data URI.
export function EntityIcon(
  { icon, fallback, className }: { icon: string | null | undefined; fallback?: string; className?: string },
) {
  if (!icon) {
    return fallback ? <span className={className}>{fallback}</span> : null;
  }
  if (/^(https?:|data:)/.test(icon)) {
    return <img src={icon} alt="" className={`inline-block h-[15px] w-[15px] rounded-[3px] object-contain ${className ?? ""}`} />;
  }
  return <span className={className}>{icon}</span>;
}

export function ObjectiveChip(
  { title, onClick, active }: { title: string; onClick?: () => void; active?: boolean },
) {
  const cls = `inline-flex w-fit items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] leading-none ${
    active ? "border-copper/60 text-copper" : "border-chipline/60 text-ink-soft"
  } ${onClick ? "cursor-pointer hover:border-copper/50 hover:text-copper" : ""}`;
  const inner = (
    <>
      <span className={`text-[9px] ${active ? "text-copper" : "text-ink-muted"}`}>◇</span>
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

// Options for project/page pickers: projects (◎) first, then plain pages (□) which get
// promoted to projects when a session attaches. Duplicate titles are disambiguated with
// the parent page's title. Values are page ids.
export function pageOptions(
  objectives: { id: string; title: string }[],
  pages: { id: string; parent_id: string | null; kind: string; title: string }[],
): { value: string; label: string }[] {
  const titleCount = new Map<string, number>();
  for (const p of pages) titleCount.set(p.title, (titleCount.get(p.title) ?? 0) + 1);
  const byId = new Map(pages.map((p) => [p.id, p]));
  const disambig = (p: { parent_id: string | null; title: string }) => {
    const parent = p.parent_id ? byId.get(p.parent_id) : undefined;
    return (titleCount.get(p.title) ?? 0) > 1 && parent ? `${p.title} · ${parent.title}` : p.title;
  };
  return [
    ...objectives.map((o) => ({ value: o.id, label: `◇ ${o.title}` })),
    ...pages.filter((p) => p.kind === "page").map((p) => ({ value: p.id, label: `□ ${disambig(p)}` })),
  ];
}
