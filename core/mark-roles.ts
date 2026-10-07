// What a page's marks mean to the hierarchy: rules read a role, never a mark name.
import { markOfContent } from "./content-marks.ts";
import { LOCAL_MARK_ROLES } from "./mark-roles.gen.ts";

/** linked-story: the page stands for a tracker's story; ticket: a story page that mirrors a ticket. */
export type MarkRole = "linked-story" | "ticket";
export type MarkRule = { mark: string; value: RegExp; role: MarkRole };

// declared by plugins (mark-roles.json), inlined by scripts/gen-plugins.ts so the hub's core copy has them
const RULES: MarkRule[] = [...LOCAL_MARK_ROLES];

/** Adds rules at runtime; tests use it to pin the hierarchy without a plugin. */
export const addMarkRoles = (rules: MarkRule[]) => void RULES.push(...rules);

// the icon's role: the mark's presence is enough, and a ticket wins over a linked story
const byIcon = () => RULES.toSorted((a, b) => Number(b.role === "ticket") - Number(a.role === "ticket"));

/** SQL twin of `markRoleOf` for page lists (`mark_role` column). */
export const markRoleCol = () => {
  const whens = byIcon().map((r) => `when content::text like '%trame:${r.mark}=%' then '${r.role}'`);
  return whens.length ? `case ${whens.join(" ")} end as mark_role` : "null::text as mark_role";
};

/** The role a page's marks give it, for its icon. */
export const markRoleOf = (content: unknown[]): MarkRole | null =>
  byIcon().find((r) => markOfContent(content, r.mark))?.role ?? null;

export const hasRole = (content: unknown[], role: MarkRole): boolean =>
  RULES.some((r) => r.role === role && r.value.test(markOfContent(content, r.mark) ?? ""));
