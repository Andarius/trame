// POC: the desktop draws native terminal panes under the page; here we cut holes for them and report where.
import { termToken } from "./term-api";

export const NATIVE = !!(globalThis as { __trameNative?: boolean }).__trameNative;

const panes = new Map<string, HTMLElement>();
let bg = "";
let last = "";
let frame = 0;

const vw = () => [innerWidth, innerHeight] as const;
const box = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { x: Math.floor(r.left), y: Math.floor(r.top), w: Math.ceil(r.width), h: Math.ceil(r.height) };
};
let dim = 0;
// what the page floats over the panes (palette, menus, toasts): the desktop lets the page draw there
const covers = () => {
  dim = 0;
  const [W, H] = vw();
  const out: ReturnType<typeof box>[] = [];
  const add = (el: Element, depth: number) => {
    const b = box(el);
    const cs = getComputedStyle(el);
    if (b.w <= 0 || b.h <= 0 || cs.visibility === "hidden" || cs.opacity === "0") return;
    // a full-window backdrop: keep the terminal visible around its dialog
    if (b.w >= W - 2 && b.h >= H - 2 && depth < 3) {
      // the backdrop's darkening, which the desktop paints over the panes
      const a = cs.backgroundColor.match(/(?:,|\/)\s*([\d.]+)\)$/);
      if (a) dim = Math.max(dim, Number(a[1]));
      return [...el.children].forEach((c) => add(c, depth + 1));
    }
    out.push(b);
  };
  const root = document.getElementById("root");
  for (const el of document.body.children) if (el !== root && el.tagName !== "SCRIPT") add(el, 0);
  for (const el of document.querySelectorAll(".fixed, .absolute.z-50, [role=menu], [role=dialog], [role=tooltip]")) add(el, 0);
  return out;
};

const stats = ((globalThis as { __nativeTick?: { ms: number[] } }).__nativeTick = { ms: [] as number[] });
const tick = () => {
  frame = requestAnimationFrame(tick);
  const t0 = performance.now();
  try {
    measure();
  } finally {
    stats.ms.push(performance.now() - t0);
  }
};
const measure = () => {
  const list = [...panes].flatMap(([id, el]) => {
    if (!el.isConnected || !el.offsetParent || getComputedStyle(el).visibility !== "visible") return [];
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return [];
    return [{ id, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }];
  });
  const over = list.length ? covers() : [];
  const body = JSON.stringify({ panes: list, covers: over, dim, bg });
  if (body === last) return;
  last = body;
  void termToken().then((token) =>
    fetch("/api/term/native", { method: "POST", headers: { "x-trame-term": token, "content-type": "application/json" }, body })
  );
};

export function nativePane(id: string, el: HTMLElement) {
  if (!bg) bg = getComputedStyle(document.body).backgroundColor;
  panes.set(id, el);
  if (!frame) frame = requestAnimationFrame(tick);
  return () => {
    panes.delete(id);
  };
}

// image paths the native pane reports under the pointer, in window coordinates
export type NativeLink = { kind: "hover" | "open" | "leave"; path?: string; x: number; y: number };
const linkSubs = new Map<string, (e: NativeLink) => void>();
(globalThis as { __trameNativeLink?: unknown }).__trameNativeLink = (
  e: { id: string; kind: NativeLink["kind"]; path?: string; x?: number; y?: number },
) => {
  const r = panes.get(e.id)?.getBoundingClientRect();
  linkSubs.get(e.id)?.({ kind: e.kind, path: e.path, x: (r?.left ?? 0) + (e.x ?? 0), y: (r?.top ?? 0) + (e.y ?? 0) });
};

export function onNativeLink(id: string, f: (e: NativeLink) => void) {
  linkSubs.set(id, f);
  return () => void linkSubs.delete(id);
}
