// What a page's marks mean to the hierarchy: rules read a role, never a mark name.
import { markOfContent } from "./content-marks.ts";

/** linked-story: the page stands for a tracker's story; ticket: a story page that mirrors a ticket. */
export type MarkRole = "linked-story" | "ticket";

// Cockpit's marks, built in so the hierarchy holds under existing data with no plugin installed
const RULES: { mark: string; value: RegExp; role: MarkRole }[] = [
  { mark: "cockpit_us", value: /^US-\d+$/, role: "linked-story" },
  { mark: "cockpit_ref", value: /^GEN-\d+$/, role: "ticket" },
];

// the icon's role: the mark's presence is enough, and a ticket wins over a linked story
const BY_ICON = RULES.toSorted((a, b) => Number(b.role === "ticket") - Number(a.role === "ticket"));

/** SQL twin of `markRoleOf` for page lists (`mark_role` column). */
export const MARK_ROLE_COL = `case ${
  BY_ICON.map((r) => `when content::text like '%trame:${r.mark}=%' then '${r.role}'`).join(" ")
} end as mark_role`;

/** The role a page's marks give it, for its icon. */
export const markRoleOf = (content: unknown[]): MarkRole | null =>
  BY_ICON.find((r) => markOfContent(content, r.mark))?.role ?? null;

export const hasRole = (content: unknown[], role: MarkRole): boolean =>
  RULES.some((r) => r.role === role && r.value.test(markOfContent(content, r.mark) ?? ""));
