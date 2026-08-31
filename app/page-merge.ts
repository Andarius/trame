import type { PageTextBlock } from "./page-markdown.ts";
import { carryMarks, stripMarks } from "./todo-marks.ts";

type AnyBlock = Record<string, unknown>;

const TEXT_TYPES = new Set(["text", "heading", "todo"]);

const isTextLike = (b: unknown): b is AnyBlock =>
  typeof b === "object" && b !== null &&
  TEXT_TYPES.has((b as AnyBlock).type as string);

// Replace a page's textual content with markdown-derived blocks, reusing the id of
// every block whose trimmed text is unchanged so attached comments stay anchored.
// Matching ignores block type and {{trame:...}} marks, so a rewrite that drops the
// marks still pairs up — and the surviving block keeps them. Duplicate texts pair
// in document order. Non-text blocks (database/subpage/folder/html/...) are never
// dropped: each re-attaches after the nearest preceding text block whose id
// survived (page head otherwise).
export function mergePageBlocks(
  existing: unknown[],
  next: PageTextBlock[],
): unknown[] {
  const pool = new Map<string, { id: string; text: string }[]>();
  for (const b of existing) {
    if (!isTextLike(b)) continue;
    if (typeof b.text !== "string" || typeof b.id !== "string") continue;
    const key = stripMarks(b.text).trim();
    const prev = pool.get(key);
    if (prev) prev.push({ id: b.id, text: b.text });
    else pool.set(key, [{ id: b.id, text: b.text }]);
  }

  // next is authoritative for order, type, done, indent; ids and marks are reused
  const merged = next.map((b) => {
    const prev = pool.get(stripMarks(b.text).trim())?.shift();
    return prev
      ? { ...b, id: prev.id, text: carryMarks(prev.text, b.text) }
      : b;
  });

  const survived = new Set(merged.map((b) => b.id));
  const groups = new Map<string | null, unknown[]>();
  let anchor: string | null = null;
  for (const b of existing) {
    if (isTextLike(b)) {
      if (typeof b.id === "string" && survived.has(b.id)) anchor = b.id;
      continue;
    }
    const g = groups.get(anchor);
    if (g) g.push(b);
    else groups.set(anchor, [b]);
  }

  const out: unknown[] = [...(groups.get(null) ?? [])];
  for (const b of merged) out.push(b, ...(groups.get(b.id) ?? []));
  return out;
}
