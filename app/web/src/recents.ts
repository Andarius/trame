import type { PageMeta } from "./api.ts";

export type RecentRow =
  | { kind: "page"; page: PageMeta }
  | { kind: "group"; parentId: string; pages: PageMeta[] };

// siblings touched this close together read as one bulk edit
const BULK_WINDOW_MS = 60_000;

/** Pages newest-first, same-parent bulk edits folded, one row per displayed page. */
export function recentRows(pages: PageMeta[]): RecentRow[] {
  const sorted = [...pages].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  const rows: RecentRow[] = [];
  const byShown = new Map<string, number>();
  const push = (row: RecentRow) => {
    const shown = row.kind === "page" ? row.page.id : row.parentId;
    const at = byShown.get(shown);
    if (at === undefined) return void (byShown.set(shown, rows.push(row) - 1));
    // a later burst under an already-listed page joins its row instead of repeating it
    const prev = rows[at];
    const pages = (r: RecentRow) => r.kind === "page" ? [r.page] : r.pages;
    rows[at] = { kind: "group", parentId: shown, pages: [...pages(prev), ...pages(row)] };
  };
  for (let i = 0; i < sorted.length;) {
    const head = sorted[i];
    let j = i + 1;
    while (
      head.parent_id && j < sorted.length && sorted[j].parent_id === head.parent_id &&
      Date.parse(head.updated_at) - Date.parse(sorted[j].updated_at) <= BULK_WINDOW_MS
    ) j++;
    push(
      j - i > 1 ? { kind: "group", parentId: head.parent_id!, pages: sorted.slice(i, j) } : { kind: "page", page: head },
    );
    i = j;
  }
  return rows;
}
