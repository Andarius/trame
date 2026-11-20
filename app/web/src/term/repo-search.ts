import type { BoardData } from "../api";

// every repo a card on the board points at, with the project of its latest card, most recent first
export function boardRepos(board: BoardData | null): Map<string, string | null> {
  const cards = [...(board?.sessions ?? [])].filter((s) => s.repo_path)
    .sort((a, b) => b.last_touched.localeCompare(a.last_touched));
  const out = new Map<string, string | null>();
  for (const s of cards) {
    const f = s.repo_path!.replace(/\/+$/, "");
    if (!out.has(f)) out.set(f, s.client_id ?? null);
  }
  return out;
}
// every word of the query appears in the path
export const matches = (path: string, query: string) =>
  query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => path.toLowerCase().includes(w));
