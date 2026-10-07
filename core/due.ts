import type { Ctx } from "./ctx.ts";
import { stripMarks } from "./todo-marks.ts";

// Open todos carrying a {{trame:due=YYYY-MM-DD}} mark, across every page. A spec
// page's todos point at their card, since spec pages are never shown on their own.

export type DueTodo = {
  page_id: string;
  page_title: string;
  block_id: string | null;
  card_id: string | null;
  text: string; // without its marks
  due: string; // YYYY-MM-DD
};

export async function listDue(ctx: Ctx): Promise<DueTodo[]> {
  const rows = (await ctx.q.query(
    `select p.id as page_id, p.title as page_title, b->>'id' as block_id, b->>'text' as text,
            substring(b->>'text' from '\\{\\{trame:due=([0-9]{4}-[0-9]{2}-[0-9]{2})\\}\\}') as due,
            (select s.id from sessions s where s.specs_page_id = p.id and not s.deleted limit 1) as card_id
       from pages p,
            jsonb_array_elements(case when jsonb_typeof(p.content) = 'array' then p.content else '[]' end) b
      where not p.deleted and b->>'type' = 'todo' and coalesce((b->>'done')::boolean, false) = false
        and b->>'text' like '%{{trame:due=%'`,
  )).rows as (Omit<DueTodo, "due" | "text"> & { text: string; due: string | null })[];
  return rows
    .filter((r): r is typeof r & { due: string } => r.due !== null)
    .map((r) => ({ ...r, text: stripMarks(r.text).trim() }))
    .sort((a, b) => a.due.localeCompare(b.due));
}

// days from `today` to `due` (negative = late), both YYYY-MM-DD
export function daysUntil(due: string, today: string): number {
  return Math.round((Date.parse(due) - Date.parse(today)) / 86_400_000);
}

// what the sidebar, the morning digest and the Claude band show: late, or due within a week
export const DUE_WINDOW_DAYS = 7;
export const isShownDue = (due: string, today: string) => daysUntil(due, today) <= DUE_WINDOW_DAYS;
