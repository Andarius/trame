import { useState } from "react";
import type { BoardData } from "../api";
import { TerminalIcon } from "../ui/icons";
import { MenuRow, Popover, SECTION_LABEL } from "../ui/ui";
import { openTerminal, pickTermFolder } from "./term-api";

// the project's folders: its cards' repos, most recently touched first
export function projectFolders(board: BoardData | null, project: string): string[] {
  const cards = (board?.sessions ?? [])
    .filter((s) => s.client_id === project && s.repo_path)
    .sort((a, b) => b.last_touched.localeCompare(a.last_touched));
  return [...new Set(cards.map((s) => s.repo_path!.replace(/\/+$/, "")))].slice(0, 8);
}

const short = (path: string) => path.split("/").slice(-2).join("/");

// Right-click menu on a project in the Terminals column: a new shell in one of its folders, or any folder.
export function ProjectTermMenu(
  { board, project, onClose, onOpened }: {
    board: BoardData | null;
    project: string;
    onClose: () => void;
    onOpened: () => void;
  },
) {
  const [error, setError] = useState<string | null>(null);
  const open = async (cwd: string) => {
    try {
      await openTerminal({ cwd, card: null });
      onOpened();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const other = async () => {
    const picked = await pickTermFolder().catch((e: Error) => ({ error: e.message }));
    if (typeof picked === "string") return open(picked.replace(/\/+$/, ""));
    if ("error" in picked) setError(picked.error);
  };
  const folders = projectFolders(board, project);
  return (
    <Popover portal onClose={onClose}>
      <div className={`px-2 pb-1 pt-0.5 ${SECTION_LABEL}`}>NEW TERMINAL IN</div>
      {folders.map((f) => (
        <MenuRow key={f} title={f} onClick={() => void open(f)}>
          <span className="text-ink-muted"><TerminalIcon /></span>
          <span className="min-w-0 flex-1 truncate">{short(f)}</span>
        </MenuRow>
      ))}
      {folders.length > 0 && <div className="my-1 h-px bg-line" />}
      <MenuRow onClick={() => void other()}>
        <span className="w-3.5 text-center text-ink-muted">…</span>
        <span className="flex-1">Other folder…</span>
      </MenuRow>
      {error && <p className="max-w-[240px] px-2 py-1 text-[11px] leading-snug text-blocked">{error}</p>}
    </Popover>
  );
}
