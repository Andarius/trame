// Marks a page carries in its block text (`{{trame:key=value}}`), read page-wide.
import { readMarks } from "./todo-marks.ts";

/** The first value `key` takes across a page's blocks, or null. */
export function markOfContent(content: unknown[], key: string): string | null {
  for (const b of content) {
    if (typeof b !== "object" || b === null) continue;
    const text = (b as { text?: unknown }).text;
    if (typeof text !== "string") continue;
    const ref = readMarks(text)[key];
    if (ref) return ref;
  }
  return null;
}
