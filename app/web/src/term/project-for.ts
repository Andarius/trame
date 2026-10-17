import type { BoardData, Project } from "../api.ts";

// the project of the card working in this folder: the deepest repo match, then the latest card
export function projectFor(board: BoardData | null | undefined, cwd: string | undefined): Project | null {
  if (!board || !cwd) return null;
  let best: { depth: number; touched: string; client: string } | null = null;
  for (const s of board.sessions) {
    const repo = s.repo_path?.replace(/\/+$/, "");
    if (!repo || !s.client_id) continue;
    // a card in a worktree of this folder counts too: the folder is its repo
    const worktree = [`${cwd}/.claude/worktrees/`, `${cwd}/.worktrees/`].some((w) => repo.startsWith(w));
    const match = cwd === repo || cwd.startsWith(`${repo}/`) || worktree;
    if (!match) continue;
    const depth = cwd.startsWith(repo) ? repo.length : cwd.length;
    if (!best || depth > best.depth || (depth === best.depth && s.last_touched > best.touched)) {
      best = { depth, touched: s.last_touched, client: s.client_id };
    }
  }
  return board.projects.find((p) => p.id === best?.client) ?? null;
}
