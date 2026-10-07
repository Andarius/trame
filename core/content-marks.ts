// Cockpit marks a page carries in its block text; the hierarchy rules read them too.
import { readMarks } from "./todo-marks.ts";

export const REF_MARK = "cockpit_ref";
/** A story filed as a user story carries this instead: it is a container, not a ticket mirror. */
export const US_MARK = "cockpit_us";

function markOfContent(content: unknown[], key: string): string | null {
  for (const b of content) {
    if (typeof b !== "object" || b === null) continue;
    const text = (b as { text?: unknown }).text;
    if (typeof text !== "string") continue;
    const ref = readMarks(text)[key];
    if (ref) return ref;
  }
  return null;
}

/** The ticket a mirrored page stands for, or null when it is not one of ours. */
export const refOfContent = (content: unknown[]): string | null =>
  markOfContent(content, REF_MARK);

/** The user story a story page was filed as, or null. */
export const usOfContent = (content: unknown[]): string | null =>
  markOfContent(content, US_MARK);

/** A line whose marks are Cockpit metadata: it is not empty, it just has nothing to show. */
export const hasCockpitMark = (text: string): boolean => {
  const m = readMarks(text);
  return REF_MARK in m || US_MARK in m;
};
