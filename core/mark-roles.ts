// What a page's marks mean to the hierarchy: rules read a role, never a mark name.
import { markOfContent } from "./content-marks.ts";

/** linked-story: the page stands for a tracker's story; ticket: a story page that mirrors a ticket. */
export type MarkRole = "linked-story" | "ticket";

// Cockpit's marks, built in so the hierarchy holds under existing data with no plugin installed
const RULES: { mark: string; value: RegExp; role: MarkRole }[] = [
  { mark: "cockpit_us", value: /^US-\d+$/, role: "linked-story" },
  { mark: "cockpit_ref", value: /^GEN-\d+$/, role: "ticket" },
];

export const hasRole = (content: unknown[], role: MarkRole): boolean =>
  RULES.some((r) => r.role === role && r.value.test(markOfContent(content, r.mark) ?? ""));
