import type { Status } from "./api";

export const STATUS: Record<Status, { label: string; color: string }> = {
  active: { label: "Active", color: "var(--color-active)" },
  paused: { label: "Paused", color: "var(--color-paused)" },
  blocked: { label: "Blocked", color: "var(--color-blocked)" },
  done: { label: "Done", color: "var(--color-done)" },
};

export function StatusDot({ status, size = 8 }: { status: Status; size?: number }) {
  return (
    <span
      className="inline-block shrink-0 rounded-full"
      style={{ width: size, height: size, background: STATUS[status].color }}
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

export function ClientChip({ name, color }: { name: string; color?: string | null }) {
  const c = clientColor(name, color);
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[10px] font-medium leading-none"
      style={{ color: c, background: c + "24" }}
    >
      {name}
    </span>
  );
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

export function ObjectiveChip({ title }: { title: string }) {
  return (
    <span className="inline-flex w-fit items-center gap-1 rounded-md border border-chipline/60 px-1.5 py-0.5 text-[10.5px] leading-none text-ink-soft">
      <span className="text-[9px] text-ink-muted">◎</span>
      {title}
    </span>
  );
}
