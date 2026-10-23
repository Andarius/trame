// Jupyter-style command mode shared by a page's cells: which cell is selected, and moving focus.
import { useSyncExternalStore } from "react";

let selected: string | null = null;
const listeners = new Set<() => void>();

export function selectCell(id: string | null) {
  selected = id;
  for (const l of listeners) l();
  if (id) requestAnimationFrame(() => cellEl(id)?.focus({ preventScroll: false }));
}

/** Mark the cell current without moving focus (its editor just took it). */
export function markCell(id: string) {
  if (selected === id) return;
  selected = id;
  for (const l of listeners) l();
}

export function useSelectedCell(): string | null {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, () => selected);
}

const pageOrder = () => [...document.querySelectorAll<HTMLElement>("[data-cell-id]")].map((el) => el.dataset.cellId ?? "");
const cellEl = (id: string) => document.querySelector<HTMLElement>(`[data-cell-id="${CSS.escape(id)}"]`);

/** Edit mode: focus the cell's editor. */
export function editCell(id: string) {
  selected = id;
  for (const l of listeners) l();
  requestAnimationFrame(() => cellEl(id)?.querySelector<HTMLElement>(".cm-content")?.focus());
}

/** The cell id `step` cells away in page order, or null past either end. */
export function neighbourCell(id: string, step: number): string | null {
  const ids = pageOrder();
  const at = ids.indexOf(id);
  return at < 0 ? null : ids[at + step] ?? null;
}

// What the page toolbar can ask of each mounted cell.
type CellActions = { run: () => Promise<void>; clear: () => void };
const actions = new Map<string, CellActions>();

/** A cell offers its run/clear to the toolbar; returns the unregister. */
export function registerCell(id: string, a: CellActions) {
  actions.set(id, a);
  return () => {
    if (actions.get(id) === a) actions.delete(id);
  };
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

/** Runs every cell top to bottom, one at a time; `cancelled` stops between cells. */
export async function runAll(cancelled: () => boolean) {
  for (const id of pageOrder()) {
    if (cancelled()) return;
    await actions.get(id)?.run();
    await nextFrame(); // the cell's result patch re-renders the next cell's closure
  }
}

export async function clearAll() {
  for (const id of pageOrder()) {
    actions.get(id)?.clear();
    await nextFrame(); // each clear patches the page; the next must see it
  }
}
