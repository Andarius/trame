import type { PageBlock, PageEmbedBlock, PageFolderBlock } from "./page-markdown.ts";
import { isEmbedBlock, isFolderBlock } from "./page-markdown.ts";
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
// in document order. Non-text blocks (database/subpage/html/...) are never dropped:
// each re-attaches after the nearest preceding text block whose id survived (page
// head otherwise). Folder and embed blocks are the exception — the dialect can write them.
export function mergePageBlocks(
  existing: unknown[],
  next: PageBlock[],
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

  // A rewrite that carries a folder (or embed) line is authoritative for every block
  // of that type on the page; one that carries none leaves them all in place (older
  // writers, and partial rewrites, never expressed them). Ids are reused by path (url)
  // first, then in document order, so an edited path keeps its comments.
  type Keyed = PageFolderBlock | PageEmbedBlock;
  const keyOf = (b: Keyed) => b.type === "folder" ? b.path : b.url;
  const isKeyed = (b: unknown): b is Keyed => isFolderBlock(b) || isEmbedBlock(b);
  const rewrites = new Set(next.filter(isKeyed).map((b) => b.type));
  const keyed = existing.filter((b): b is Keyed => isKeyed(b) && typeof b.id === "string");
  const claimed = new Set<string>();
  const claim = (b: Keyed): string | null => {
    const free = (f: Keyed) => f.type === b.type && !claimed.has(f.id);
    const hit = keyed.find((f) => free(f) && keyOf(f) === keyOf(b)) ??
      keyed.find(free);
    if (!hit) return null;
    claimed.add(hit.id);
    return hit.id;
  };

  // next is authoritative for order, type, done, indent; ids and marks are reused
  const merged = next.map((b) => {
    if (isKeyed(b)) {
      const id = claim(b);
      return id ? { ...b, id } : b;
    }
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
    if (isKeyed(b) && rewrites.has(b.type)) continue;
    const g = groups.get(anchor);
    if (g) g.push(b);
    else groups.set(anchor, [b]);
  }

  const out: unknown[] = [...(groups.get(null) ?? [])];
  for (const b of merged) out.push(b, ...(groups.get(b.id) ?? []));
  return out;
}
