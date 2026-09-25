import type { PageMeta } from "./api.ts";

export type RecentRow =
  | { kind: "page"; page: PageMeta }
  | { kind: "group"; parentId: string; pages: PageMeta[] };

// siblings touched this close together read as one bulk edit
const BULK_WINDOW_MS = 60_000;

/** Pages newest-first, with consecutive same-parent bulk edits folded into one row. */
export function recentRows(pages: PageMeta[]): RecentRow[] {
  const sorted = [...pages].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  const rows: RecentRow[] = [];
  for (let i = 0; i < sorted.length;) {
    const head = sorted[i];
    let j = i + 1;
    while (
      head.parent_id && j < sorted.length && sorted[j].parent_id === head.parent_id &&
      Date.parse(head.updated_at) - Date.parse(sorted[j].updated_at) <= BULK_WINDOW_MS
    ) j++;
    rows.push(
      j - i > 1 ? { kind: "group", parentId: head.parent_id!, pages: sorted.slice(i, j) } : { kind: "page", page: head },
    );
    i = j;
  }
  return rows;
}
