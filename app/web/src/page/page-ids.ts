import type { Block } from "../api";

// Stable block id so a comment survives edits/reorders of the surrounding text.
export const genId = () => crypto.randomUUID().slice(0, 8);
const isTextType = (t: Block["type"]) =>
  t === "text" || t === "heading" || t === "todo";
// Backfill ids on text blocks that predate them; `changed` tells the caller to persist.
export function ensureIds(blocks: Block[]): { blocks: Block[]; changed: boolean } {
  let changed = false;
  const out = blocks.map((b) => {
    if (isTextType(b.type) && !("id" in b && b.id)) {
      changed = true;
      return { ...b, id: genId() } as Block;
    }
    return b;
  });
  return { blocks: out, changed };
}

// project chip palette (matches the client palette + a few extras)
export const PROJECT_COLORS = [
  "#7a9ee7",
  "#b590e7",
  "#c98a63",
  "#7bd88f",
  "#e3c567",
  "#e06c75",
  "#56b6c2",
  "#8b93a3",
];
